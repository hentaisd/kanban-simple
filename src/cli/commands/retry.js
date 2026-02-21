const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { moveTask, getTasks } = require('../../kanban/board');
const { getKanbanPath } = require('../../core/task');

const KANBAN_ROOT = path.resolve(__dirname, '../../../');
const ACTIVE_PROJECT_FILE = path.join(KANBAN_ROOT, 'kanban', '.active-project.json');
const PROJECTS_FILE = path.join(KANBAN_ROOT, 'kanban', 'projects.json');

function getActiveKanbanPath() {
  try {
    if (fs.existsSync(ACTIVE_PROJECT_FILE)) {
      const { name } = JSON.parse(fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8'));
      if (name && fs.existsSync(PROJECTS_FILE)) {
        const list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        const project = list.find(p => p.name === name);
        if (project?.path) return getKanbanPath(project.path);
      }
    }
  } catch {}
  return undefined;
}

function retryCommand(id) {
  console.log(chalk.blue(`\n🔄 Reintentando tarea ${chalk.cyan(id)}...\n`));

  try {
    const kanbanPath = getActiveKanbanPath();
    const result = moveTask(id, 'todo', kanbanPath);
    
    console.log(chalk.green(`✅ Tarea ${chalk.cyan(id)} movida:`));
    console.log(chalk.gray(`   ${result.fromColumn} → todo`));
    console.log(chalk.gray(`   Lista para ser procesada nuevamente\n`));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}\n`));
    process.exit(1);
  }
}

function unstuckCommand(options) {
  const kanbanPath = options.project ? getKanbanPath(options.project) : getActiveKanbanPath();
  
  console.log(chalk.blue.bold('\n🔍 Buscando tareas atascadas...\n'));

  const inProgress = getTasks('in_progress', kanbanPath);
  const review = getTasks('review', kanbanPath);

  let fixed = 0;

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
  for (const task of inProgress) {
    const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
    
    if (startedAt && startedAt < oneHourAgo) {
      console.log(chalk.yellow(`  ⚠ [${task.id}] ${task.title} - en progreso por más de 1 hora`));
      
      if (!options.dryRun) {
        moveTask(task.id, 'review', kanbanPath);
        console.log(chalk.green(`     → Movida a REVIEW`));
      } else {
        console.log(chalk.gray(`     → (dry-run) Se movería a REVIEW`));
      }
      fixed++;
    }
  }

  if (review.length > 0) {
    console.log(chalk.yellow(`\n📋 Tareas en REVIEW (${review.length}):`));
    for (const task of review) {
      const retryCount = task.retryCount || 0;
      const lastError = task.lastError || 'Sin info';
      console.log(chalk.gray(`  [${task.id}] ${task.title}`));
      console.log(chalk.gray(`      Reintentos: ${retryCount} | Error: ${lastError.slice(0, 50)}...`));
      
      if (options.all && !options.dryRun) {
        moveTask(task.id, 'todo', kanbanPath);
        console.log(chalk.green(`     → Movida a TODO`));
        fixed++;
      }
    }
  }

  if (fixed === 0 && inProgress.length === 0 && review.length === 0) {
    console.log(chalk.green('✅ No hay tareas atascadas\n'));
  } else if (fixed === 0) {
    console.log(chalk.green('\n✅ No se encontraron tareas atascadas (en progreso > 1 hora)\n'));
  } else {
    console.log(chalk.green(`\n✅ ${fixed} tarea(s) arregladas\n`));
  }

  if (review.length > 0 && !options.all) {
    console.log(chalk.cyan('💡 Usa --all para mover todas las tareas de REVIEW a TODO'));
    console.log(chalk.cyan('💡 O usa: ai-kanban retry <id> para una tarea específica\n'));
  }
}

module.exports = { retryCommand, unstuckCommand };
