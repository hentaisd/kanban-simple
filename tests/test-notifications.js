/**
 * test-notifications.js - Tests del NotificationManager
 */

const assert = require('assert');
const { NotificationManager, NOTIFICATION_TYPES, MAX_NOTIFICATIONS } = require('../src/core/notifications');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
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
// TESTS
// ─────────────────────────────────────────────────────────────

console.log('\n📋 Tests de NotificationManager\n');

test('crear notificación y almacenarla', () => {
  const nm = new NotificationManager();
  const notif = nm.create({
    type: NOTIFICATION_TYPES.TASK_CREATED,
    title: 'Tarea creada',
    message: '#001 Nueva tarea',
  });

  assert.ok(notif.id, 'Debe tener un id');
  assert.strictEqual(notif.type, 'task:created');
  assert.strictEqual(notif.title, 'Tarea creada');
  assert.strictEqual(notif.message, '#001 Nueva tarea');
  assert.strictEqual(notif.read, false);
  assert.strictEqual(notif.priority, 'normal');
  assert.ok(notif.timestamp > 0, 'Debe tener timestamp');

  const all = nm.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, notif.id);
});

test('almacenar múltiples notificaciones en orden', () => {
  const nm = new NotificationManager();
  nm.create({ title: 'Primera', message: 'a' });
  nm.create({ title: 'Segunda', message: 'b' });
  nm.create({ title: 'Tercera', message: 'c' });

  const all = nm.getAll();
  assert.strictEqual(all.length, 3);
  // getAll retorna más recientes primero
  assert.strictEqual(all[0].title, 'Tercera');
  assert.strictEqual(all[1].title, 'Segunda');
  assert.strictEqual(all[2].title, 'Primera');
});

test('respetar límite de notificaciones', () => {
  const nm = new NotificationManager();

  for (let i = 0; i < MAX_NOTIFICATIONS + 50; i++) {
    nm.create({ title: `Notif ${i}`, message: `msg ${i}` });
  }

  assert.ok(nm.notifications.length <= MAX_NOTIFICATIONS,
    `No debe exceder ${MAX_NOTIFICATIONS}, tiene ${nm.notifications.length}`);
});

test('getAll con limit', () => {
  const nm = new NotificationManager();
  for (let i = 0; i < 10; i++) {
    nm.create({ title: `N${i}`, message: '' });
  }

  const limited = nm.getAll({ limit: 3 });
  assert.strictEqual(limited.length, 3);
});

test('getAll con unreadOnly', () => {
  const nm = new NotificationManager();
  const n1 = nm.create({ title: 'A', message: '' });
  nm.create({ title: 'B', message: '' });
  nm.create({ title: 'C', message: '' });

  nm.markRead(n1.id);

  const unread = nm.getAll({ unreadOnly: true });
  assert.strictEqual(unread.length, 2);
  assert.ok(unread.every(n => !n.read));
});

test('markRead marca una notificación como leída', () => {
  const nm = new NotificationManager();
  const n1 = nm.create({ title: 'Test', message: '' });

  assert.strictEqual(n1.read, false);
  assert.strictEqual(nm.getUnreadCount(), 1);

  const result = nm.markRead(n1.id);
  assert.ok(result);
  assert.strictEqual(result.read, true);
  assert.strictEqual(nm.getUnreadCount(), 0);
});

test('markRead retorna null si no existe', () => {
  const nm = new NotificationManager();
  const result = nm.markRead(99999);
  assert.strictEqual(result, null);
});

test('markAllRead marca todas como leídas', () => {
  const nm = new NotificationManager();
  nm.create({ title: 'A', message: '' });
  nm.create({ title: 'B', message: '' });
  nm.create({ title: 'C', message: '' });

  assert.strictEqual(nm.getUnreadCount(), 3);

  const count = nm.markAllRead();
  assert.strictEqual(count, 3);
  assert.strictEqual(nm.getUnreadCount(), 0);
});

test('markAllRead retorna 0 si no hay no-leídas', () => {
  const nm = new NotificationManager();
  nm.create({ title: 'A', message: '' });
  nm.markAllRead();

  const count = nm.markAllRead();
  assert.strictEqual(count, 0);
});

