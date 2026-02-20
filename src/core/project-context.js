/**
 * project-context.js — Memoria compartida entre tareas
 *
 * Mantiene `kanban/.project-context.md` que la IA acumula con:
 *   - Stack tecnológico usado
 *   - Decisiones de arquitectura tomadas
 *   - Features ya implementadas
 *   - Convenciones y patrones del proyecto
 *
 * La IA lee este archivo antes de planificar (fase PLAN) y lo
 * actualiza al final de cada tarea exitosa (fase SCOPE).
 */

const fs   = require('fs');
const path = require('path');

const CONTEXT_FILENAME = '.project-context.md';

/**
 * Lee el contexto acumulado del proyecto.
 * @param {string} kanbanPath - Ruta al directorio kanban/ del proyecto
 * @returns {string|null} Contenido del contexto o null si no existe
 */
function readContext(kanbanPath) {
  try {
    const file = path.join(kanbanPath, CONTEXT_FILENAME);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  } catch {}
  return null;
}

/**
 * Devuelve la ruta absoluta del archivo de contexto.
 * Se pasa al agente para que pueda escribirlo directamente.
 * @param {string} kanbanPath
 * @returns {string}
 */
function getContextPath(kanbanPath) {
  return path.join(kanbanPath, CONTEXT_FILENAME);
}

module.exports = { readContext, getContextPath };
