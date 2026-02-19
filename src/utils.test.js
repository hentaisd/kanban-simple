/**
 * utils.test.js - Tests para src/utils.js
 * Ejecutar con: node src/utils.test.js
 */

const assert = require('node:assert/strict');
const { slugify } = require('./utils');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓ ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\nslugify()');

test('string básico', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('string con tildes/acentos (español)', () => {
  assert.equal(slugify('Implementación de autenticación'), 'implementacion-de-autenticacion');
});

test('eñe y otros caracteres españoles', () => {
  assert.equal(slugify('Español y más opciones'), 'espanol-y-mas-opciones');
});

test('caracteres especiales son eliminados', () => {
  assert.equal(slugify('Fix bug #42: crash!'), 'fix-bug-42-crash');
});

test('múltiples espacios colapsan a un guión', () => {
  assert.equal(slugify('  hello   world  '), 'hello-world');
});

test('múltiples guiones colapsan a uno', () => {
  assert.equal(slugify('hello---world'), 'hello-world');
});

test('parámetro maxLength trunca el resultado', () => {
  const result = slugify('una cadena de texto bastante larga para probar', { maxLength: 20 });
  assert.ok(result.length <= 20, `length ${result.length} > 20`);
});

test('maxLength no termina en guión', () => {
  const result = slugify('hello-world-foo-bar', { maxLength: 11 });
  assert.ok(!result.endsWith('-'), `resultado termina en guión: "${result}"`);
});

test('string vacío retorna string vacío', () => {
  assert.equal(slugify(''), '');
});

test('valor nulo retorna string vacío', () => {
  assert.equal(slugify(null), '');
});

test('valor undefined retorna string vacío', () => {
  assert.equal(slugify(undefined), '');
});

test('solo caracteres especiales retorna string vacío', () => {
  assert.equal(slugify('!@#$%^&*()'), '');
});

console.log(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
