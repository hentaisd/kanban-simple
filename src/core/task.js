/**
 * task.js - Parser y serializer de tareas .md con frontmatter
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { slugify } = require('../utils');

const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];

const KANBAN_PATH = process.env.KANBAN_PATH
  ? path.resolve(process.env.KANBAN_PATH)
  : path.resolve(__dirname, '../../kanban');

/**
 * Retorna la ruta al directorio kanban de un proyecto dado.
 * Si no se pasa projectPath, retorna el KANBAN_PATH global.
 * @param {string|null} projectPath - Ruta raíz del proyecto
 * @returns {string}
 */
function getKanbanPath(projectPath) {
  if (projectPath) return path.join(projectPath, 'kanban');
  return KANBAN_PATH;
}

/**
 * Lee un archivo .md y retorna el objeto task
 * @param {string} filePath - Ruta absoluta al archivo .md
 * @param {string} [kanbanPath] - Ruta base del kanban (para calcular la columna)
 * @returns {Object} - Objeto task con frontmatter + content + meta
 */
function parseTask(filePath, kanbanPath = KANBAN_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);

  // Determinar columna actual desde la ruta del archivo
  const relativePath = path.relative(kanbanPath, filePath);
  const column = relativePath.split(path.sep)[0];

  return {
    ...data,
    content: content.trim(),
    filePath,
    column,
    // Normalizar labels a array siempre
    labels: Array.isArray(data.labels) ? data.labels : (data.labels ? [data.labels] : []),
  };
}

/**
 * Escribe un objeto task a un archivo .md
 * @param {Object} task - Objeto task
 * @param {string} filePath - Ruta donde escribir
 */
function writeTask(task, filePath) {
  const { content, filePath: _fp, column, ...frontmatter } = task;

  const fileContent = matter.stringify(content || '', frontmatter);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fileContent, 'utf8');
}

/**
 * Genera nombre de branch desde tipo y título
 * feature/login-usuario, fix/arreglar-error-x, bug/error-login
 * @param {string} type - feature | fix | bug
 * @param {string} title - Título de la tarea
 * @returns {string} - Nombre del branch
 */
function generateBranchName(type, title) {
  const slug = slugify(title, { maxLength: 50 });
  const prefix = type === 'feature' ? 'feature' : type === 'fix' ? 'fix' : 'bug';
  return `${prefix}/${slug}`;
}

/**
 * Genera el nombre de archivo desde ID y título
 * @param {string} id - ID de la tarea (ej: "001")
 * @param {string} title - Título de la tarea
 * @returns {string} - Nombre del archivo (ej: "001-login-usuario.md")
 */
function generateFileName(id, title) {
  const slug = slugify(title, { maxLength: 40 });
  return `${id}-${slug}.md`;
}

/**
 * Retorna la ruta a una columna del kanban
 */
function getColumnPath(column, kanbanPath = KANBAN_PATH) {
  if (!COLUMNS.includes(column)) {
    throw new Error(`Columna inválida: ${column}. Válidas: ${COLUMNS.join(', ')}`);
  }
  return path.join(kanbanPath, column);
}

module.exports = {
  parseTask,
  writeTask,
  generateBranchName,
  generateFileName,
  getColumnPath,
  getKanbanPath,
  COLUMNS,
  KANBAN_PATH,
};
