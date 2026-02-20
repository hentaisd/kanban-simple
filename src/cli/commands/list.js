/**
 * list.js - Comando para listar tareas en terminal
 */

const chalk = require('chalk');
const { getTasks, getTasksFromColumn } = require('../../kanban/board');
const { COLUMNS } = require('../../core/task');

const TYPE_COLORS = {
  feature: chalk.blue,
  fix: chalk.yellow,
  bug: chalk.red,
};

const PRIORITY_COLORS = {
  alta: chalk.red,
  media: chalk.yellow,
  baja: chalk.green,
};

const COLUMN_COLORS = {
  backlog: chalk.gray,
  todo: chalk.cyan,
  in_progress: chalk.blue,
  review: chalk.yellow,
  done: chalk.green,
};

function formatTask(task, showErrors = false) {
  const typeColor = TYPE_COLORS[task.type] || chalk.white;
  const priorityColor = PRIORITY_COLORS[task.priority] || chalk.white;
  const labels = task.labels && task.labels.length > 0
    ? ` [${task.labels.map(l => chalk.magenta(l)).join(', ')}]`
    : '';
  
  let errorIndicator = '';
  if (showErrors && task.lastError && task.status === 'review') {
    const truncatedError = task.lastError.length > 40 
      ? task.lastError.substring(0, 40) + '...' 
      : task.lastError;
    errorIndicator = chalk.red(`\n       ⚠️ ${truncatedError}`);
  }

  return [
    `  ${chalk.cyan(task.id.toString().padStart(3, '0'))}`,
    typeColor(`[${(task.type || 'feature').padEnd(7)}]`),
    priorityColor(`[${(task.priority || 'media').padEnd(5)}]`),
    chalk.white(task.title),
    labels,
    errorIndicator,
  ].join(' ');
}

function printColumn(column, tasks, labelFilter) {
  const filtered = labelFilter
    ? tasks.filter(t => t.labels && t.labels.includes(labelFilter))
    : tasks;

  const colColor = COLUMN_COLORS[column] || chalk.white;
  const colName = column.toUpperCase().replace('_', ' ');

  console.log(colColor.bold(`\n┌─ ${colName} (${filtered.length}) ─────────────────────`));

  if (filtered.length === 0) {
    console.log(chalk.gray('   (vacío)'));
  } else {
    const showErrors = column === 'review';
    filtered.forEach(task => console.log(formatTask(task, showErrors)));
  }
}

function listCommand(column, options) {
  const { json, label } = options;

  // Si pide una columna específica
  if (column && column !== 'all' && COLUMNS.includes(column)) {
    const tasks = getTasksFromColumn(column);

    if (json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    printColumn(column, tasks, label);
    console.log('');
    return;
  }

  // Mostrar todas las columnas
  const allTasks = getTasks();

  if (json) {
    console.log(JSON.stringify(allTasks, null, 2));
    return;
  }

  console.log(chalk.blue.bold('\n📋 AI-Kanban - Tablero de Tareas\n'));

  let total = 0;
  for (const col of COLUMNS) {
    const tasks = allTasks[col] || [];
    printColumn(col, tasks, label);
    total += tasks.length;
  }

  console.log(chalk.gray(`\n  Total: ${total} tarea(s)\n`));
}

module.exports = { listCommand };
