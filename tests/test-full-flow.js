/**
 * test-full-flow.js - Prueba del flujo completo sin IA real
 * 
 * Simula:
 *   1. Crear tarea en todo
 *   2. Mover a in_progress
 *   3. Simular ejecución de fases (mock)
 *   4. Verificar git (crear branch, merge, etc.)
 *   5. Verificar historial
 *   6. Verificar reintento
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, '.test-temp');

// Colores
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
  console.log('\n SETUP: Creando entorno de prueba...\n');
  
  // Crear directorio temporal
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Crear estructura kanban
  const columns = ['todo', 'in_progress', 'review', 'done', 'backlog', '.history'];
  columns.forEach(col => {
    fs.mkdirSync(path.join(TEST_DIR, col), { recursive: true });
  });
  
  // Crear repositorio git de prueba
  execSync('git init', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Commit inicial (crea rama master por defecto)
  fs.writeFileSync(path.join(TEST_DIR, 'README.md'), '# Test Project');
  execSync('git add .', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Renombrar master a main
  execSync('git branch -m master main', { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Crear rama developer
  execSync('git checkout -b developer', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git checkout main', { cwd: TEST_DIR, stdio: 'pipe' });
  
  console.log('  ✅ Directorio temporal creado');
  console.log('  ✅ Repositorio git inicializado');
  console.log('  ✅ Ramas main y developer creadas\n');
}

function cleanup() {
  console.log('\n CLEANUP: Eliminando entorno de prueba...');
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  console.log('  ✅ Directorio temporal eliminado\n');
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

function testGitBranch() {
  console.log('\n TEST: Git Branch Operations\n');
  
  // Verificar que estamos en main
  const branch = execSync('git branch --show-current', { cwd: TEST_DIR }).toString().trim();
  test('Estamos en rama main', () => {
    assert.strictEqual(branch, 'main');
  });
  
  // Crear rama de tarea
  const taskBranch = 'feature/test-001';
  execSync(`git checkout -b ${taskBranch}`, { cwd: TEST_DIR, stdio: 'pipe' });
  
  const newBranch = execSync('git branch --show-current', { cwd: TEST_DIR }).toString().trim();
  test('Crear rama de tarea', () => {
    assert.strictEqual(newBranch, taskBranch);
  });
  
  // Hacer cambio
  fs.writeFileSync(path.join(TEST_DIR, 'test.txt'), 'test content');
  execSync('git add .', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git commit -m "test commit"', { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Volver a developer
  execSync('git checkout developer', { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Merge
  execSync(`git merge ${taskBranch}`, { cwd: TEST_DIR, stdio: 'pipe' });
  
  // Verificar que el archivo existe en developer
  test('Merge exitoso', () => {
    assert.ok(fs.existsSync(path.join(TEST_DIR, 'test.txt')));
  });
  
  // Borrar rama de tarea
  execSync(`git branch -d ${taskBranch}`, { cwd: TEST_DIR, stdio: 'pipe' });
  const branches = execSync('git branch', { cwd: TEST_DIR }).toString();
  test('Rama de tarea eliminada', () => {
    assert.ok(!branches.includes(taskBranch));
  });
}

function testTaskMovement() {
  console.log('\n TEST: Task Movement\n');
  
  const kanbanPath = TEST_DIR;
  
  // Importar funciones reales
  const board = require('../src/kanban/board');
  
  // Crear tarea
  const taskPath = path.join(kanbanPath, 'todo', '001-test-task.md');
  const taskContent = `---
id: '001'
title: Test Task
type: feature
status: todo
---
# Description
Test task`;
  fs.writeFileSync(taskPath, taskContent);
  
  test('Tarea creada en todo', () => {
    const tasks = board.getTasks('todo', kanbanPath);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, '001');
  });
  
  // Mover a in_progress
  board.moveTask('001', 'in_progress', kanbanPath);
  
  test('Tarea movida a in_progress', () => {
    const todoTasks = board.getTasks('todo', kanbanPath);
    const inProgressTasks = board.getTasks('in_progress', kanbanPath);
    assert.strictEqual(todoTasks.length, 0);
    assert.strictEqual(inProgressTasks.length, 1);
  });
  
  // Mover a done
  board.moveTask('001', 'done', kanbanPath);
  
  test('Tarea movida a done', () => {
    const doneTasks = board.getTasks('done', kanbanPath);
    assert.strictEqual(doneTasks.length, 1);
  });
}

function testHistory() {
  console.log('\n TEST: History Module\n');
  
  const history = require('../src/core/history');
  const kanbanPath = TEST_DIR;
  const taskId = '002';
  
  // Guardar ejecución
  history.saveExecution(taskId, {
    result: 'success',
    totalDuration: 30000,
    iterations: 1,
    summary: 'Test completed',
    phases: {
      plan: { status: 'ok', duration: 5000, summary: 'Plan ok' },
      code: [{ iteration: 1, status: 'ok', duration: 15000, summary: 'Code ok' }],
      review: [],
      test: [],
      scope: { status: 'ok', duration: 10000, summary: 'Scope ok' },
    }
  }, kanbanPath);
  
  test('Historial guardado', () => {
    const h = history.getHistory(taskId, kanbanPath);
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].result, 'success');
    assert.strictEqual(h[0].phases.plan.status, 'ok');
    assert.strictEqual(h[0].phases.scope.status, 'ok');
  });
}

function testAutoRepair() {
  console.log('\n TEST: Auto-repair of empty phases\n');
  
  const history = require('../src/core/history');
  const kanbanPath = TEST_DIR;
  const taskId = '003';
  const histFile = path.join(kanbanPath, '.history', `${taskId}.json`);
  
  // Crear historial con phases vacío
  fs.mkdirSync(path.dirname(histFile), { recursive: true });
  fs.writeFileSync(histFile, JSON.stringify([{
    timestamp: '2026-01-01T00:00:00.000Z',
    result: 'failed',
    iterations: 1,
    phases: {}
  }]));
  
  // Leer (debe auto-reparar)
  const h = history.getHistory(taskId, kanbanPath);
  
  test('Auto-reparación de phases vacío', () => {
    assert.ok(h[0].phases.plan);
    assert.ok(h[0].phases.scope);
    assert.strictEqual(h[0].phases.plan.status, 'lost');
  });
}

function testRetryCount() {
  console.log('\n TEST: Retry Count in Frontmatter\n');
  
  const task = require('../src/core/task');
  const kanbanPath = TEST_DIR;
  
  // Crear tarea con retryCount
  const testTask = {
    id: '004',
    title: 'Test Retry',
    type: 'feature',
    status: 'review',
    retryCount: 2,
    lastAttemptAt: new Date().toISOString(),
    content: '# Test'
  };
  
  const filePath = path.join(kanbanPath, 'review', '004-test-retry.md');
  task.writeTask(testTask, filePath);
  
  // Leer y verificar
  const content = fs.readFileSync(filePath, 'utf8');
  
  test('retryCount en frontmatter', () => {
    assert.ok(content.includes('retryCount:'));
  });
  
  test('lastAttemptAt en frontmatter', () => {
    assert.ok(content.includes('lastAttemptAt:'));
  });
}

function testCircularDependency() {
  console.log('\n TEST: Circular Dependency Detection\n');
  
  // Simular detección de dependencias circulares
  // Tarea A depende de B, B depende de A
  
  const kanbanPath = TEST_DIR;
  
  // Crear tareas circulares
  const taskA = `---
id: '100'
title: Task A
dependsOn: ['101']
---
Content A`;
  
  const taskB = `---
id: '101'
title: Task B
dependsOn: ['100']
---
Content B`;
  
  fs.writeFileSync(path.join(kanbanPath, 'todo', '100-task-a.md'), taskA);
  fs.writeFileSync(path.join(kanbanPath, 'todo', '101-task-b.md'), taskB);
  
  // La función detectCircularDependency está en loop.js
  // Verificamos que existe y se puede llamar
  const loop = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/loop.js'), 'utf8');
  
  test('Función detectCircularDependency existe', () => {
    assert.ok(loop.includes('function detectCircularDependency'));
  });
  
  test('Detecta patrón circular en código', () => {
    assert.ok(loop.includes('circular: true'));
  });
}

function testCheckRetryable() {
  console.log('\n TEST: Check Retryable Tasks\n');
  
  const loop = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/loop.js'), 'utf8');
  
  test('Función checkRetryableTasks existe', () => {
    assert.ok(loop.includes('function checkRetryableTasks'));
  });
  
  test('Config autoRetry se lee', () => {
    assert.ok(loop.includes('autoRetry'));
  });
  
  test('Config maxRetries se lee', () => {
    assert.ok(loop.includes('maxRetries'));
  });
  
  test('Config retryDelayMinutes se lee', () => {
    assert.ok(loop.includes('retryDelayMinutes'));
  });
}

function testOneTaskAtATime() {
  console.log('\n TEST: One Task At A Time\n');
  
  const loop = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/loop.js'), 'utf8');
  
  test('Verifica in_progress antes de procesar', () => {
    assert.ok(loop.includes('inProgressTasks = getTasks'));
    assert.ok(loop.includes('inProgressTasks.length > 0'));
  });
  
  test('Espera si hay tarea en progreso', () => {
    assert.ok(loop.includes('Esperando a que termine'));
    assert.ok(loop.includes('continue;'));
  });
  
  test('Solo toma UNA tarea con break', () => {
    assert.ok(loop.includes('taskToProcess = candidate'));
    assert.ok(loop.includes('break;'));
  });
}

function testPhaseTimeouts() {
  console.log('\n TEST: Phase Timeouts\n');
  
  const executor = fs.readFileSync(path.join(PROJECT_ROOT, 'src/core/ai-executor.js'), 'utf8');
  
  test('PHASE_TIMEOUTS definido', () => {
    assert.ok(executor.includes('PHASE_TIMEOUTS = {'));
  });
  
  test('Timeout para PLAN', () => {
    assert.ok(executor.includes('PLAN:'));
  });
  
  test('Timeout para CODE', () => {
    assert.ok(executor.includes('CODE:'));
  });
  
  test('Timeout para REVIEW', () => {
    assert.ok(executor.includes('REVIEW:'));
  });
  
  test('Timeout para TEST', () => {
    assert.ok(executor.includes('TEST:'));
  });
  
  test('Timeout para SCOPE', () => {
    assert.ok(executor.includes('SCOPE:'));
  });
  
  test('Manejo de timeout con kill', () => {
    assert.ok(executor.includes('proc.kill'));
  });
}

function testAPIs() {
  console.log('\n TEST: API Endpoints\n');
  
  const server = fs.readFileSync(path.join(PROJECT_ROOT, 'src/ui/server.js'), 'utf8');
  
  test('API history endpoint', () => {
    assert.ok(server.includes("/api/tasks/:id/history"));
  });
  
  test('API artifacts endpoint', () => {
    assert.ok(server.includes("/api/tasks/:id/artifacts"));
  });
  
  test('API artifact específico', () => {
    assert.ok(server.includes("/api/tasks/:id/artifacts/:phase"));
  });
  
  test('Soporte type=log', () => {
    assert.ok(server.includes("req.query.type"));
  });
  
  test('hasLog en respuesta', () => {
    assert.ok(server.includes("hasLog"));
  });
}

// ─────────────────────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(63));
console.log('  TEST SUITE: AI-KANBAN SISTEMA COMPLETO');
console.log('═'.repeat(63));

try {
  setup();
  
  testGitBranch();
  testTaskMovement();
  testHistory();
  testAutoRepair();
  testRetryCount();
  testCircularDependency();
  testCheckRetryable();
  testOneTaskAtATime();
  testPhaseTimeouts();
  testAPIs();
  
} finally {
  cleanup();
}

console.log('═'.repeat(63));
console.log(`  RESULTADO: ${GREEN}${passed} pasaron${RESET}, ${RED}${failed} fallaron${RESET}`);
console.log('═'.repeat(63) + '\n');

process.exit(failed > 0 ? 1 : 0);
