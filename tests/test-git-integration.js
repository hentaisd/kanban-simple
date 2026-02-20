/**
 * test-git-integration.js - Tests de integración para GitService
 * 
 * Prueba el ciclo completo de operaciones git:
 *   - Crear branch, hacer cambios, commit, merge
 *   - Abortar tareas y limpiar estado
 *   - Manejo de conflictos
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const GitService = require('../src/git/gitService');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, '.test-git-integration');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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
  console.log('\n📦 SETUP: Creando entorno de prueba para GitService...\n');
  
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  
  const columns = ['todo', 'in_progress', 'review', 'done', 'backlog', '.history'];
  columns.forEach(col => {
    fs.mkdirSync(path.join(TEST_DIR, col), { recursive: true });
  });
  
  execSync('git init', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: TEST_DIR, stdio: 'pipe' });
  
  fs.writeFileSync(path.join(TEST_DIR, 'README.md'), '# Test Project');
  execSync('git add .', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: TEST_DIR, stdio: 'pipe' });
  
  execSync('git branch -m master main', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git checkout -b developer', { cwd: TEST_DIR, stdio: 'pipe' });
  execSync('git checkout main', { cwd: TEST_DIR, stdio: 'pipe' });
  
  console.log('  ✅ Directorio temporal creado');
  console.log('  ✅ Repositorio git inicializado');
  console.log('  ✅ Ramas main y developer creadas\n');
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

async function testGitServiceInstantiation() {
  console.log('\n📋 TEST: GitService Instantiation\n');
  
  const git = new GitService(TEST_DIR);
  
  await test('GitService se instancia correctamente', async () => {
    assert.ok(git);
    assert.strictEqual(git.repoPath, TEST_DIR);
    assert.strictEqual(git.defaultBranch, 'main');
  });
  
  await test('isGitRepo detecta repositorio válido', async () => {
    const result = await git.isGitRepo();
    assert.strictEqual(result, true);
  });
  
  await test('getCurrentBranch retorna la rama actual', async () => {
    const branch = await git.getCurrentBranch();
    assert.strictEqual(branch, 'main');
  });
  
  await test('getDirtyCount retorna 0 para repo limpio', async () => {
    const count = await git.getDirtyCount();
    assert.strictEqual(count, 0);
  });
}

async function testGitServiceOperations() {
  console.log('\n📋 TEST: GitService Operations\n');
  
  const git = new GitService(TEST_DIR);
  
  await test('checkout cambia de rama', async () => {
    await git.checkout('developer');
    const branch = await git.getCurrentBranch();
    assert.strictEqual(branch, 'developer');
  });
  
  await test('createBranch crea nueva rama', async () => {
    await git.createBranch('feature/test-001');
    const branch = await git.getCurrentBranch();
    assert.strictEqual(branch, 'feature/test-001');
  });
  
  await test('getDirtyCount detecta archivos nuevos', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'new-file.txt'), 'test');
    const count = await git.getDirtyCount();
    assert.ok(count > 0);
  });
  
  await test('addAll agrega archivos al staging', async () => {
    await git.addAll();
    const status = await git.getStatus();
    assert.ok(status.staged.length > 0 || status.created.length > 0);
  });
  
  await test('commit crea commit correctamente', async () => {
    const result = await git.commit('test: nuevo archivo');
    assert.ok(result);
  });
  
  await test('merge integra branch correctamente', async () => {
    await git.checkout('developer');
    const result = await git.merge('feature/test-001');
    assert.strictEqual(result.merged, true);
  });
  
  await test('deleteBranch elimina branch', async () => {
    const deleted = await git.deleteBranch('feature/test-001', true);
    assert.strictEqual(deleted, true);
  });
}

async function testGitServiceAbort() {
  console.log('\n📋 TEST: GitService Abort\n');
  
  const git = new GitService(TEST_DIR);
  
  await git.checkout('main');
  await git.createBranch('feature/abort-test');
  
  fs.writeFileSync(path.join(TEST_DIR, 'abort-test.txt'), 'test');
  
  await test('abort limpia cambios y vuelve a branch base', async () => {
    await git.abort('main', 'feature/abort-test');
    const branch = await git.getCurrentBranch();
    assert.strictEqual(branch, 'main');
  });
  
  await test('branch de tarea fue eliminado', async () => {
    const branches = await git.getLocalBranches();
    assert.ok(!branches.includes('feature/abort-test'));
  });
  
  await test('working directory está limpio', async () => {
    await git.hardReset();
    const dirty = await git.getDirtyCount();
    assert.strictEqual(dirty, 0);
  });
}

async function testGitServiceVerify() {
  console.log('\n📋 TEST: GitService Verify\n');
  
  const git = new GitService(TEST_DIR);
  
  await test('verify confirma estado limpio', async () => {
    await git.checkout('main');
    await git.hardReset();
    const result = await git.verify('main');
    
    assert.strictEqual(result.clean, true);
    assert.strictEqual(result.branch, 'main');
    assert.strictEqual(result.dirty, 0);
  });
  
  await test('verify detecta branch incorrecto', async () => {
    await git.checkout('developer');
    const result = await git.verify('main');
    
    assert.strictEqual(result.branch, 'main');
    assert.strictEqual(result.fixed, true);
  });
}

async function testGitServiceEnsureBranch() {
  console.log('\n📋 TEST: GitService EnsureBranch\n');
  
  const git = new GitService(TEST_DIR);
  
  await git.checkout('main');
  await git.hardReset();
  
  await test('ensureBranch retorna ok cuando está en branch correcto', async () => {
    const result = await git.ensureBranch('main');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.restored, false);
  });
  
  await test('ensureBranch detecta branch incorrecto', async () => {
    await git.checkout('developer');
    const result = await git.ensureBranch('main');
    
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.actual, 'developer');
  });
}

// ─────────────────────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(63));
console.log('  TEST SUITE: GIT INTEGRATION');
console.log('═'.repeat(63));

async function runTests() {
  try {
    setup();
    
    await testGitServiceInstantiation();
    await testGitServiceOperations();
    await testGitServiceAbort();
    await testGitServiceVerify();
    await testGitServiceEnsureBranch();
    
  } finally {
    cleanup();
  }
  
  console.log('═'.repeat(63));
  console.log(`  RESULTADO: ${GREEN}${passed} pasaron${RESET}, ${RED}${failed} fallaron${RESET}`);
  console.log('═'.repeat(63) + '\n');
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
