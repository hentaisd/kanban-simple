/**
 * id-generator.js - Generador de IDs secuenciales para tareas
 */

const fs = require('fs');
const path = require('path');
const { KANBAN_PATH, COLUMNS } = require('./task');

/**
 * Obtiene todos los IDs existentes en todas las columnas del kanban
 * @returns {number[]} - Array de IDs numéricos existentes
 */
function getAllExistingIds() {
  const ids = [];

  for (const column of COLUMNS) {
    const colPath = path.join(KANBAN_PATH, column);

    if (!fs.existsSync(colPath)) continue;

    const files = fs.readdirSync(colPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      // Los archivos tienen formato: 001-titulo-slug.md
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
 * @returns {string} - Siguiente ID (ej: "001", "002", "042")
 */
function nextId() {
  const existingIds = getAllExistingIds();

  if (existingIds.length === 0) {
    return '001';
  }

  const maxId = Math.max(...existingIds);
  const nextNum = maxId + 1;

  return String(nextNum).padStart(3, '0');
}

module.exports = { nextId, getAllExistingIds };
