/**
 * id-generator.js - Generador de IDs secuenciales para tareas
 */

const fs = require('fs');
const path = require('path');
const { KANBAN_PATH, COLUMNS } = require('./task');

/**
 * Obtiene todos los IDs existentes en todas las columnas del kanban dado
 * @param {string} [kanbanPath] - Ruta base del kanban (default: global)
 * @returns {number[]} - Array de IDs numéricos existentes
 */
function getAllExistingIds(kanbanPath = KANBAN_PATH) {
  const ids = [];

  for (const column of COLUMNS) {
    const colPath = path.join(kanbanPath, column);

    if (!fs.existsSync(colPath)) continue;

    const files = fs.readdirSync(colPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const match = file.match(/^(\d+)-/);
      if (match) {
        ids.push(parseInt(match[1], 10));
      }
    }
  }

  return ids;
}

/**
 * Genera el siguiente ID disponible en formato de 3 dígitos
 * @param {string} [kanbanPath] - Ruta base del kanban (default: global)
 * @returns {string} - Siguiente ID (ej: "001", "002", "042")
 */
function nextId(kanbanPath = KANBAN_PATH) {
  const existingIds = getAllExistingIds(kanbanPath);

  if (existingIds.length === 0) {
    return '001';
  }

  const maxId = Math.max(...existingIds);
  const nextNum = maxId + 1;

  return String(nextNum).padStart(3, '0');
}

module.exports = { nextId, getAllExistingIds };
