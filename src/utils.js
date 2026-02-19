/**
 * utils.js - Utilidades compartidas del proyecto
 */

/**
 * Convierte un texto en un slug URL-friendly.
 * Normaliza acentos/tildes, elimina caracteres especiales y colapsa separadores.
 *
 * @param {string} text - Texto a convertir
 * @param {Object} [options={}] - Opciones
 * @param {number} [options.maxLength] - Longitud máxima del slug resultante
 * @returns {string} - Slug generado
 */
function slugify(text, options = {}) {
  if (!text || typeof text !== 'string') return '';

  let slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes/acentos
    .replace(/[^a-z0-9\s-]/g, '')   // eliminar caracteres especiales
    .trim()
    .replace(/[\s-]+/g, '-');        // colapsar espacios y guiones

  if (options.maxLength && slug.length > options.maxLength) {
    slug = slug.slice(0, options.maxLength).replace(/-+$/, '');
  }

  return slug;
}

module.exports = { slugify };
