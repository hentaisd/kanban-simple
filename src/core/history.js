/**
 * history.js — Manager de historial de ejecución por tarea
 *
 * Guarda registros en kanban/.history/{id}.json
 * Mantiene las últimas MAX_RECORDS ejecuciones por tarea
 */

const fs = require('fs');
const path = require('path');

const KANBAN_PATH = process.env.KANBAN_PATH
  ? path.resolve(process.env.KANBAN_PATH)
  : path.resolve(__dirname, '../../kanban');

const HISTORY_DIR = path.join(KANBAN_PATH, '.history');
const MAX_RECORDS = 20;

function getHistoryFile(taskId) {
  const paddedId = String(taskId).padStart(3, '0');
  return path.join(HISTORY_DIR, `${paddedId}.json`);
}

/**
 * Guarda un registro de ejecución para una tarea.
 * Append al array existente, mantiene últimas MAX_RECORDS entradas.
 *
 * @param {string} taskId
 * @param {Object} record - { result, totalDuration, iterations, phases: { plan, code[], review[], test[] } }
 */
function saveExecution(taskId, record) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const file = getHistoryFile(taskId);

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
 * @returns {Object[]}
 */
function getHistory(taskId) {
  const file = getHistoryFile(taskId);
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
 */
function clearHistory(taskId) {
  const file = getHistoryFile(taskId);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

module.exports = { saveExecution, getHistory, clearHistory };
