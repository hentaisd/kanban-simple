/**
 * gitService.js - Integración Git con simple-git
 * Todas las operaciones fallan gracefully si no hay remote
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
  }

  /**
   * Verifica si el directorio es un repo git válido
   */
  async isGitRepo() {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Obtiene el branch actual
   */
  async getCurrentBranch() {
    const branch = await this.git.branch();
    return branch.current;
  }

  /**
   * Guarda los cambios pendientes con stash si los hay.
   * @returns {boolean} true si se hizo stash
   */
  async stashIfNeeded() {
    const status = await this.git.status();
    const dirty = status.modified.length + status.created.length +
                  status.deleted.length + status.staged.length +
                  status.not_added.length;
    if (dirty > 0) {
      console.log(chalk.gray(`  git stash push (${dirty} cambios pendientes antes del checkout)`));
      await this.git.stash(['push', '-m', 'kanban-pre-checkout']);
      this._stashed = true;
      return true;
    }
    this._stashed = false;
    return false;
  }

  /**
   * Restaura el stash si se hizo uno previamente con stashIfNeeded.
   * @returns {boolean} true si se restauró
   */
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

  /**
   * Checkout a un branch.
   * Si no existe localmente: intenta fetch+checkout desde remote.
   * Si tampoco existe en remote: lo crea nuevo desde HEAD actual.
   */
  async checkout(branch) {
    console.log(chalk.gray(`  git checkout ${branch}`));
    try {
      await this.git.checkout(branch);
    } catch (err) {
      if (err.message.includes('pathspec') || err.message.includes('did not match')) {
        // Intentar traer del remote
        try {
          console.log(chalk.gray(`  Branch '${branch}' no existe localmente — fetch desde origin...`));
          await this.git.fetch('origin', branch);
          await this.git.checkout(['-b', branch, `origin/${branch}`]);
        } catch {
          // No está en el remote tampoco — crear nuevo
          console.log(chalk.gray(`  Creando branch '${branch}' desde HEAD actual`));
          await this.git.checkoutLocalBranch(branch);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Pull del remote
   */
  async pull(remote = 'origin', branch = null) {
    try {
      const b = branch || await this.getCurrentBranch();
      console.log(chalk.gray(`  git pull ${remote} ${b}`));
      await this.git.pull(remote, b);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Pull falló (sin remote?): ${err.message}`));
    }
  }

  /**
   * Crea un nuevo branch y hace checkout
   */
  async createBranch(branchName) {
    console.log(chalk.gray(`  git checkout -b ${branchName}`));
    try {
      await this.git.checkoutLocalBranch(branchName);
    } catch (err) {
      // Si ya existe, hacer checkout
      if (err.message.includes('already exists')) {
        await this.git.checkout(branchName);
      } else {
        throw err;
      }
    }
  }

  /**
   * Elimina un branch local después del merge.
   * No falla si el branch no existe.
   */
  async deleteBranch(branchName) {
    try {
      console.log(chalk.gray(`  git branch -d ${branchName}`));
      await this.git.branch(['-d', branchName]);
      return true;
    } catch (err) {
      if (err.message.includes('not found') || err.message.includes('not fully merged')) {
        console.log(chalk.yellow(`  ⚠ No se pudo borrar branch ${branchName}: ${err.message}`));
      }
      return false;
    }
  }

  /**
   * Verifica que estamos en el branch esperado.
   * Si la IA cambió de branch, fuerza el checkout de vuelta.
   * @returns {{ ok: boolean, actual: string, restored: boolean }}
   */
  async ensureBranch(expectedBranch) {
    const actual = await this.getCurrentBranch();
    if (actual === expectedBranch) {
      return { ok: true, actual, restored: false };
    }
    console.log(chalk.yellow(`  ⚠ Branch inesperado: estamos en '${actual}' pero debería ser '${expectedBranch}'`));
    try {
      // Guardar cambios uncommitted antes de cambiar
      const status = await this.git.status();
      const dirty = status.modified.length + status.created.length +
                    status.deleted.length + status.not_added.length;
      if (dirty > 0) {
        console.log(chalk.yellow(`  ⚠ Hay ${dirty} cambios sin commit — haciendo commit de rescate`));
        await this.git.add('.');
        await this.git.commit(`wip: cambios de IA en branch ${actual}`);
        console.log(chalk.gray(`  git commit (rescate de cambios en '${actual}')`));
      }
      await this.git.checkout(expectedBranch);
      // Traer los cambios que la IA hizo en el branch incorrecto
      if (dirty > 0 && actual !== expectedBranch) {
        try {
          console.log(chalk.gray(`  git merge ${actual} (recuperando trabajo de la IA)`));
          await this.git.merge([actual]);
        } catch (mergeErr) {
          console.log(chalk.yellow(`  ⚠ No se pudo merge '${actual}' → '${expectedBranch}': ${mergeErr.message}`));
        }
      }
      console.log(chalk.cyan(`  ▶ Branch restaurado a '${expectedBranch}'`));
      return { ok: false, actual, restored: true };
    } catch (err) {
      console.log(chalk.red(`  ✖ No se pudo restaurar branch a '${expectedBranch}': ${err.message}`));
      return { ok: false, actual, restored: false };
    }
  }

  /**
   * Stage todos los cambios
   */
  async addAll() {
    console.log(chalk.gray('  git add .'));
    await this.git.add('.');
  }

  /**
   * Commit con mensaje
   */
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

  /**
   * Push al remote
   */
  async push(branch, remote = 'origin') {
    try {
      console.log(chalk.gray(`  git push ${remote} ${branch}`));
      await this.git.push(remote, branch, ['--set-upstream']);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Push falló (sin remote?): ${err.message}`));
    }
  }

  /**
   * Merge de un branch al branch actual
   */
  async merge(branchName) {
    console.log(chalk.gray(`  git merge ${branchName}`));
    await this.git.merge([branchName]);
  }

  /**
   * Obtiene el estado actual del repo
   */
  async getStatus() {
    return await this.git.status();
  }

  /**
   * Rollback seguro: stash de cambios + checkout al branch principal.
   * No elimina el branch de tarea.
   * @param {string} defaultBranch - Branch al que volver (default: 'main')
   */
  async rollback(defaultBranch = 'main') {
    console.log(chalk.yellow('  ⚠ Rollback: guardando cambios con stash...'));
    try {
      await this.git.stash(['push', '-m', 'kanban-rollback']);
    } catch {
      // Si no hay nada que hacer stash, continuar
    }
    console.log(chalk.yellow(`  ⚠ Rollback: volviendo a ${defaultBranch}`));
    await this.git.checkout(defaultBranch);
  }

  /**
   * Retorna el diff entre el branch principal y el branch de la tarea.
   * @param {string} branch - Branch de la tarea
   * @param {string} defaultBranch - Branch principal
   * @returns {string} - Output del diff
   */
  async getDiff(branch, defaultBranch = 'main') {
    try {
      const result = await this.git.diff([`${defaultBranch}...${branch}`]);
      return result || '';
    } catch (err) {
      return `Error obteniendo diff: ${err.message}`;
    }
  }
}

module.exports = GitService;
