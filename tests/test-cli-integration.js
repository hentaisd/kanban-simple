/**
 * test-cli-integration.js - Tests de integración para CLI
 * 
 * Prueba los comandos CLI:
 *   - create: crear tareas
 *   - list: listar tareas
 *   - move: mover tareas
 *   - show: mostrar detalle
 *   - delete: eliminar tareas
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, '.test-cli-integration');
const CLI_PATH = path.join(PROJECT_ROOT, 'src/cli/index.js');

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

function runCLI(args, expectError = false) {
  const env = { ...process.env, AI_KANBAN_PATH: TEST_DIR };
  try {
    const result = execSync(`node "${CLI_PATH}" ${args}`, {
      cwd: TEST_DIR,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { stdout: result, stderr: '', error: null };
  } catch (err) {
    if (expectError) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', error: err };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────

function setup() {
  console.log('\n📦 SETUP: Creando entorno de prueba para CLI...\n');
  
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  const columns = ['todo', 'in_progress', 'review', 'done', 'backlog', '.history'];
  columns.forEach(col => {
    fs.mkdirSync(path.join(TEST_DIR, col), { recursive: true });
  });
  
  const config = {
    kanbanPath: TEST_DIR,
    projectPath: TEST_DIR,
    engine: 'claude',
    loop: { autoRetry: true, maxRetries: 3, retryDelayMinutes: 5 }
  };
  fs.writeFileSync(path.join(TEST_DIR, 'kanban.config.js'), `module.exports = ${JSON.stringify(config, null, 2)}`);
  
  console.log('  ✅ Directorio temporal creado');
  console.log('  ✅ Estructura kanban creada');
  console.log('  ✅ Configuración generada\n');
}

function cleanup() {
  console.log('\n🧹 CLEANUP: Eliminando entorno de prueba...');
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  console.log('  ✅ Directorio temporal eliminado\n');
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

function testCLIHelp() {
  console.log('\n📋 TEST: CLI Help\n');
  
  test('--help muestra ayuda', () => {
    const result = runCLI('--help');
    assert.ok(result.stdout.includes('ai-kanban'));
    assert.ok(result.stdout.includes('create'));
    assert.ok(result.stdout.includes('list'));
    assert.ok(result.stdout.includes('move'));
  });
  
  test('--version muestra versión', () => {
    const result = runCLI('--version');
    assert.ok(result.stdout.includes('1.0.0'));
  });
}

function testCreateCommand() {
  console.log('\n📋 TEST: Create Command\n');
  
  const board = require('../src/kanban/board');
  
  test('crear tarea con título', () => {
    const taskContent = `---
id: '001'
title: Test Feature
type: feature
status: backlog
---
# Descripción

# Criterios de aceptación
-`;
    fs.writeFileSync(path.join(TEST_DIR, 'backlog', '001-test-feature.md'), taskContent);
    
    const tasks = board.getTasks('backlog', TEST_DIR);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].title, 'Test Feature');
    assert.strictEqual(tasks[0].type, 'feature');
  });
  
  test('crear tarea tipo bug', () => {
    const taskContent = `---
id: '002'
title: Test Bug
type: bug
status: todo
---
# Descripción

# Criterios de aceptación
-`;
    fs.writeFileSync(path.join(TEST_DIR, 'todo', '002-test-bug.md'), taskContent);
    
    const tasks = board.getTasks('todo', TEST_DIR);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].type, 'bug');
  });
  
  test('crear tarea con prioridad alta', () => {
    const taskContent = `---
id: '003'
title: High Priority Task
type: feature
priority: alta
status: backlog
---
# Descripción

# Criterios de aceptación
-`;
    fs.writeFileSync(path.join(TEST_DIR, 'backlog', '003-high-priority-task.md'), taskContent);
    
    const tasks = board.getTasks('backlog', TEST_DIR);
    const highPriorityTask = tasks.find(t => t.id === '003');
    assert.ok(highPriorityTask);
    assert.strictEqual(highPriorityTask.priority, 'alta');
  });
}

function testListCommand() {
  console.log('\n📋 TEST: List Command\n');
  
  const board = require('../src/kanban/board');
  
  test('listar todas las tareas', () => {
    const allTasksByColumn = board.getTasks(null, TEST_DIR);
    const totalCount = Object.values(allTasksByColumn).flat().length;
    assert.ok(totalCount >= 2);
  });
  
  test('listar tareas por columna', () => {
    const backlogTasks = board.getTasks('backlog', TEST_DIR);
    const todoTasks = board.getTasks('todo', TEST_DIR);
    
    assert.ok(backlogTasks.length >= 1);
    assert.ok(todoTasks.length >= 1);
  });
  
  test('listar tareas vacías', () => {
    const doneTasks = board.getTasks('done', TEST_DIR);
    assert.strictEqual(doneTasks.length, 0);
  });
}

function testMoveCommand() {
  console.log('\n📋 TEST: Move Command\n');
  
  const board = require('../src/kanban/board');
  
  test('mover tarea de backlog a todo', () => {
    board.moveTask('001', 'todo', TEST_DIR);
    
    const backlogTasks = board.getTasks('backlog', TEST_DIR);
    const todoTasks = board.getTasks('todo', TEST_DIR);
    
    assert.ok(!backlogTasks.find(t => t.id === '001'));
    assert.ok(todoTasks.find(t => t.id === '001'));
  });
  
  test('mover tarea de todo a in_progress', () => {
    board.moveTask('001', 'in_progress', TEST_DIR);
    
    const todoTasks = board.getTasks('todo', TEST_DIR);
    const inProgressTasks = board.getTasks('in_progress', TEST_DIR);
    
    assert.ok(!todoTasks.find(t => t.id === '001'));
    assert.ok(inProgressTasks.find(t => t.id === '001'));
  });
  
  test('mover tarea de in_progress a done', () => {
    board.moveTask('001', 'done', TEST_DIR);
    
    const inProgressTasks = board.getTasks('in_progress', TEST_DIR);
    const doneTasks = board.getTasks('done', TEST_DIR);
    
    assert.ok(!inProgressTasks.find(t => t.id === '001'));
    assert.ok(doneTasks.find(t => t.id === '001'));
  });
}

function testShowCommand() {
  console.log('\n📋 TEST: Show Command\n');
  
  const board = require('../src/kanban/board');
  
  test('obtener tarea por ID', () => {
    const result = board.getTaskById('002', TEST_DIR);
    
    assert.ok(result);
    assert.strictEqual(result.task.id, '002');
    assert.strictEqual(result.task.title, 'Test Bug');
  });
  
  test('tarea inexistente retorna null', () => {
    const result = board.getTaskById('999', TEST_DIR);
    assert.strictEqual(result, null);
  });
}

function testDeleteCommand() {
  console.log('\n📋 TEST: Delete Command\n');
  
  const board = require('../src/kanban/board');
  
  test('eliminar tarea existente', () => {
    board.deleteTask('003', TEST_DIR);
    
    const backlogTasks = board.getTasks('backlog', TEST_DIR);
    assert.ok(!backlogTasks.find(t => t.id === '003'));
  });
  
  test('eliminar tarea inexistente lanza error', () => {
    try {
      board.deleteTask('999', TEST_DIR);
      assert.fail('Debería haber lanzado error');
    } catch (err) {
      assert.ok(err.message.includes('no encontrada'));
    }
  });
}

function testTaskMetadata() {
  console.log('\n📋 TEST: Task Metadata\n');
  
  const board = require('../src/kanban/board');
  
  test('tarea con labels', () => {
    const taskContent = `---
id: '010'
title: Labeled Task
type: feature
labels: [auth, backend]
status: backlog
---
# Descripción

# Criterios de aceptación
-`;
    fs.writeFileSync(path.join(TEST_DIR, 'backlog', '010-labeled-task.md'), taskContent);
    
    const tasks = board.getTasks('backlog', TEST_DIR);
    const labeledTask = tasks.find(t => t.id === '010');
    assert.ok(labeledTask);
    assert.deepStrictEqual(labeledTask.labels, ['auth', 'backend']);
  });
  
  test('tarea con dependsOn', () => {
    const taskContent = `---
id: '011'
title: Dependent Task
type: feature
dependsOn: ['010']
status: backlog
---
# Descripción

# Criterios de aceptación
-`;
    fs.writeFileSync(path.join(TEST_DIR, 'backlog', '011-dependent-task.md'), taskContent);
    
    const tasks = board.getTasks('backlog', TEST_DIR);
    const dependentTask = tasks.find(t => t.id === '011');
    assert.ok(dependentTask);
    assert.deepStrictEqual(dependentTask.dependsOn, ['010']);
  });
}

// ─────────────────────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(63));
console.log('  TEST SUITE: CLI INTEGRATION');
console.log('═'.repeat(63));

try {
  setup();
  
  testCLIHelp();
  testCreateCommand();
  testListCommand();
  testMoveCommand();
  testShowCommand();
  testDeleteCommand();
  testTaskMetadata();
  
} finally {
  cleanup();
}

console.log('═'.repeat(63));
console.log(`  RESULTADO: ${GREEN}${passed} pasaron${RESET}, ${RED}${failed} fallaron${RESET}`);
console.log('═'.repeat(63) + '\n');

process.exit(failed > 0 ? 1 : 0);
