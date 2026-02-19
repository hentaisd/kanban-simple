/**
 * board.js - Operaciones del tablero Kanban
 * Gestiona el movimiento de archivos entre columnas
 */

const fs = require('fs');
const path = require('path');
const { parseTask, COLUMNS, KANBAN_PATH } = require('../core/task');
const cache = require('../core/cache');

// TTLs de caché en segundos
const TTL_TASKS = 30;
const TTL_TASK = 60;

/**
 * Obtiene todas las tareas, opcionalmente filtradas por columna
 * @param {string|null} column - Columna a filtrar, null para todas
 * @returns {Object} - { backlog: [], todo: [], in_progress: [], review: [], done: [] }
 *                     o array si se especifica columna
 */
function getTasks(column = null) {
  if (column) {
    return getTasksFromColumn(column);
  }

  const result = {};
  for (const col of COLUMNS) {
    result[col] = getTasksFromColumn(col);
  }
  return result;
}

/**
 * Lee todas las tareas de una columna específica
 * @param {string} column - Nombre de la columna
 * @returns {Object[]} - Array de tareas parseadas, ordenadas por ID
 */
function getTasksFromColumn(column) {
  const colPath = path.join(KANBAN_PATH, column);

  if (!fs.existsSync(colPath)) {
    return [];
  }

  const files = fs.readdirSync(colPath)
    .filter(f => f.endsWith('.md'))
    .sort();

  return files.map(file => {
    try {
      return parseTask(path.join(colPath, file));
    } catch (err) {
      console.error(`Error parseando ${file}:`, err.message);
      return null;
    }
  }).filter(Boolean);
}

/**
 * Busca una tarea por ID en todas las columnas
 * @param {string} id - ID de la tarea (ej: "001")
 * @returns {{ task: Object, column: string, filePath: string } | null}
 */
function getTaskById(id) {
  const paddedId = String(id).padStart(3, '0');

  for (const column of COLUMNS) {
    const colPath = path.join(KANBAN_PATH, column);

    if (!fs.existsSync(colPath)) continue;

    const files = fs.readdirSync(colPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      if (file.startsWith(paddedId + '-') || file.startsWith(id + '-')) {
        const filePath = path.join(colPath, file);
        const task = parseTask(filePath);
        return { task, column, filePath, fileName: file };
      }
    }
  }

  return null;
}

/**
 * Mueve una tarea a otra columna (mueve el archivo físicamente)
 * @param {string} taskId - ID de la tarea
 * @param {string} toColumn - Columna destino
 * @returns {{ success: boolean, task: Object, fromColumn: string, toColumn: string }}
 */
function moveTask(taskId, toColumn) {
  if (!COLUMNS.includes(toColumn)) {
    throw new Error(`Columna inválida: ${toColumn}. Válidas: ${COLUMNS.join(', ')}`);
  }

  const found = getTaskById(taskId);
  if (!found) {
    throw new Error(`Tarea ${taskId} no encontrada`);
  }

  const { task, filePath, fileName, column: fromColumn } = found;

  if (fromColumn === toColumn) {
    return { success: true, task, fromColumn, toColumn, message: 'Ya está en esa columna' };
  }

  // Actualizar el frontmatter status
  task.status = toColumn;
  task.column = toColumn;

  const destPath = path.join(KANBAN_PATH, toColumn, fileName);

  // Leer contenido original y actualizar status en frontmatter
  const { parseTask: _p, writeTask } = require('../core/task');
  writeTask(task, destPath);

  // Eliminar archivo origen
  fs.unlinkSync(filePath);

  return {
    success: true,
    task,
    fromColumn,
    toColumn,
    filePath: destPath,
  };
}

/**
 * Crea una nueva tarea en una columna
 * @param {Object} taskData - Datos de la tarea
 * @param {string} column - Columna inicial (default: backlog)
 * @returns {Object} - Tarea creada con filePath
 */
function createTask(taskData, column = 'backlog') {
  const { writeTask, generateFileName } = require('../core/task');

  const fileName = generateFileName(taskData.id, taskData.title);
  const filePath = path.join(KANBAN_PATH, column, fileName);

  const task = {
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    dependsOn: [],
    projectPath: null,
    iterations: 0,
    ...taskData,
    status: column,
  };

  writeTask(task, filePath);

  return { ...task, filePath, column, fileName };
}

/**
 * Elimina una tarea del tablero
 * @param {string} taskId - ID de la tarea
 * @returns {boolean}
 */
function deleteTask(taskId) {
  const found = getTaskById(taskId);
  if (!found) {
    throw new Error(`Tarea ${taskId} no encontrada`);
  }
  fs.unlinkSync(found.filePath);
  return true;
}

// ─────────────────────────────────────────────
// Funciones con caché Redis
// ─────────────────────────────────────────────

/**
 * Versión con caché de getTasks()
 * @param {string|null} column
 * @returns {Promise<Object|Object[]>}
 */
async function getTasksCached(column = null) {
  const key = column ? `tasks:column:${column}` : 'tasks:all';
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const result = getTasks(column);
  await cache.set(key, result, TTL_TASKS);
  return result;
}

/**
 * Versión con caché de getTaskById()
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function getTaskByIdCached(id) {
  const paddedId = String(id).padStart(3, '0');
  const key = `task:${paddedId}`;
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const result = getTaskById(id);
  if (result) await cache.set(key, result, TTL_TASK);
  return result;
}

/**
 * Invalida las entradas de caché relacionadas con una tarea
 * @param {string} id - ID de la tarea
 * @param {string[]} columns - Columnas afectadas por la operación
 */
async function invalidateTaskCache(id, columns = []) {
  const paddedId = String(id).padStart(3, '0');
  const keys = [`task:${paddedId}`, 'tasks:all'];
  for (const col of columns) {
    if (col) keys.push(`tasks:column:${col}`);
  }
  await cache.del(keys);
}

module.exports = {
  getTasks,
  getTasksFromColumn,
  getTaskById,
  moveTask,
  createTask,
  deleteTask,
  getTasksCached,
  getTaskByIdCached,
  invalidateTaskCache,
};
