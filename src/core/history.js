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

function getArtifactsDir(taskId, kanbanPath) {
  const paddedId = String(taskId).padStart(3, '0');
  return path.join(resolveHistoryDir(kanbanPath), paddedId);
}

function getDefaultPhases() {
  return {
    plan: { status: 'unknown', duration: 0, summary: '' },
    code: [],
    review: [],
    test: [],
    scope: { status: 'unknown', duration: 0, summary: '' },
  };
}

function repairPhases(entry, taskId, kanbanPath) {
  if (!entry) return entry;
  
  if (!entry.phases || Object.keys(entry.phases).length === 0 || !entry.phases.plan) {
    const newPhases = getDefaultPhases();
    
    const artifactsDir = getArtifactsDir(taskId, kanbanPath);
    if (fs.existsSync(artifactsDir)) {
      const artifacts = fs.readdirSync(artifactsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));
      
      if (artifacts.includes('plan')) {
        newPhases.plan = { status: 'ok', duration: 0, summary: 'Reconstruido desde artefacto' };
      }
      
      const codeIters = artifacts.filter(a => a.startsWith('code-iter'));
      for (const c of codeIters) {
        const iter = parseInt(c.replace('code-iter', '')) || 1;
        newPhases.code.push({ iteration: iter, status: 'ok', duration: 0, summary: 'Reconstruido' });
      }
      
      const reviewIters = artifacts.filter(a => a.startsWith('review-iter'));
      for (const r of reviewIters) {
        const iter = parseInt(r.replace('review-iter', '')) || 1;
        newPhases.review.push({ iteration: iter, status: 'approved', duration: 0, summary: 'Reconstruido' });
      }
      
      const testIters = artifacts.filter(a => a.startsWith('test-iter'));
      for (const t of testIters) {
        const iter = parseInt(t.replace('test-iter', '')) || 1;
        newPhases.test.push({ iteration: iter, status: 'ok', duration: 0, summary: 'Reconstruido' });
      }
      
      if (artifacts.includes('scope')) {
        newPhases.scope = { status: 'ok', duration: 0, summary: 'Reconstruido desde artefacto' };
      }
    } else {
      newPhases.plan = { status: 'lost', duration: 0, summary: 'Datos no disponibles' };
      newPhases.scope = { status: 'lost', duration: 0, summary: 'Datos no disponibles' };
    }
    
    entry.phases = newPhases;
    return true;
  }
  return false;
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
 * Auto-repara entradas con phases vacío.
 * @param {string} taskId
 * @param {string} [kanbanPath]
 * @returns {Object[]}
 */
function getHistory(taskId, kanbanPath) {
  const file = getHistoryFile(taskId, kanbanPath);
  if (!fs.existsSync(file)) return [];
  
  try {
    const history = JSON.parse(fs.readFileSync(file, 'utf8'));
    
    if (!Array.isArray(history)) return [];
    
    let needsSave = false;
    for (const entry of history) {
      if (repairPhases(entry, taskId, kanbanPath)) {
        needsSave = true;
      }
    }
    
    if (needsSave) {
      fs.writeFileSync(file, JSON.stringify(history, null, 2), 'utf8');
    }
    
    return history;
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
