/**
 * gitService.js - Integración Git con simple-git
 *
 * Maneja el ciclo git completo por tarea:
 *   prepare()  → stash + checkout base + create task branch
 *   finalize() → add + commit + merge + cleanup (solo si éxito)
 *   abort()    → descartar cambios + cleanup + volver a base
 *   verify()   → verificar que el repo está limpio para la siguiente tarea
 */

const simpleGit = require('simple-git');
const path = require('path');
const chalk = require('chalk');

const PROJECT_ROOT = path.resolve(__dirname, '../../');

class GitService {
  constructor(repoPath = PROJECT_ROOT) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
    this.defaultBranch = 'main';
    this._stashed = false;
    this._taskBranch = null; // branch activo de la tarea actual
  }

  // ── BASIC OPERATIONS ──────────────────────────────────────

  async isGitRepo() {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch() {
    const branch = await this.git.branch();
    return branch.current;
  }

  async getStatus() {
    return await this.git.status();
  }

  /**
   * Cuenta archivos con cambios (staged + unstaged + untracked)
   */
  async getDirtyCount() {
    const s = await this.git.status();
    return s.modified.length + s.created.length + s.deleted.length +
           s.staged.length + s.not_added.length + s.renamed.length;
  }

  // ── STASH ─────────────────────────────────────────────────

  async stashIfNeeded() {
    const dirty = await this.getDirtyCount();
    if (dirty > 0) {
      console.log(chalk.gray(`  git stash push (${dirty} cambios pendientes)`));
      await this.git.stash(['push', '-u', '-m', 'kanban-pre-checkout']);
      this._stashed = true;
      return true;
    }
    this._stashed = false;
    return false;
  }

  async popStashIfNeeded() {
    if (!this._stashed) return false;
    try {
      const list = await this.git.stash(['list']);
      if (list && list.includes('kanban-pre-checkout')) {
        console.log(chalk.gray('  git stash pop (restaurando cambios previos)'));
        await this.git.stash(['pop']);
        this._stashed = false;
        return true;
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ stash pop falló: ${err.message}`));
    }
    this._stashed = false;
    return false;
  }

  // ── CHECKOUT / BRANCH ─────────────────────────────────────

  async checkout(branch) {
    console.log(chalk.gray(`  git checkout ${branch}`));
    try {
      await this.git.checkout(branch);
    } catch (err) {
      if (err.message.includes('pathspec') || err.message.includes('did not match')) {
        try {
          console.log(chalk.gray(`  Branch '${branch}' no existe localmente — fetch desde origin...`));
          await this.git.fetch('origin', branch);
          await this.git.checkout(['-b', branch, `origin/${branch}`]);
        } catch {
          console.log(chalk.gray(`  Creando branch '${branch}' desde HEAD actual`));
          await this.git.checkoutLocalBranch(branch);
        }
      } else {
        throw err;
      }
    }
  }

  async createBranch(branchName) {
    console.log(chalk.gray(`  git checkout -b ${branchName}`));
    try {
      await this.git.checkoutLocalBranch(branchName);
    } catch (err) {
      if (err.message.includes('already exists')) {
        // Branch ya existe — borrar y recrear desde base
        console.log(chalk.yellow(`  ⚠ Branch '${branchName}' ya existe — recreando`));
        await this.git.branch(['-D', branchName]);
        await this.git.checkoutLocalBranch(branchName);
      } else {
        throw err;
      }
    }
    this._taskBranch = branchName;
  }

  /**
   * Borra un branch local (force). No falla si no existe.
   */
  async deleteBranch(branchName, force = false) {
    try {
      const flag = force ? '-D' : '-d';
      console.log(chalk.gray(`  git branch ${flag} ${branchName}`));
      await this.git.branch([flag, branchName]);
      return true;
    } catch (err) {
      // Ignorar si no existe
      if (!err.message.includes('not found')) {
        console.log(chalk.yellow(`  ⚠ No se pudo borrar branch '${branchName}': ${err.message}`));
      }
      return false;
    }
  }

  // ── COMMIT / PUSH ─────────────────────────────────────────

  async addAll() {
    console.log(chalk.gray('  git add .'));
    await this.git.add('.');
  }

  async commit(message) {
    console.log(chalk.gray(`  git commit -m "${message}"`));
    try {
      const result = await this.git.commit(message);
      return result;
    } catch (err) {
      if (err.message.includes('nothing to commit')) {
        console.log(chalk.gray('  (nothing to commit)'));
        return null;
      }
      throw err;
    }
  }

  async push(branch, remote = 'origin') {
    try {
      console.log(chalk.gray(`  git push ${remote} ${branch}`));
      await this.git.push(remote, branch, ['--set-upstream']);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Push falló: ${err.message}`));
    }
  }

  // ── MERGE con manejo de conflictos ────────────────────────

  /**
   * Merge de un branch al branch actual.
   * Si hay conflictos, aborta el merge y lanza error.
   * @returns {{ merged: boolean, summary: string }}
   */
  async merge(branchName) {
    console.log(chalk.gray(`  git merge ${branchName}`));
    try {
      const result = await this.git.merge([branchName]);
      return { merged: true, summary: result?.summary || 'OK' };
    } catch (err) {
      // Detectar conflicto de merge
      if (err.message.includes('CONFLICT') || err.message.includes('conflict') ||
          err.message.includes('Automatic merge failed')) {
        console.log(chalk.red(`  ✖ Conflicto de merge detectado — abortando`));
        try {
          await this.git.merge(['--abort']);
          console.log(chalk.yellow('  git merge --abort OK'));
        } catch (abortErr) {
          console.log(chalk.red(`  ✖ merge --abort falló: ${abortErr.message}`));
          // Último recurso: reset
          await this.hardReset();
        }
        throw new Error(`Merge conflict: ${branchName} → ${await this.getCurrentBranch()}`);
      }
      throw err;
    }
  }

  // ── DIFF ──────────────────────────────────────────────────

  async getDiff(branch, defaultBranch = 'main') {
    try {
      const result = await this.git.diff([`${defaultBranch}...${branch}`]);
      return result || '';
    } catch (err) {
      return `Error obteniendo diff: ${err.message}`;
    }
  }

  async pull(remote = 'origin', branch = null) {
    try {
      const b = branch || await this.getCurrentBranch();
      console.log(chalk.gray(`  git pull ${remote} ${b}`));
      await this.git.pull(remote, b);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Pull falló: ${err.message}`));
    }
  }

  // ── ENSURE BRANCH (post-IA check) ─────────────────────────

  /**
   * Verifica que estamos en el branch esperado después de que la IA terminó.
   * Si la IA cambió de branch, rescata cambios y vuelve al correcto.
   */
  async ensureBranch(expectedBranch) {
    const actual = await this.getCurrentBranch();
    if (actual === expectedBranch) {
      return { ok: true, actual, restored: false };
    }
    console.log(chalk.yellow(`  ⚠ Branch inesperado: '${actual}' (esperado: '${expectedBranch}')`));
    try {
      const dirty = await this.getDirtyCount();
      if (dirty > 0) {
        console.log(chalk.yellow(`  ⚠ ${dirty} cambios sin commit — commit de rescate en '${actual}'`));
        await this.git.add('.');
        await this.git.commit(`wip: cambios de IA en branch ${actual}`);
      }
      await this.git.checkout(expectedBranch);
      // Recuperar trabajo de la IA del branch incorrecto
      if (dirty > 0 && actual !== expectedBranch) {
        try {
          await this.git.merge([actual, '--no-edit']);
          console.log(chalk.gray(`  Trabajo de '${actual}' mergeado a '${expectedBranch}'`));
        } catch {
          // Conflicto al mergear — abortar y continuar sin esos cambios
          try { await this.git.merge(['--abort']); } catch {}
          console.log(chalk.yellow(`  ⚠ No se pudo mergear trabajo de '${actual}' — continuando sin él`));
        }
      }
      return { ok: false, actual, restored: true };
    } catch (err) {
      console.log(chalk.red(`  ✖ No se pudo restaurar a '${expectedBranch}': ${err.message}`));
      return { ok: false, actual, restored: false };
    }
  }

  // ── OPERACIONES DE ALTO NIVEL ─────────────────────────────

  /**
   * Hard reset del working directory. Último recurso.
   * Descarta TODOS los cambios uncommitted.
   */
  async hardReset() {
    console.log(chalk.red('  git reset --hard HEAD (descartando todos los cambios)'));
    await this.git.reset(['--hard', 'HEAD']);
    await this.git.clean('f', ['-d']); // limpiar untracked
  }

  /**
   * Aborta la tarea: descarta todo y vuelve a la branch base.
   * Limpia: branch de tarea, stashes de rollback, archivos sucios.
   *
   * @param {string} defaultBranch - Branch base (developer, main, etc.)
   * @param {string} taskBranch - Branch de la tarea a limpiar
   */
  async abort(defaultBranch, taskBranch) {
    const branch = taskBranch || this._taskBranch;

    // 1. Abortar merge en progreso si hay
    try {
      const s = await this.git.status();
      if (s.conflicted.length > 0) {
        await this.git.merge(['--abort']);
        console.log(chalk.yellow('  git merge --abort (conflicto pendiente limpiado)'));
      }
    } catch {}

    // 2. Descartar cambios uncommitted
    const dirty = await this.getDirtyCount();
    if (dirty > 0) {
      await this.hardReset();
    }

    // 3. Volver a branch base
    const current = await this.getCurrentBranch();
    if (current !== defaultBranch) {
      try {
        await this.git.checkout(defaultBranch);
        console.log(chalk.gray(`  Checkout a ${defaultBranch}`));
      } catch {
        // Si checkout falla (working dir sucio), force
        await this.hardReset();
        await this.git.checkout(defaultBranch);
      }
    }

    // 4. Borrar branch de tarea (force)
    if (branch && branch !== defaultBranch) {
      await this.deleteBranch(branch, true);
    }

    // 5. Limpiar stashes de rollback acumulados
    await this.cleanKanbanStashes();

    // 6. Confirmar estado final
    const finalBranch = await this.getCurrentBranch();
    const finalDirty = await this.getDirtyCount();
    console.log(chalk.gray(`  [abort] Branch: ${finalBranch}, Dirty: ${finalDirty}`));

    this._taskBranch = null;
  }

  /**
   * Verifica que el repo está en estado limpio y en el branch correcto.
   * Si no, intenta corregirlo.
   * @returns {{ clean: boolean, branch: string, fixed: boolean }}
   */
  async verify(expectedBranch) {
    const branch = await this.getCurrentBranch();
    const dirty = await this.getDirtyCount();
    let fixed = false;

    // Check conflictos pendientes
    const status = await this.git.status();
    if (status.conflicted.length > 0) {
      console.log(chalk.red(`  ✖ ${status.conflicted.length} archivo(s) en conflicto — abortando merge`));
      try { await this.git.merge(['--abort']); } catch {}
      await this.hardReset();
      fixed = true;
    }

    // Check dirty
    if (dirty > 0) {
      console.log(chalk.yellow(`  ⚠ ${dirty} archivos sucios — limpiando`));
      await this.hardReset();
      fixed = true;
    }

    // Check branch
    const currentBranch = await this.getCurrentBranch();
    if (currentBranch !== expectedBranch) {
      console.log(chalk.yellow(`  ⚠ En '${currentBranch}' (esperado: '${expectedBranch}') — corrigiendo`));
      try {
        await this.git.checkout(expectedBranch);
      } catch {
        await this.hardReset();
        await this.git.checkout(expectedBranch);
      }
      fixed = true;
    }

    const finalDirty = await this.getDirtyCount();
    const finalBranch = await this.getCurrentBranch();
    return {
      clean: finalDirty === 0 && finalBranch === expectedBranch,
      branch: finalBranch,
      dirty: finalDirty,
      fixed,
    };
  }

  /**
   * Elimina todos los stashes creados por kanban (rollback y pre-checkout)
   */
  async cleanKanbanStashes() {
    try {
      const list = await this.git.stash(['list']);
      if (!list) return;
      const lines = list.split('\n').filter(Boolean);
      // Borrar de abajo hacia arriba para no desplazar índices
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('kanban-rollback') || lines[i].includes('kanban-pre-checkout')) {
          try {
            await this.git.stash(['drop', `stash@{${i}}`]);
            console.log(chalk.gray(`  Stash ${i} limpiado (kanban)`));
          } catch {}
        }
      }
    } catch {}
  }
}

module.exports = GitService;