test('getUnreadCount es preciso', () => {
  const nm = new NotificationManager();
  nm.create({ title: 'A', message: '' });
  nm.create({ title: 'B', message: '' });
  const n3 = nm.create({ title: 'C', message: '' });

  assert.strictEqual(nm.getUnreadCount(), 3);

  nm.markRead(n3.id);
  assert.strictEqual(nm.getUnreadCount(), 2);

  nm.markAllRead();
  assert.strictEqual(nm.getUnreadCount(), 0);
});

test('broadcast envía a clientes WebSocket conectados', () => {
  const nm = new NotificationManager();
  const messages = [];

  // Mock WebSocket client
  const fakeWs = {
    readyState: 1,
    send: (msg) => messages.push(JSON.parse(msg)),
  };

  nm.addClient(fakeWs);
  nm.create({ title: 'Push test', message: 'hola' });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].event, 'notification');
  assert.strictEqual(messages[0].data.title, 'Push test');

  nm.removeClient(fakeWs);
  nm.create({ title: 'No debería llegar', message: '' });
  assert.strictEqual(messages.length, 1);
});

test('broadcast ignora clientes desconectados', () => {
  const nm = new NotificationManager();

  const closedWs = {
    readyState: 3, // CLOSED
    send: () => { throw new Error('No debería llamarse'); },
  };

  nm.addClient(closedWs);
  nm.create({ title: 'Test', message: '' });
  // No debe lanzar error
});

test('broadcastChange envía evento board:change', () => {
  const nm = new NotificationManager();
  const messages = [];

  const fakeWs = {
    readyState: 1,
    send: (msg) => messages.push(JSON.parse(msg)),
  };

  nm.addClient(fakeWs);
  nm.broadcastChange('moved', { taskId: '001' });

  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].event, 'board:change');
  assert.strictEqual(messages[0].data.type, 'moved');
  assert.strictEqual(messages[0].data.taskId, '001');
  assert.ok(messages[0].data.timestamp > 0);
});

test('prioridades se asignan correctamente', () => {
  const nm = new NotificationManager();
  const n1 = nm.create({ title: 'Low', priority: 'low' });
  const n2 = nm.create({ title: 'Normal' }); // default
  const n3 = nm.create({ title: 'High', priority: 'high' });

  assert.strictEqual(n1.priority, 'low');
  assert.strictEqual(n2.priority, 'normal');
  assert.strictEqual(n3.priority, 'high');
});

test('meta se almacena correctamente', () => {
  const nm = new NotificationManager();
  const n = nm.create({
    title: 'Con meta',
    message: '',
    meta: { taskId: '005', from: 'todo', to: 'done' },
  });

  assert.deepStrictEqual(n.meta, { taskId: '005', from: 'todo', to: 'done' });
});

test('IDs son secuenciales', () => {
  const nm = new NotificationManager();
  const n1 = nm.create({ title: 'A' });
  const n2 = nm.create({ title: 'B' });
  const n3 = nm.create({ title: 'C' });

  assert.strictEqual(n2.id, n1.id + 1);
  assert.strictEqual(n3.id, n2.id + 1);
});

test('NOTIFICATION_TYPES tiene los tipos esperados', () => {
  assert.strictEqual(NOTIFICATION_TYPES.TASK_CREATED, 'task:created');
  assert.strictEqual(NOTIFICATION_TYPES.TASK_MOVED, 'task:moved');
  assert.strictEqual(NOTIFICATION_TYPES.TASK_UPDATED, 'task:updated');
  assert.strictEqual(NOTIFICATION_TYPES.TASK_DELETED, 'task:deleted');
  assert.strictEqual(NOTIFICATION_TYPES.TASK_COMPLETED, 'task:completed');
  assert.strictEqual(NOTIFICATION_TYPES.LOOP_STARTED, 'loop:started');
  assert.strictEqual(NOTIFICATION_TYPES.LOOP_STOPPED, 'loop:stopped');
  assert.strictEqual(NOTIFICATION_TYPES.ENGINE_CHANGED, 'engine:changed');
  assert.strictEqual(NOTIFICATION_TYPES.SYSTEM, 'system');
});

// ─────────────────────────────────────────────────────────────
// RESULTADO
// ─────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────────`);
console.log(`Total: ${passed + failed} | ${GREEN}Pasados: ${passed}${RESET} | ${failed > 0 ? RED : GREEN}Fallidos: ${failed}${RESET}`);
console.log(`────────────────────────────────────────\n`);

process.exit(failed > 0 ? 1 : 0);
