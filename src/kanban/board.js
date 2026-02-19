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
 * Clave de caché única por kanbanPath
 */
function pathKey(kanbanPath) {
  // usa los últimos 2 segmentos del path como identificador corto
  const parts = kanbanPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('_') || 'default';
}

/**
 * Obtiene todas las tareas, opcionalmente filtradas por columna
 * @param {string|null} column - Columna a filtrar, null para todas
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function getTasks(column = null, kanbanPath = KANBAN_PATH) {
  if (column) {
    return getTasksFromColumn(column, kanbanPath);
  }

  const result = {};
  for (const col of COLUMNS) {
    result[col] = getTasksFromColumn(col, kanbanPath);
  }
  return result;
}

/**
 * Lee todas las tareas de una columna específica
 * @param {string} column - Nombre de la columna
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function getTasksFromColumn(column, kanbanPath = KANBAN_PATH) {
  const colPath = path.join(kanbanPath, column);

  if (!fs.existsSync(colPath)) {
    return [];
  }

  const files = fs.readdirSync(colPath)
    .filter(f => f.endsWith('.md'))
    .sort();

  return files.map(file => {
    try {
      return parseTask(path.join(colPath, file), kanbanPath);
    } catch (err) {
      console.error(`Error parseando ${file}:`, err.message);
      return null;
    }
  }).filter(Boolean);
}

/**
 * Busca una tarea por ID en todas las columnas
 * @param {string} id - ID de la tarea (ej: "001")
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function getTaskById(id, kanbanPath = KANBAN_PATH) {
  const paddedId = String(id).padStart(3, '0');

  for (const column of COLUMNS) {
    const colPath = path.join(kanbanPath, column);

    if (!fs.existsSync(colPath)) continue;

    const files = fs.readdirSync(colPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      if (file.startsWith(paddedId + '-') || file.startsWith(id + '-')) {
        const filePath = path.join(colPath, file);
        const task = parseTask(filePath, kanbanPath);
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
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function moveTask(taskId, toColumn, kanbanPath = KANBAN_PATH) {
  if (!COLUMNS.includes(toColumn)) {
    throw new Error(`Columna inválida: ${toColumn}. Válidas: ${COLUMNS.join(', ')}`);
  }

  const found = getTaskById(taskId, kanbanPath);
  if (!found) {
    throw new Error(`Tarea ${taskId} no encontrada`);
  }

  const { task, filePath, fileName, column: fromColumn } = found;

  if (fromColumn === toColumn) {
    return { success: true, task, fromColumn, toColumn, message: 'Ya está en esa columna' };
  }

  task.status = toColumn;
  task.column = toColumn;

  const destPath = path.join(kanbanPath, toColumn, fileName);

  const { writeTask } = require('../core/task');
  writeTask(task, destPath);
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
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function createTask(taskData, column = 'backlog', kanbanPath = KANBAN_PATH) {
  const { writeTask, generateFileName } = require('../core/task');

  const fileName = generateFileName(taskData.id, taskData.title);
  const filePath = path.join(kanbanPath, column, fileName);

  const task = {
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    dependsOn: [],
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
 * @param {string} [kanbanPath] - Ruta base del kanban
 */
function deleteTask(taskId, kanbanPath = KANBAN_PATH) {
  const found = getTaskById(taskId, kanbanPath);
  if (!found) {
    throw new Error(`Tarea ${taskId} no encontrada`);
  }
  fs.unlinkSync(found.filePath);
  return true;
}

// ─────────────────────────────────────────────
// Funciones con caché Redis
// ─────────────────────────────────────────────

async function getTasksCached(column = null, kanbanPath = KANBAN_PATH) {
  const pk = pathKey(kanbanPath);
  const key = column ? `tasks:column:${column}:${pk}` : `tasks:all:${pk}`;
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const result = getTasks(column, kanbanPath);
  await cache.set(key, result, TTL_TASKS);
  return result;
}

async function getTaskByIdCached(id, kanbanPath = KANBAN_PATH) {
  const paddedId = String(id).padStart(3, '0');
  const pk = pathKey(kanbanPath);
  const key = `task:${paddedId}:${pk}`;
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const result = getTaskById(id, kanbanPath);
  if (result) await cache.set(key, result, TTL_TASK);
  return result;
}

async function invalidateTaskCache(id, columns = [], kanbanPath = KANBAN_PATH) {
  const paddedId = String(id).padStart(3, '0');
  const pk = pathKey(kanbanPath);
  const keys = [`task:${paddedId}:${pk}`, `tasks:all:${pk}`];
  for (const col of columns) {
    if (col) keys.push(`tasks:column:${col}:${pk}`);
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
