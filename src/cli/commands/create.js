/**
 * create.js - Comando para crear nuevas tareas
 */

const chalk = require('chalk');
const path = require('path');
const { nextId } = require('../../core/id-generator');
const { generateBranchName, generateFileName, KANBAN_PATH } = require('../../core/task');
const { createTask } = require('../../kanban/board');

const VALID_TYPES = ['feature', 'fix', 'bug'];
const VALID_PRIORITIES = ['alta', 'media', 'baja'];
const VALID_COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];

/**
 * Clasifica texto libre usando heurísticas simples (sin IA)
 * Para usar IA se necesita ANTHROPIC_API_KEY
 */
function classifyFreeText(text) {
  const lower = text.toLowerCase();

  let type = 'feature';
  if (/\b(fix|arreglar|corregir|resolver|error|falla|bug|problema|roto|broken)\b/.test(lower)) {
    type = lower.includes('bug') ? 'bug' : 'fix';
  } else if (/\b(bug|fallo|crash|excepcion|exception|exception)\b/.test(lower)) {
    type = 'bug';
  }

  // Limpiar texto para usarlo como título
  const title = text
    .replace(/^(necesito|quiero|hay que|se debe|debe|debería|arreglar|crear|hacer|implementar|agregar|añadir)\s+/i, '')
    .trim();

  // Generar criterios básicos
  const criteria = generateBasicCriteria(type, title);

  return { type, title, criteria };
}

/**
 * Genera criterios de aceptación básicos según tipo
 */
function generateBasicCriteria(type, title) {
  if (type === 'feature') {
    return [
      `La funcionalidad "${title}" está implementada y funcionando`,
      'Los tests relevantes pasan correctamente',
      'El código está documentado',
    ];
  } else if (type === 'fix' || type === 'bug') {
    return [
      `El problema "${title}" está resuelto`,
      'El caso que causaba el error ya no ocurre',
      'No se han introducido regresiones',
    ];
  }
  return [`La tarea "${title}" está completada`];
}

/**
 * Clasifica texto libre usando el CLI `claude` local
 */
async function classifyWithAI(text, engine = 'claude') {
  try {
    const { classifyTask, detectAvailableEngine } = require('../../core/ai-executor');
    const available = detectAvailableEngine(engine);
    if (!available) {
      console.log(chalk.yellow(`⚠ ${engine} no disponible. Usando clasificación simple.`));
      return classifyFreeText(text);
    }
    console.log(chalk.gray(`  Clasificando con ${available} CLI...`));
    return await classifyTask(text, available);
  } catch (err) {
    console.log(chalk.yellow(`⚠ Error con IA: ${err.message}. Usando clasificación simple.`));
    return classifyFreeText(text);
  }
}

/**
 * Comando create principal
 */
async function createCommand(freeText, options) {
  console.log(chalk.blue.bold('\n🗂  AI-Kanban - Crear Tarea\n'));

  let { type, title, priority, labels, column } = options;

  // Si hay texto libre, clasificar
  if (freeText && !title) {
    console.log(chalk.gray(`Clasificando: "${freeText}"...`));
    const classified = options.ai
      ? await classifyWithAI(freeText, options.engine || 'claude')
      : classifyFreeText(freeText);

    type = classified.type;
    title = classified.title;

    console.log(chalk.green(`✓ Tipo detectado: ${type}`));
    console.log(chalk.green(`✓ Título: ${title}`));
  }

  // Validaciones
  if (!title) {
    console.error(chalk.red('Error: Se requiere un título (--title o texto libre)'));
    process.exit(1);
  }

  if (!VALID_TYPES.includes(type)) {
    console.error(chalk.red(`Error: Tipo inválido "${type}". Válidos: ${VALID_TYPES.join(', ')}`));
    process.exit(1);
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    priority = 'media';
  }

  if (!VALID_COLUMNS.includes(column)) {
    column = 'backlog';
  }

  // Generar ID y branch
  const id = nextId();
  const branch = generateBranchName(type, title);

  // Procesar labels
  const labelsArray = labels
    ? labels.split(',').map(l => l.trim()).filter(Boolean)
    : [];

  // Clasificar si es texto libre (para criterios)
  let criteria = [];
  if (freeText) {
    const classified = classifyFreeText(freeText);
    criteria = classified.criteria;
  } else {
    criteria = generateBasicCriteria(type, title);
  }

  // Crear descripción por defecto
  const content = `# Descripción
${title}

# Criterios de aceptación
${criteria.map(c => `- ${c}`).join('\n')}`;

  // Datos de la tarea
  const taskData = {
    id,
    title,
    type,
    priority,
    branch,
    labels: labelsArray,
    status: column,
  };

  // Crear en el tablero
  const task = createTask({ ...taskData, content }, column);

  // Mostrar resultado
  console.log(chalk.green.bold(`\n✅ Tarea creada exitosamente!\n`));
  console.log(chalk.white(`  ID:       ${chalk.cyan(task.id)}`));
  console.log(chalk.white(`  Título:   ${chalk.cyan(task.title)}`));
  console.log(chalk.white(`  Tipo:     ${typeColor(task.type)(task.type)}`));
  console.log(chalk.white(`  Prioridad:${priorityColor(task.priority)(task.priority)}`));
  console.log(chalk.white(`  Branch:   ${chalk.gray(task.branch)}`));
  console.log(chalk.white(`  Columna:  ${chalk.yellow(task.column)}`));
  if (labelsArray.length > 0) {
    console.log(chalk.white(`  Labels:   ${labelsArray.map(l => chalk.magenta(l)).join(', ')}`));
  }
  console.log(chalk.white(`  Archivo:  ${chalk.gray(task.filePath)}\n`));

  return task;
}

function typeColor(type) {
  if (type === 'feature') return chalk.blue;
  if (type === 'fix') return chalk.yellow;
  if (type === 'bug') return chalk.red;
  return chalk.white;
}

function priorityColor(priority) {
  if (priority === 'alta') return chalk.red;
  if (priority === 'media') return chalk.yellow;
  if (priority === 'baja') return chalk.green;
  return chalk.white;
}

module.exports = { createCommand };
