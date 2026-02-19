/**
 * delete.js - Eliminar una tarea
 */

const chalk = require('chalk');
const inquirer = require('inquirer');
const { getTaskById, deleteTask } = require('../../kanban/board');

async function deleteCommand(id) {
  const found = getTaskById(id);

  if (!found) {
    console.error(chalk.red(`❌ Tarea ${id} no encontrada\n`));
    process.exit(1);
  }

  const { task } = found;

  console.log(chalk.yellow(`\n⚠  Vas a eliminar la tarea ${chalk.cyan(task.id)}: "${task.title}"\n`));

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: '¿Estás seguro?',
    default: false,
  }]);

  if (!confirm) {
    console.log(chalk.gray('Cancelado.\n'));
    return;
  }

  deleteTask(id);
  console.log(chalk.green(`✅ Tarea ${id} eliminada.\n`));
}

module.exports = { deleteCommand };
