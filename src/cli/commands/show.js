/**
 * show.js - Mostrar detalle de una tarea
 */

const chalk = require('chalk');
const { getTaskById } = require('../../kanban/board');

function showCommand(id) {
  const found = getTaskById(id);

  if (!found) {
    console.error(chalk.red(`❌ Tarea ${id} no encontrada\n`));
    process.exit(1);
  }

  const { task } = found;

  console.log(chalk.blue.bold(`\n📄 Tarea ${task.id}\n`));
  console.log(chalk.white(`Título:    `) + chalk.cyan.bold(task.title));
  console.log(chalk.white(`Tipo:      `) + chalk.yellow(task.type));
  console.log(chalk.white(`Prioridad: `) + chalk.yellow(task.priority));
  console.log(chalk.white(`Estado:    `) + chalk.green(task.status || task.column));
  console.log(chalk.white(`Branch:    `) + chalk.gray(task.branch));
  if (task.labels && task.labels.length > 0) {
    console.log(chalk.white(`Labels:    `) + task.labels.map(l => chalk.magenta(l)).join(', '));
  }
  console.log('');
  console.log(chalk.gray('─'.repeat(50)));
  console.log(task.content || chalk.gray('(sin descripción)'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log('');
}

module.exports = { showCommand };
