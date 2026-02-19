/**
 * cache.js - Módulo de caché Redis con fallback graceful
 * Si Redis no está disponible, opera sin caché (fallback a filesystem directo)
 */

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEFAULT_TTL = 30; // segundos

let client = null;
let isConnected = false;

/**
 * Conecta al servidor Redis. Si falla, el sistema opera sin caché.
 */
async function connect() {
  try {
    client = createClient({ url: REDIS_URL });

    client.on('error', (err) => {
      if (isConnected) {
        console.warn('[cache] Redis error:', err.message);
        isConnected = false;
      }
    });

    client.on('ready', () => {
      isConnected = true;
      console.log(`[cache] Redis conectado en ${REDIS_URL}`);
    });

    client.on('reconnecting', () => {
      console.log('[cache] Redis reconectando...');
    });

    client.on('end', () => {
      isConnected = false;
    });

    await client.connect();
  } catch (err) {
    console.warn(`[cache] Redis no disponible (${err.message}), operando sin caché`);
    client = null;
    isConnected = false;
  }
}

/**
 * Obtiene un valor del caché
 * @param {string} key
 * @returns {*|null} - Valor parseado o null si no existe / Redis no disponible
 */
async function get(key) {
  if (!isConnected || !client) return null;
  try {
    const value = await client.get(key);
    return value !== null ? JSON.parse(value) : null;
  } catch (err) {
    console.warn('[cache] Error en get:', err.message);
    return null;
  }
}

/**
 * Guarda un valor en el caché
 * @param {string} key
 * @param {*} value - Será serializado a JSON
 * @param {number} ttl - Tiempo de vida en segundos (default: 30)
 */
async function set(key, value, ttl = DEFAULT_TTL) {
  if (!isConnected || !client) return;
  try {
    await client.setEx(key, ttl, JSON.stringify(value));
  } catch (err) {
    console.warn('[cache] Error en set:', err.message);
  }
}

/**
 * Elimina una o varias claves del caché
 * @param {string|string[]} keys
 */
async function del(keys) {
  if (!isConnected || !client) return;
  const keyList = Array.isArray(keys) ? keys : [keys];
  if (keyList.length === 0) return;
  try {
    await client.del(keyList);
  } catch (err) {
    console.warn('[cache] Error en del:', err.message);
  }
}

/**
 * Elimina todas las claves de la base de datos Redis actual
 */
async function flush() {
  if (!isConnected || !client) return;
  try {
    await client.flushDb();
  } catch (err) {
    console.warn('[cache] Error en flush:', err.message);
  }
}

/**
 * Retorna el estado de conexión del caché
 * @returns {{ connected: boolean, url: string }}
 */
function getStatus() {
  return { connected: isConnected, url: REDIS_URL };
}

module.exports = { connect, get, set, del, flush, getStatus };
