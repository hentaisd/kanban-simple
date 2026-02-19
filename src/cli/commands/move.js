/**
 * move.js - Comando para mover tareas entre columnas
 */

const chalk = require('chalk');
const { moveTask } = require('../../kanban/board');

function moveCommand(id, column) {
  console.log(chalk.blue(`\n🚀 Moviendo tarea ${chalk.cyan(id)} → ${chalk.yellow(column)}...\n`));

  try {
    const result = moveTask(id, column);

    if (result.message) {
      console.log(chalk.yellow(`ℹ ${result.message}`));
    } else {
      console.log(chalk.green(`✅ Tarea ${chalk.cyan(id)} movida:`));
      console.log(chalk.gray(`   ${result.fromColumn} → ${result.toColumn}`));
      console.log(chalk.gray(`   Archivo: ${result.filePath}`));
    }
    console.log('');
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}\n`));
    process.exit(1);
  }
}

module.exports = { moveCommand };
