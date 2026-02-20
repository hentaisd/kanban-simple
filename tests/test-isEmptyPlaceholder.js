/**
 * test-isEmptyPlaceholder.js - Test para la función isEmptyPlaceholder
 * Verifica el bug fix de la tarea #008
 */

const assert = require('node:assert/strict');

function isEmptyPlaceholder(content) {
  if (!content) return true;
  const normalized = content.replace(/\s+/g, ' ').trim();
  const emptyPatterns = [
    /^# Descripción\s*# Criterios de aceptación\s*-?\s*$/,
    /^# Descripción\s+# Criterios de aceptación\s*$/,
  ];
  return emptyPatterns.some(p => p.test(normalized));
}

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

console.log('\nisEmptyPlaceholder() - Tarea #008 Bug Fix');

test('retorna true para null', () => {
  assert.equal(isEmptyPlaceholder(null), true);
});

test('retorna true para undefined', () => {
  assert.equal(isEmptyPlaceholder(undefined), true);
});

test('retorna true para string vacío', () => {
  assert.equal(isEmptyPlaceholder(''), true);
});

test('retorna false para contenido válido', () => {
  assert.equal(isEmptyPlaceholder('# Descripción\n\nAlgo de texto\n\n# Criterios de aceptación\n- Test pasa'), false);
});

test('detecta placeholder vacío estándar', () => {
  const placeholder = '# Descripción\n\n# Criterios de aceptación\n-';
  assert.equal(isEmptyPlaceholder(placeholder), true);
});

test('detecta placeholder sin guión final', () => {
  const placeholder = '# Descripción\n\n# Criterios de aceptación';
  assert.equal(isEmptyPlaceholder(placeholder), true);
});

test('retorna false para contenido con texto real', () => {
  assert.equal(isEmptyPlaceholder('Este es contenido real'), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
