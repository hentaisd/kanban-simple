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
   * Checkout a un branch existente
   */
  async checkout(branch) {
    console.log(chalk.gray(`  git checkout ${branch}`));
    await this.git.checkout(branch);
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
   * Ejecuta el flujo completo de git para una tarea
   * 1. checkout develop/main
   * 2. pull
   * 3. crear branch
   * 4. (ejecutar cambios - externo)
   * 5. add + commit + push
   * 6. checkout develop
   * 7. merge
   */
  async executeTaskFlow(task, executeChanges) {
    const { type, title, branch, id } = task;

    console.log(chalk.blue('\n  📦 Git Workflow:'));

    // 1. Checkout branch principal
    try {
      await this.checkout(this.defaultBranch);
      await this.pull();
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ No se pudo hacer checkout a ${this.defaultBranch}: ${err.message}`));
    }

    // 2. Crear branch de tarea
    await this.createBranch(branch);

    // 3. Ejecutar cambios (función externa)
    if (executeChanges) {
      console.log(chalk.blue('\n  ⚙ Ejecutando cambios...'));
      await executeChanges();
    }

    // 4. Commit
    const prefix = type === 'feature' ? 'feat' : type === 'fix' ? 'fix' : 'bug';
    const commitMsg = `${prefix}(${id}): ${title}`;

    await this.addAll();
    await this.commit(commitMsg);

    // 5. Push
    await this.push(branch);

    // 6. Volver a main y merge
    try {
      await this.checkout(this.defaultBranch);
      await this.merge(branch);

      const mergeCommitMsg = `merge(${id}): ${title} completada`;
      await this.addAll();
      await this.commit(mergeCommitMsg);
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Merge falló: ${err.message}`));
    }

    console.log(chalk.green(`\n  ✅ Git workflow completado para tarea ${id}`));
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
