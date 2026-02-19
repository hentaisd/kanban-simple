/**
 * board.js - Comando para abrir el tablero visual Kanban
 */

const chalk = require('chalk');
const { spawn } = require('child_process');
const path = require('path');

async function boardCommand(options) {
  const port = options.port || 3847;

  console.log(chalk.blue.bold('\n🖥  AI-Kanban - Tablero Visual\n'));
  console.log(chalk.white(`Iniciando servidor en puerto ${chalk.cyan(port)}...`));

  const serverPath = path.resolve(__dirname, '../../ui/server.js');

  const server = spawn('node', [serverPath], {
    env: { ...process.env, PORT: port },
    stdio: 'inherit',
  });

  // Esperar un momento para que el servidor arranque y luego abrir browser
  setTimeout(async () => {
    try {
      const open = require('open');
      const url = `http://localhost:${port}`;
      console.log(chalk.green(`\n✅ Tablero disponible en: ${chalk.cyan.underline(url)}\n`));
      await open(url);
    } catch (err) {
      console.log(chalk.gray(`Abre manualmente: http://localhost:${port}\n`));
    }
  }, 1500);

  server.on('error', (err) => {
    console.error(chalk.red(`❌ Error iniciando servidor: ${err.message}`));
    process.exit(1);
  });

  // Manejar cierre limpio
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nDeteniendo servidor...\n'));
    server.kill();
    process.exit(0);
  });
}

module.exports = { boardCommand };
