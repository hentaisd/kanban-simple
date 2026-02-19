/**
 * init.js — Asistente de configuración inicial
 * Genera/actualiza kanban.config.js de forma interactiva
 */

const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const inquirer = require('inquirer');
const { detectAvailableEngine } = require('../../core/ai-executor');

const CONFIG_PATH = path.resolve(__dirname, '../../../kanban.config.js');

async function initCommand() {
  console.log(chalk.blue.bold('\n🛠  AI-Kanban — Configuración\n'));

  // Detectar engines disponibles
  const hasClaude   = detectAvailableEngine('claude')   === 'claude';
  const hasOpencode = detectAvailableEngine('opencode') === 'opencode';
  const engineChoices = [];
  if (hasClaude)   engineChoices.push({ name: 'claude   (Claude Code)', value: 'claude' });
  if (hasOpencode) engineChoices.push({ name: 'opencode', value: 'opencode' });
  if (engineChoices.length === 0) {
    engineChoices.push({ name: 'claude (no detectado, instalar después)', value: 'claude' });
  }

  // Leer config actual si existe
  let current = {};
  try {
    delete require.cache[require.resolve(CONFIG_PATH)];
    current = require(CONFIG_PATH);
  } catch { /* no existe aún */ }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectPath',
      message: '¿Ruta del proyecto donde el agente escribirá código?',
      default: current.projectPath || process.cwd(),
      validate: v => fs.existsSync(v.trim()) ? true : `Ruta no existe: ${v}`,
    },
    {
      type: 'list',
      name: 'engine',
      message: '¿Qué CLI usar para ejecutar las tareas?',
      choices: engineChoices,
      default: current.engine || 'claude',
    },
    {
      type: 'confirm',
      name: 'gitEnabled',
      message: '¿Activar integración git (branch, commit, merge)?',
      default: current.git?.enabled ?? true,
    },
    {
      type: 'input',
      name: 'defaultBranch',
      message: 'Branch base del proyecto (main / master / develop)',
      default: current.git?.defaultBranch ?? 'main',
      when: a => a.gitEnabled,
    },
    {
      type: 'confirm',
      name: 'autoPush',
      message: '¿Hacer push automático al remote después de cada tarea?',
      default: current.git?.autoPush ?? false,
      when: a => a.gitEnabled,
    },
    {
      type: 'number',
      name: 'waitSeconds',
      message: '¿Segundos de espera entre ciclos cuando no hay tareas?',
      default: current.loop?.waitSeconds ?? 30,
    },
  ]);

  // Generar kanban.config.js
  const config = `/**
 * kanban.config.js — Configuración AI-Kanban
 * Generado: ${new Date().toLocaleString()}
 */

module.exports = {
  // Proyecto donde el agente leerá y escribirá código
  projectPath: '${answers.projectPath.trim()}',

  // CLI a usar: 'claude' | 'opencode'
  engine: '${answers.engine}',

  git: {
    enabled: ${answers.gitEnabled},
    defaultBranch: '${answers.defaultBranch || 'main'}',
    autoPush: ${answers.autoPush || false},
    autoMerge: ${answers.gitEnabled},
  },

  loop: {
    waitSeconds: ${answers.waitSeconds || 30},
    maxTasksPerRun: 0, // 0 = ilimitado
  },
};
`;

  fs.writeFileSync(CONFIG_PATH, config, 'utf8');

  console.log(chalk.green(`\n✅ Config guardado en: ${CONFIG_PATH}\n`));
  console.log(chalk.white('Resumen:'));
  console.log(chalk.gray(`  Proyecto : ${answers.projectPath}`));
  console.log(chalk.gray(`  Engine   : ${answers.engine}`));
  console.log(chalk.gray(`  Git      : ${answers.gitEnabled ? 'activado' : 'desactivado'}`));
  console.log('');
  console.log(chalk.cyan('Listo para usar:'));
  console.log(chalk.white('  ai-kanban create "descripción de la tarea"'));
  console.log(chalk.white('  ai-kanban move 001 todo'));
  console.log(chalk.white('  ai-kanban start'));
  console.log('');
}

module.exports = { initCommand };
