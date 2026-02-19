/**
 * start.js — Inicia el motor de automatización
 *
 * Flags:
 *   --project /ruta   → proyecto donde trabaja el agente (sobreescribe config)
 *   --engine claude   → fuerza uso de claude CLI
 *   --engine opencode → fuerza uso de opencode CLI
 *   --once            → procesa solo la primera tarea y termina
 *   --dry-run         → simula sin ejecutar
 */

const chalk = require('chalk');
const { detectAvailableEngine } = require('../../core/ai-executor');

async function startCommand(options) {
  const { startLoop } = require('../../core/loop');

  console.log(chalk.blue.bold('\n🤖 AI-Kanban — Motor de Automatización\n'));

  // Mostrar qué engines hay disponibles
  const hasClaude   = detectAvailableEngine('claude')   === 'claude';
  const hasOpencode = detectAvailableEngine('opencode') === 'opencode';
  console.log(`  claude   : ${hasClaude   ? chalk.green('✓ disponible') : chalk.gray('✗ no encontrado')}`);
  console.log(`  opencode : ${hasOpencode ? chalk.green('✓ disponible') : chalk.gray('✗ no encontrado')}`);

  if (!hasClaude && !hasOpencode && !options.dryRun) {
    console.log(chalk.red('\n  ❌ Ningún CLI disponible. Instala claude o opencode.\n'));
    process.exit(1);
  }

  if (options.project) {
    console.log(chalk.cyan(`\n  Proyecto : ${options.project}`));
  }
  if (options.engine) {
    console.log(chalk.cyan(`  Engine   : ${options.engine}`));
  }
  if (options.dryRun) {
    console.log(chalk.yellow('\n  🔍 DRY RUN — solo simulación, sin cambios reales'));
  }

  console.log('');

  await startLoop({
    project: options.project  || undefined,
    engine:  options.engine   || undefined,
    once:    options.once     || false,
    dryRun:  options.dryRun   || false,
  });
}

module.exports = { startCommand };
