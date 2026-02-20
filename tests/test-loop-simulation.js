/**
 * test-loop-simulation.js - Simula el loop completo sin IA real
 * 
 * Mockea executeTask para simular respuestas de IA
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, '.test-loop');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}✅ ${name}${RESET}`);
    passed++;
  } catch (err) {
    console.log(`${RED}❌ ${name}${RESET}`);
    console.log(`   Error: ${err.message}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────

function setup() {
  console.log('\n SETUP: Creando entorno de prueba para loop...\n');
  
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Estructura kanban
  const columns = ['todo', 'in_progress', 'review', 'done', 'backlog', '.history'];
  columns.forEach(col => {
    fs.mkdirSync(path.join(TEST_DIR, col), { recursive: true });
  });
  
  // Git repo
  execSync('git init', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: TEST_DIR, stdio: 'pipe' });
  fs.writeFileSync(path.join(TEST_DIR, 'README.md'), '# Test');
  execSync('git add .', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git commit -m "Initial"', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git branch -m master main', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git checkout -b developer', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git checkout main', { cwd: TEST_DIR, stdio: 'pipe' });
  
  console.log('  ✅ Entorno listo\n');
}

function cleanup() {
  console.log('\n CLEANUP...');
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  console.log('  ✅ Listo\n');
}

// ─────────────────────────────────────────────────────────────
// SIMULACIÓN DE PROCESSTASK
// ─────────────────────────────────────────────────────────────

function simulateProcessTask(task, kanbanPath) {
  const board = require('../src/kanban/board');
  const history = require('../src/core/history');
  const taskMod = require('../src/core/task');
  
  const now = new Date().toISOString();
  
  // PASO 1: Mover a in_progress
  board.moveTask(task.id, 'in_progress', kanbanPath);
  console.log(`  [1/6] ${task.id}: todo → in_progress`);
  
  // PASO 2: Simular creación de rama
  const branch = task.branch || `feature/task-${task.id}`;
  try {
    execSync(`git checkout -b ${branch}`, { cwd: TEST_DIR, stdio: 'pipe' });
    console.log(`  [2/6] Git: creado branch ${branch}`);
  } catch (e) {
    // Branch ya existe
    execSync(`git checkout ${branch}`, { cwd: TEST_DIR, stdio: 'pipe' });
    console.log(`  [2/6] Git: checkout branch existente ${branch}`);
  }
  
  // PASO 3: Simular ejecución de IA (mock)
  console.log(`  [3/6] IA: Simulando ejecución...`);
  
  // Hacer cambios simulados
  fs.writeFileSync(path.join(TEST_DIR, `${task.id}.txt`), `Task ${task.id} completed`);
  execSync('git add .', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync(`git commit -m "feat(${task.id}): ${task.title}"`, { cwd: TEST_DIR, stdio: 'pipe' });
  console.log(`  [3/6] IA: Cambios simulados y commiteados`);
  
  // PASO 4: Merge
  execSync('git checkout developer', { cwd: TEST_DIR, stdio: 'pipe' });
  try {
    execSync(`git merge ${branch}`, { cwd: TEST_DIR, stdio: 'pipe' });
    console.log(`  [4/6] Git: merge ${branch} → developer`);
    execSync(`git branch -d ${branch}`, { cwd: TEST_DIR, stdio: 'pipe' });
    console.log(`  [4/6] Git: branch ${branch} eliminado`);
  } catch (e) {
    console.log(`  [4/6] Git: merge falló, abortando`);
    execSync('git merge --abort', { cwd: TEST_DIR, stdio: 'pipe' });
    execSync('git checkout developer', { cwd: TEST_DIR, stdio: 'pipe' });
    return { success: false, reason: 'Merge conflict' };
  }
  
  // PASO 5: Mover a done
  board.moveTask(task.id, 'done', kanbanPath);
  console.log(`  [5/6] ${task.id}: in_progress → done`);
  
  // PASO 6: Guardar historial
  history.saveExecution(task.id, {
    result: 'success',
    totalDuration: 30000,
    iterations: 1,
    summary: `Task ${task.id} completed (simulated)`,
    phases: {
      plan: { status: 'ok', duration: 5000, summary: 'Mock plan' },
      code: [{ iteration: 1, status: 'ok', duration: 15000, summary: 'Mock code' }],
      review: [],
      test: [],
      scope: { status: 'ok', duration: 10000, summary: 'Mock scope' },
    }
  }, kanbanPath);
  console.log(`  [6/6] Historial guardado`);
  
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

function testFullLoop() {
  console.log('\n TEST: Full Loop Simulation\n');
  
  const board = require('../src/kanban/board');
  const history = require('../src/core/history');
  
  // Crear tarea
  const taskPath = path.join(TEST_DIR, 'todo', '001-loop-test.md');
  fs.writeFileSync(taskPath, `---
id: '001'
title: Loop Test Task
type: feature
branch: feature/loop-test
status: todo
---
# Description
Test the full loop`);
  
  // Verificar tarea creada
  const todoBefore = board.getTasks('todo', TEST_DIR);
  test('Tarea en todo antes de procesar', () => {
    assert.strictEqual(todoBefore.length, 1);
  });
  
  // Procesar tarea (simulado)
  const task = todoBefore[0];
  const result = simulateProcessTask(task, TEST_DIR);
  
  test('Procesamiento exitoso', () => {
    assert.strictEqual(result.success, true);
  });
  
  // Verificar estado final
  const todoAfter = board.getTasks('todo', TEST_DIR);
  const doneAfter = board.getTasks('done', TEST_DIR);
  
  test('Todo vacío después de procesar', () => {
    assert.strictEqual(todoAfter.length, 0);
  });
  
  test('Tarea en done después de procesar', () => {
    assert.strictEqual(doneAfter.length, 1);
    assert.strictEqual(doneAfter[0].id, '001');
  });
  
  // Verificar historial
  const h = history.getHistory('001', TEST_DIR);
  test('Historial guardado con phases', () => {
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].result, 'success');
    assert.ok(h[0].phases.plan);
    assert.ok(h[0].phases.code);
    assert.ok(h[0].phases.scope);
  });
  
  // Verificar que el archivo se creó
  test('Archivo de tarea creado en repo', () => {
    assert.ok(fs.existsSync(path.join(TEST_DIR, '001.txt')));
  });
  
  // Verificar rama actual
  const branch = execSync('git branch --show-current', { cwd: TEST_DIR }).toString().trim();
  test('Volvimos a developer', () => {
    assert.strictEqual(branch, 'developer');
  });
}

function testMultipleTasks() {
  console.log('\n TEST: Multiple Tasks Sequential\n');
  
  const board = require('../src/kanban/board');
  
  // Crear 3 tareas
  for (let i = 2; i <= 4; i++) {
    const id = String(i).padStart(3, '0');
    const taskPath = path.join(TEST_DIR, 'todo', `${id}-task.md`);
    fs.writeFileSync(taskPath, `---
id: '${id}'
title: Task ${id}
type: feature
branch: feature/task-${id}
status: todo
---
Content ${id}`);
  }
  
  const todoBefore = board.getTasks('todo', TEST_DIR);
  test('3 tareas en todo', () => {
    assert.strictEqual(todoBefore.length, 3);
  });
  
  // Procesar una por una
  for (let i = 0; i < 3; i++) {
    const tasks = board.getTasks('todo', TEST_DIR);
    if (tasks.length > 0) {
      console.log(`\n  Procesando tarea ${i + 1}/3...`);
      simulateProcessTask(tasks[0], TEST_DIR);
    }
  }
  
  const todoAfter = board.getTasks('todo', TEST_DIR);
  const doneAfter = board.getTasks('done', TEST_DIR);
  
  test('Todo vacío después de procesar 3 tareas', () => {
    assert.strictEqual(todoAfter.length, 0);
  });
  
  test('3 tareas en done', () => {
    assert.strictEqual(doneAfter.length, 4); // 1 de antes + 3 nuevas
  });
}

function testRetryMechanism() {
  console.log('\n TEST: Retry Mechanism\n');
  
  const board = require('../src/kanban/board');
  const task = require('../src/core/task');
  
  // Crear tarea fallida en review
  const taskPath = path.join(TEST_DIR, 'review', '099-retry.md');
  fs.writeFileSync(taskPath, `---
id: '099'
title: Failed Task
type: feature
status: review
retryCount: 1
lastAttemptAt: '2026-01-01T00:00:00.000Z'
---
Failed task`);
  
  // Verificar que está en review
  const reviewBefore = board.getTasks('review', TEST_DIR);
  test('Tarea en review con retryCount', () => {
    assert.strictEqual(reviewBefore.length, 1);
    assert.strictEqual(reviewBefore[0].retryCount, 1);
  });
  
  // Simular checkRetryableTasks
  const loop = require('../src/core/loop');
  const config = { loop: { autoRetry: true, maxRetries: 3, retryDelayMinutes: 5 } };
  
  // Verificar que la función existe y funciona
  const retryable = loop.checkRetryableTasks(TEST_DIR, config.loop);
  
  test('checkRetryableTasks detecta tarea reintentable', () => {
    assert.strictEqual(retryable.length, 1);
    assert.strictEqual(retryable[0].task.id, '099');
  });
  
  // Simular reintento
  loop.moveTaskToRetry(reviewBefore[0], TEST_DIR);
  
  const todoAfter = board.getTasks('todo', TEST_DIR);
  const reviewAfter = board.getTasks('review', TEST_DIR);
  
  test('Tarea movida de review a todo para reintento', () => {
    // Como ya procesamos las otras tareas, solo debería estar esta
    assert.ok(todoAfter.some(t => t.id === '099'));
  });
  
  test('review vacío o sin la tarea reintentada', () => {
    assert.ok(!reviewAfter.some(t => t.id === '099'));
  });
}

// ─────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(63));
console.log('  TEST: LOOP SIMULATION');
console.log('═'.repeat(63));

try {
  setup();
  testFullLoop();
  testMultipleTasks();
  testRetryMechanism();
} finally {
  cleanup();
}

console.log('═'.repeat(63));
console.log(`  RESULTADO: ${GREEN}${passed} pasaron${RESET}, ${RED}${failed} fallaron${RESET}`);
console.log('═'.repeat(63) + '\n');

process.exit(failed > 0 ? 1 : 0);
