#!/usr/bin/env node
/**
 * ai-kanban CLI - Interfaz de línea de comandos principal
 * Comandos: create, list, move, start, board
 */

const { program } = require('commander');
const chalk = require('chalk');
const path = require('path');

// Definir versión y descripción
program
  .name('ai-kanban')
  .description('Sistema de automatización de desarrollo con Kanban visual e IA')
  .version('1.0.0');

// ─────────────────────────────────────────────
// COMANDO: init
// ─────────────────────────────────────────────
program
  .command('init')
  .description('Configurar el sistema: proyecto target, engine (claude/opencode), git')
  .action(async () => {
    const { initCommand } = require('./commands/init');
    await initCommand();
  });

// ─────────────────────────────────────────────
// COMANDO: create
// ─────────────────────────────────────────────
program
  .command('create [freeText]')
  .description('Crear una nueva tarea (con flags o texto libre para clasificación con IA)')
  .option('-t, --type <type>', 'Tipo de tarea: feature | fix | bug', 'feature')
  .option('-T, --title <title>', 'Título de la tarea')
  .option('-p, --priority <priority>', 'Prioridad: alta | media | baja', 'media')
  .option('-l, --labels <labels>', 'Etiquetas separadas por coma (ej: auth,ui)')
  .option('-c, --column <column>', 'Columna inicial', 'backlog')
  .option('--ai', 'Usar IA (claude/opencode) para clasificar texto libre')
  .option('--engine <engine>', 'CLI a usar para clasificar: claude | opencode')
  .action(async (freeText, options) => {
    const { createCommand } = require('./commands/create');
    await createCommand(freeText, options);
  });

// ─────────────────────────────────────────────
// COMANDO: list
// ─────────────────────────────────────────────
program
  .command('list [column]')
  .description('Listar tareas del tablero (all, backlog, todo, in_progress, review, done)')
  .option('-l, --label <label>', 'Filtrar por etiqueta')
  .option('--json', 'Salida en formato JSON')
  .action((column, options) => {
    const { listCommand } = require('./commands/list');
    listCommand(column, options);
  });

// ─────────────────────────────────────────────
// COMANDO: move
// ─────────────────────────────────────────────
program
  .command('move <id> <column>')
  .description('Mover una tarea a otra columna')
  .action((id, column) => {
    const { moveCommand } = require('./commands/move');
    moveCommand(id, column);
  });

// ─────────────────────────────────────────────
// COMANDO: retry
// ─────────────────────────────────────────────
program
  .command('retry <id>')
  .description('Mover tarea de REVIEW a TODO para reintentar')
  .action((id) => {
    const { retryCommand } = require('./commands/retry');
    retryCommand(id);
  });

// ─────────────────────────────────────────────
// COMANDO: unstuck
// ─────────────────────────────────────────────
program
  .command('unstuck')
  .description('Detectar y arreglar tareas atascadas')
  .option('--all', 'Mover todas las tareas de REVIEW a TODO')
  .option('--dry-run', 'Solo mostrar qué se haría, sin cambios')
  .option('--project <path>', 'Ruta del proyecto')
  .action((options) => {
    const { unstuckCommand } = require('./commands/retry');
    unstuckCommand(options);
  });

// ─────────────────────────────────────────────
// COMANDO: start
// ─────────────────────────────────────────────
program
  .command('start')
  .description('Iniciar el motor de automatización IA (loop infinito)')
  .option('--once', 'Procesar solo la primera tarea y terminar')
  .option('--dry-run', 'Simular ejecución sin cambios reales')
  .option('--interactive', 'Modo interactivo: puedes escribir comandos a la IA')
  .option('--project <path>', 'Ruta del proyecto donde trabaja el agente (sobreescribe config)')
  .option('--engine <engine>', 'CLI a usar: claude | opencode (sobreescribe config)')
  .action(async (options) => {
    const { startCommand } = require('./commands/start');
    await startCommand(options);
  });

// ─────────────────────────────────────────────
// COMANDO: interactive (alias rápido)
// ─────────────────────────────────────────────
program
  .command('interactive [prompt]')
  .alias('i')
  .description('Abrir sesión interactiva con la IA (sin procesar tareas)')
  .option('--project <path>', 'Ruta del proyecto')
  .option('--engine <engine>', 'CLI a usar: claude | opencode')
  .action(async (prompt, options) => {
    const { runInteractiveSession, detectAvailableEngine, notify } = require('../../core/ai-executor');
    const path = require('path');
    
    const projectPath = options.project || process.cwd();
    const engine = detectAvailableEngine(options.engine || 'claude');
    
    if (!engine) {
      console.log(chalk.red('\n  ❌ No se encontró ningún CLI (claude ni opencode).\n'));
      process.exit(1);
    }
    
    await runInteractiveSession(engine, projectPath, prompt || null);
    notify('AI-Kanban', 'Sesión interactiva finalizada');
  });

// ─────────────────────────────────────────────
// COMANDO: board
// ─────────────────────────────────────────────
program
  .command('board')
  .description('Abrir el tablero Kanban visual en el navegador')
  .option('-p, --port <port>', 'Puerto del servidor', '3847')
  .action(async (options) => {
    const { boardCommand } = require('./commands/board');
    await boardCommand(options);
  });

// ─────────────────────────────────────────────
// COMANDO: show
// ─────────────────────────────────────────────
program
  .command('show <id>')
  .description('Mostrar detalle de una tarea')
  .action((id) => {
    const { showCommand } = require('./commands/show');
    showCommand(id);
  });

// ─────────────────────────────────────────────
// COMANDO: delete
// ─────────────────────────────────────────────
program
  .command('delete <id>')
  .description('Eliminar una tarea')
  .action(async (id) => {
    const { deleteCommand } = require('./commands/delete');
    await deleteCommand(id);
  });

// ─────────────────────────────────────────────
// Error handling global
// ─────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});

program.parse(process.argv);
