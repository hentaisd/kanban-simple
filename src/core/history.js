/**
 * history.js — Manager de historial de ejecución por tarea
 *
 * Guarda registros en {kanbanPath}/.history/{id}.json
 * Artefactos de fases en {kanbanPath}/.history/{id}/*.md
 * Mantiene las últimas MAX_RECORDS ejecuciones por tarea
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_KANBAN_PATH = process.env.KANBAN_PATH
  ? path.resolve(process.env.KANBAN_PATH)
  : path.resolve(__dirname, '../../kanban');

const MAX_RECORDS = 20;

function resolveHistoryDir(kanbanPath) {
  return path.join(kanbanPath || DEFAULT_KANBAN_PATH, '.history');
}

function getHistoryFile(taskId, kanbanPath) {
  const paddedId = String(taskId).padStart(3, '0');
  return path.join(resolveHistoryDir(kanbanPath), `${paddedId}.json`);
}

/**
 * Guarda un registro de ejecución para una tarea.
 * Append al array existente, mantiene últimas MAX_RECORDS entradas.
 *
 * @param {string} taskId
 * @param {Object} record - { result, totalDuration, iterations, phases: { plan, code[], review[], test[] } }
 * @param {string} [kanbanPath] - Ruta kanban del proyecto (opcional)
 */
function saveExecution(taskId, record, kanbanPath) {
  const histDir = resolveHistoryDir(kanbanPath);
  fs.mkdirSync(histDir, { recursive: true });
  const file = getHistoryFile(taskId, kanbanPath);

  let history = [];
  if (fs.existsSync(file)) {
    try {
      history = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      history = [];
    }
  }

  history.push({
    timestamp: new Date().toISOString(),
    ...record,
  });

  if (history.length > MAX_RECORDS) {
    history = history.slice(-MAX_RECORDS);
  }

  fs.writeFileSync(file, JSON.stringify(history, null, 2), 'utf8');
}

/**
 * Lee el historial de ejecución de una tarea.
 * @param {string} taskId
 * @param {string} [kanbanPath]
 * @returns {Object[]}
 */
function getHistory(taskId, kanbanPath) {
  const file = getHistoryFile(taskId, kanbanPath);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Elimina el historial de una tarea.
 * @param {string} taskId
 * @param {string} [kanbanPath]
 */
function clearHistory(taskId, kanbanPath) {
  const file = getHistoryFile(taskId, kanbanPath);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

module.exports = { saveExecution, getHistory, clearHistory };
