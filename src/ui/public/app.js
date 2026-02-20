/**
 * app.js - Frontend Kanban con drag & drop, filtros y sincronización
 */

// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────
const COLUMNS = [
  { id: 'backlog',     label: 'Backlog',      icon: '📋', color: '#475569' },
  { id: 'todo',        label: 'Todo',         icon: '📌', color: '#0ea5e9' },
  { id: 'in_progress', label: 'In Progress',  icon: '⚡', color: '#8b5cf6' },
  { id: 'review',      label: 'Review',       icon: '🔍', color: '#f59e0b' },
  { id: 'done',        label: 'Done',         icon: '✅', color: '#10b981' },
];

let allTasks = {};          // { backlog: [], todo: [], ... }
let currentFilter = 'all';  // all | feature | fix | bug | label:<tag>
let draggedCard = null;     // { taskId, fromColumn }
let editingTaskId = null;   // ID de tarea en edición
let currentDetailTaskId = null; // ID de tarea en modal detalle
let notifPermission = 'default'; // 'granted' | 'denied' | 'default'
let wsConnection = null;         // WebSocket instance
let wsReconnectDelay = 1000;     // backoff exponencial para reconexión WS
let wsReconnectTimer = null;
let notificationsList = [];      // historial de notificaciones
let notifCenterOpen = false;     // si el dropdown está abierto
let unreadNotifCount = 0;        // badge de no-leídas
let metricsVisible = false;
let registeredProjects = []; // proyectos desde kanban.config.js

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildBoard();
  loadTasks();
  loadProjects();
  loadEngine();
  setupWebSocket();
  setupKeyboardShortcuts();
  initNotifications();
  initLoopStatus();
  loadNotifications();
});

// ─────────────────────────────────────────────
// SELECCIÓN DE MOTOR IA (Claude / OpenCode)
// ─────────────────────────────────────────────
let currentEngine = 'opencode';

async function loadEngine() {
  try {
    const res = await fetch('/api/engine');
    const { success, engine } = await res.json();
    if (success && engine) setEngineUI(engine);
  } catch {}
}

async function setEngine(engine) {
  try {
    const res = await fetch('/api/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
    });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);
    setEngineUI(engine);
    const labels = { claude: 'Claude AI', opencode: 'OpenCode' };
    showToast(`Motor: ${labels[engine] || engine}`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function setEngineUI(engine) {
  currentEngine = engine;
  document.querySelectorAll('.engine-btn').forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById(`eng-${engine}`);
  if (btn) btn.classList.add('active');
}

// ─────────────────────────────────────────────
// CONTROL DEL MOTOR IA
// ─────────────────────────────────────────────
let loopRunning = false;

async function initLoopStatus() {
  try {
    const res = await fetch('/api/loop/status');
    const data = await res.json();
    const running = data.status === 'running';
    setLoopUI(running);
    if (running && data.currentTask) {
      addLogLine(`Motor corriendo — tarea activa: #${data.currentTask.id} ${data.currentTask.title}`, 'info');
    }
  } catch {}
}

async function toggleLoop() {
  const wasStopping = loopRunning;
  const endpoint = wasStopping ? '/api/loop/stop' : '/api/loop/start';
  
  // Leer modo seleccionado
  const loopMode = document.getElementById('loopMode')?.value || 'auto';
  const interactive = loopMode === 'interactive';
  
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactive }),
    });
    const data = await res.json();
    if (data.success) {
      // Actualización optimista inmediata — SSE confirmará el estado real
      setLoopUI(!wasStopping);
      if (!wasStopping && data.engine) {
        showToast(`Motor ${data.engine} iniciado (${interactive ? 'interactivo' : 'automático'})`, 'success');
      }
    } else if (data.error) {
      showToast(data.error, 'error');
      // Resincronizar estado real por si acaso
      initLoopStatus();
    }
  } catch {
    showToast('Error al comunicar con el servidor', 'error');
    initLoopStatus();
  }
}

let _logPollInterval = null;
let _lastLogLength = 0;

function setLoopUI(running) {
  loopRunning = running;
  const btn = document.getElementById('loopBtn');
  if (btn) {
    if (running) {
      btn.textContent = '⏹ Detener IA';
      btn.classList.add('loop-running');
      btn.title = 'Detener motor IA';
    } else {
      btn.textContent = '▶ Iniciar IA';
      btn.classList.remove('loop-running');
      btn.title = 'Iniciar motor IA';
    }
  }
  // dot en el panel de logs
  const dot = document.getElementById('logStatusDot');
  if (dot) dot.classList.toggle('running', running);

  // Polling de logs del motor
  if (running && !_logPollInterval) {
    _lastLogLength = 0;
    pollMotorLogs();
    _logPollInterval = setInterval(pollMotorLogs, 3000);
  } else if (!running && _logPollInterval) {
    clearInterval(_logPollInterval);
    _logPollInterval = null;
    // Una última lectura para capturar los logs finales
    pollMotorLogs();
  }
}

async function pollMotorLogs() {
  try {
    const res = await fetch('/api/loop/logs?lines=200');
    if (!res.ok) return;
    const text = await res.text();
    if (text.length === _lastLogLength) return;

    const allLines = text.split('\n');
    // Calcular cuántas líneas nuevas hay
    const newStart = _lastLogLength === 0 ? 0 : Math.max(0, allLines.length - 30);
    const newLines = _lastLogLength === 0 ? allLines : allLines.slice(newStart);
    _lastLogLength = text.length;

    for (const line of newLines) {
      const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!trimmed) continue;
      let level = '';
      if (/error|fail|✖|✗/i.test(trimmed)) level = 'error';
      else if (/⚠|warn|rollback|timeout/i.test(trimmed)) level = 'warn';
      else if (/✅|✔|DONE|completad|\bok\b/i.test(trimmed)) level = 'ok';
      else if (/TAREA|FASE|ciclo|Ejecutando|Git:|Motor|branch|merge/i.test(trimmed)) level = 'info';
      addLogLine(trimmed, level);
    }
  } catch {}
}

// ─────────────────────────────────────────────
// BANNER DE ESTADO DEL MOTOR IA
// ─────────────────────────────────────────────
function updateAIStatusBanner() {
  const inProgress = allTasks['in_progress'] || [];
  let banner = document.getElementById('aiBanner');

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'aiBanner';
    banner.className = 'ai-banner';
    // Insertar justo antes del board
    const board = document.getElementById('board');
    board.parentNode.insertBefore(banner, board);
  }

  if (inProgress.length === 0) {
    banner.style.display = 'none';
    return;
  }

  const activeProject = document.getElementById('projectSelector').value || 'Sin proyecto';
  const names = inProgress.map(t => `<strong>#${t.id}</strong> ${escapeHtml(t.title)}`).join(' &nbsp;·&nbsp; ');

  banner.style.display = 'flex';
  banner.innerHTML = `
    <span class="ai-banner-dot"></span>
    <span>Motor IA trabajando &nbsp;|&nbsp; Proyecto: <strong>${escapeHtml(activeProject)}</strong> &nbsp;|&nbsp; ${names}</span>
  `;
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('taskModal');
      closeModal('detailModal');
      if (notifCenterOpen) toggleNotifCenter();
    }
    // Ctrl/Cmd + N: nueva tarea
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      openCreateModal();
    }
  });

  // Cerrar notification center al hacer click fuera
  document.addEventListener('click', (e) => {
    if (notifCenterOpen) {
      const panel = document.getElementById('notifCenter');
      const btn = document.getElementById('notifBellBtn');
      if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
        toggleNotifCenter();
      }
    }
  });
}

// ─────────────────────────────────────────────
// NOTIFICACIONES OS
// ─────────────────────────────────────────────
function initNotifications() {
  if (!('Notification' in window)) return;
  notifPermission = Notification.permission;
  updateNotifButton();
}

function updateNotifButton() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (notifPermission === 'granted') {
    btn.textContent = '🔔';
    btn.title = 'Notificaciones activadas';
    btn.style.opacity = '1';
  } else if (notifPermission === 'denied') {
    btn.textContent = '🔕';
    btn.title = 'Notificaciones bloqueadas';
    btn.style.opacity = '0.5';
  } else {
    btn.textContent = '🔔';
    btn.title = 'Activar notificaciones';
    btn.style.opacity = '0.6';
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Tu navegador no soporta notificaciones', 'info');
    return;
  }
  if (notifPermission === 'granted') {
    showToast('Notificaciones ya están activadas', 'info');
    return;
  }
  const result = await Notification.requestPermission();
  notifPermission = result;
  updateNotifButton();
  if (result === 'granted') {
    showToast('Notificaciones activadas', 'success');
    new Notification('AI-Kanban', { body: 'Recibirás alertas cuando se completen tareas', icon: '🤖' });
  } else {
    showToast('Notificaciones denegadas', 'info');
  }
}

function sendOSNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '🤖' });
  } catch {}
}

// ─────────────────────────────────────────────
// PROYECTOS
// ─────────────────────────────────────────────
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const { success, data, active } = await res.json();
    if (!success) return;

    registeredProjects = data;

    const sel = document.getElementById('projectSelector');
    // Limpiar y rellenar
    sel.innerHTML = '<option value="">Sin proyecto</option>';

    for (const proj of data) {
      const opt = document.createElement('option');
      opt.value = proj.name;
      opt.textContent = proj.name;
      opt.title = proj.path;
      sel.appendChild(opt);
    }

    if (active) sel.value = active;
    updateProjectsView();
  } catch {}
}

function updateProjectsView() {
  const hasProjects = registeredProjects.length > 0;
  document.getElementById('board').style.display = hasProjects ? '' : 'none';
  document.getElementById('noProjectsState').style.display = hasProjects ? 'none' : 'flex';
}

async function setActiveProject(name) {
  try {
    await fetch('/api/projects/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    showToast(name ? `Proyecto: ${name}` : 'Sin proyecto activo', 'success');
    // Recargar tareas del nuevo proyecto inmediatamente
    await loadTasks(false);
  } catch {}
}

function openProjectsModal() {
  renderProjectsList();
  openModal('projectsModal');
}

function renderProjectsList() {
  const el = document.getElementById('projectsList');
  if (!registeredProjects.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:8px 0">Sin proyectos registrados todavía.</div>';
    return;
  }

  const activeVal = document.getElementById('projectSelector').value;

  el.innerHTML = registeredProjects.map(p => `
    <div class="project-row">
      <div class="project-row-info">
        <span class="project-row-name">${escapeHtml(p.name)}</span>
        ${p.name === activeVal ? '<span class="badge badge-feature" style="font-size:0.6rem">activo</span>' : ''}
        <span class="project-row-path">${escapeHtml(p.path)}</span>
        <span class="project-row-path" style="color:var(--text-muted);font-size:0.7rem">kanban: ${escapeHtml(p.path)}/kanban</span>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeProject('${escapeHtml(p.name)}')">Eliminar</button>
    </div>
  `).join('');
}

async function addProject() {
  const name = document.getElementById('newProjectName').value.trim();
  const projPath = document.getElementById('newProjectPath').value.trim();
  const branch = document.getElementById('newProjectBranch').value.trim() || 'main';

  if (!name || !projPath) {
    showToast('Nombre y ruta son requeridos', 'error');
    return;
  }

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: projPath, git: { defaultBranch: branch } }),
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error);

    // Limpiar form
    document.getElementById('newProjectName').value = '';
    document.getElementById('newProjectPath').value = '';
    document.getElementById('newProjectBranch').value = '';

    showToast(`Proyecto "${name}" agregado. Kanban en: ${result.kanbanPath}`, 'success');
    await loadProjects();
    renderProjectsList();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function removeProject(name) {
  if (!confirm(`¿Eliminar el proyecto "${name}"?`)) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);

    showToast(`Proyecto "${name}" eliminado`, 'info');
    await loadProjects();
    renderProjectsList();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────
// WEBSOCKET - Transporte primario con fallback a SSE
// ─────────────────────────────────────────────
function setupWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  try {
    wsConnection = new WebSocket(wsUrl);
  } catch {
    console.warn('WebSocket no disponible, usando SSE');
    setupSSE();
    return;
  }

  wsConnection.onopen = () => {
    wsReconnectDelay = 1000; // reset backoff
    document.getElementById('statusDot').style.background = '#10b981';
    document.getElementById('statusText').textContent = 'En vivo (WS)';
    initLoopStatus();
  };

  wsConnection.onmessage = (event) => {
    try {
      const { event: evt, data } = JSON.parse(event.data);

      if (evt === 'connected') {
        if (data.unreadCount !== undefined) {
          unreadNotifCount = data.unreadCount;
          updateNotifBadge();
        }
        return;
      }

      // Nueva notificación push
      if (evt === 'notification') {
        addNotificationToCenter(data);
        return;
      }

      // Notificación marcada como leída
      if (evt === 'notification:read') {
        markNotifReadInUI(data.id);
        return;
      }

      // Todas leídas
      if (evt === 'notification:allRead') {
        unreadNotifCount = 0;
        updateNotifBadge();
        notificationsList.forEach(n => n.read = true);
        renderNotificationCenter();
        return;
      }

      // Board changes (mismo que SSE)
      if (evt === 'board:change') {
        handleBoardEvent(data);
        return;
      }
    } catch {}
  };

  wsConnection.onclose = () => {
    document.getElementById('statusDot').style.background = '#ef4444';
    document.getElementById('statusText').textContent = 'Reconectando...';
    // Reconexión con backoff exponencial
    wsReconnectTimer = setTimeout(() => {
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
      setupWebSocket();
    }, wsReconnectDelay);
  };

  wsConnection.onerror = () => {
    // onclose se disparará después, no duplicar lógica
  };
}

/**
 * SSE fallback (se usa si WebSocket falla)
 */
function setupSSE() {
  const es = new EventSource('/api/events');

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;
      handleBoardEvent(data);
    } catch {}
  };

  es.onerror = () => {
    document.getElementById('statusDot').style.background = '#ef4444';
    document.getElementById('statusText').textContent = 'Desconectado';
    setTimeout(() => {
      es.close();
      setupSSE();
    }, 5000);
  };

  es.onopen = () => {
    document.getElementById('statusDot').style.background = '#10b981';
    document.getElementById('statusText').textContent = 'En vivo (SSE)';
    initLoopStatus();
  };
}

/**
 * Maneja eventos de cambios del board (compartido entre WS y SSE)
 */
function handleBoardEvent(data) {
  // Cambio de proyecto activo
  if (data.type === 'project:changed' || data.type === 'projects:updated') {
    loadProjects();
    loadTasks(false);
    return;
  }

  // Eventos del loop
  if (data.type === 'loop:started') { setLoopUI(true); addLogLine('▶ Motor IA iniciado', 'info'); return; }
  if (data.type === 'loop:stopped') { setLoopUI(false); addLogLine('⏹ Motor IA detenido', ''); loadTasks(false); return; }
  if (data.type === 'loop:log') { addLogLine(data.line || '', data.level || ''); return; }
  if (data.type === 'engine:changed') { setEngineUI(data.engine); return; }

  loadTasks(false);

  // Notificación OS + badge en título
  if (data.type === 'task:completed') {
    const label = data.title || 'Tarea completada';
    sendOSNotification('Tarea completada', label);
    flashTitleBadge();
  } else if (data.type === 'task:review') {
    const label = data.title || 'Tarea en review';
    sendOSNotification('Tarea en review', label);
    flashTitleBadge();
  }
}

// ─────────────────────────────────────────────
// NOTIFICATION CENTER
// ─────────────────────────────────────────────
async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications?limit=50');
    const { success, data, unreadCount } = await res.json();
    if (!success) return;
    notificationsList = data;
    unreadNotifCount = unreadCount;
    updateNotifBadge();
    renderNotificationCenter();
  } catch {}
}

function addNotificationToCenter(notif) {
  // Agregar al inicio (ya viene más reciente primero del servidor pero esta es push)
  notificationsList.unshift(notif);
  if (notificationsList.length > 100) notificationsList = notificationsList.slice(0, 100);
  if (!notif.read) {
    unreadNotifCount++;
    updateNotifBadge();
  }
  renderNotificationCenter();

  // OS notification para las de prioridad alta
  if (notif.priority === 'high') {
    sendOSNotification(notif.title, notif.message);
    flashTitleBadge();
  }
}

function markNotifReadInUI(id) {
  const notif = notificationsList.find(n => n.id === id);
  if (notif && !notif.read) {
    notif.read = true;
    unreadNotifCount = Math.max(0, unreadNotifCount - 1);
    updateNotifBadge();
    renderNotificationCenter();
  }
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (unreadNotifCount > 0) {
    badge.textContent = unreadNotifCount > 99 ? '99+' : unreadNotifCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function toggleNotifCenter() {
  notifCenterOpen = !notifCenterOpen;
  const panel = document.getElementById('notifCenter');
  if (panel) {
    panel.classList.toggle('open', notifCenterOpen);
  }
  if (notifCenterOpen) {
    renderNotificationCenter();
  }
}

function renderNotificationCenter() {
  const list = document.getElementById('notifList');
  if (!list) return;

  if (notificationsList.length === 0) {
    list.innerHTML = '<div class="notif-empty">Sin notificaciones</div>';
    return;
  }

  list.innerHTML = notificationsList.map(n => {
    const time = new Date(n.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const icon = getNotifIcon(n.type);
    const readClass = n.read ? 'notif-read' : 'notif-unread';
    const priorityClass = n.priority === 'high' ? 'notif-high' : '';
    return `
      <div class="notif-item ${readClass} ${priorityClass}" onclick="markNotifRead(${n.id})">
        <span class="notif-icon">${icon}</span>
        <div class="notif-content">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-message">${escapeHtml(n.message)}</div>
        </div>
        <span class="notif-time">${time}</span>
      </div>
    `;
  }).join('');
}

function getNotifIcon(type) {
  const icons = {
    'task:created': '+',
    'task:moved': '→',
    'task:updated': '~',
    'task:deleted': '×',
    'task:completed': '✓',
    'loop:started': '▶',
    'loop:stopped': '⏹',
    'engine:changed': '⚙',
    'project:changed': '📁',
    'system': 'ℹ',
  };
  return icons[type] || '•';
}

async function markNotifRead(id) {
  try {
    await fetch('/api/notifications/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    markNotifReadInUI(id);
  } catch {}
}

async function markAllNotifsRead() {
  try {
    await fetch('/api/notifications/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    notificationsList.forEach(n => n.read = true);
    unreadNotifCount = 0;
    updateNotifBadge();
    renderNotificationCenter();
  } catch {}
}

let titleBadgeTimer = null;
function flashTitleBadge() {
  document.title = '(!) AI-Kanban';
  if (titleBadgeTimer) clearTimeout(titleBadgeTimer);
  titleBadgeTimer = setTimeout(() => {
    document.title = 'AI-Kanban';
  }, 10000);
}

// ─────────────────────────────────────────────
// MÉTRICAS
// ─────────────────────────────────────────────
function toggleMetrics() {
  metricsVisible = !metricsVisible;
  const panel = document.getElementById('metricsPanel');
  panel.style.display = metricsVisible ? 'block' : 'none';
  if (metricsVisible) loadMetrics();
}

async function loadMetrics() {
  try {
    const res = await fetch('/api/metrics');
    const { success, data } = await res.json();
    if (!success) return;

    document.getElementById('m-total').textContent = data.total;
    document.getElementById('m-done').textContent = data.completed;
    document.getElementById('m-avgTime').textContent = data.avgDurationMin > 0 ? `${data.avgDurationMin}m` : '—';
    document.getElementById('m-avgIter').textContent = data.avgIterations > 0 ? data.avgIterations : '—';
    document.getElementById('m-inprogress').textContent = data.byColumn?.in_progress || 0;
    document.getElementById('m-review').textContent = data.byColumn?.review || 0;
  } catch {}
}

// ─────────────────────────────────────────────
// CONSTRUCCIÓN DEL TABLERO
// ─────────────────────────────────────────────
function buildBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  for (const col of COLUMNS) {
    board.appendChild(createColumnEl(col));
  }
}

function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.column = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <div class="column-title">
        <span class="column-icon">${col.icon}</span>
        <span>${col.label}</span>
      </div>
      <span class="column-count" id="count-${col.id}">0</span>
    </div>
    <div class="column-body" id="col-${col.id}"></div>
    <button class="add-task-btn" onclick="openCreateModal('${col.id}')">+ Agregar tarea</button>
  `;

  // Drop zone events
  const body = colEl.querySelector('.column-body');
  setupDropZone(body, col.id);
  setupDropZone(colEl, col.id);

  return colEl;
}

// ─────────────────────────────────────────────
// CARGA DE TAREAS
// ─────────────────────────────────────────────
async function loadTasks(showLoader = true) {
  try {
    const res = await fetch('/api/tasks');
    const { success, data } = await res.json();

    if (!success) throw new Error('Error cargando tareas');

    allTasks = data;
    renderBoard();
    updateAIStatusBanner();
  } catch (err) {
    console.error('Error cargando tareas:', err);
    if (showLoader) showToast('Error cargando tareas', 'error');
  }
}

// ─────────────────────────────────────────────
// RENDER DEL TABLERO
// ─────────────────────────────────────────────
function renderBoard() {
  let totalVisible = 0;

  for (const col of COLUMNS) {
    const body = document.getElementById(`col-${col.id}`);
    const countEl = document.getElementById(`count-${col.id}`);

    const tasks = allTasks[col.id] || [];
    const filtered = filterTasks(tasks);

    countEl.textContent = filtered.length;
    totalVisible += filtered.length;

    body.innerHTML = '';

    if (filtered.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${col.icon}</div>
          <div>Sin tareas</div>
        </div>`;
    } else {
      for (const task of filtered) {
        body.appendChild(createCardEl(task));
      }
    }
  }

  const total = Object.values(allTasks).flat().length;
  document.getElementById('taskCount').textContent = `${totalVisible} / ${total} tareas`;
}

function filterTasks(tasks) {
  if (currentFilter === 'all') return tasks;
  if (['feature', 'fix', 'bug'].includes(currentFilter)) {
    return tasks.filter(t => t.type === currentFilter);
  }
  if (currentFilter.startsWith('label:')) {
    const label = currentFilter.replace('label:', '');
    return tasks.filter(t => t.labels && t.labels.includes(label));
  }
  return tasks;
}

// ─────────────────────────────────────────────
// CREACIÓN DE CARDS
// ─────────────────────────────────────────────
function isBlocked(task) {
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  if (deps.length === 0) return false;
  const doneTasks = allTasks['done'] || [];
  const doneIds = doneTasks.map(t => String(t.id).padStart(3, '0'));
  return deps.some(depId => !doneIds.includes(String(depId).padStart(3, '0')));
}

function createCardEl(task) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.taskId = task.id;
  card.dataset.column = task.column;
  card.draggable = true;

  const labels = (task.labels || []).map(l =>
    `<span class="label-chip" onclick="setFilter('label:${l}', null)">${l}</span>`
  ).join('');

  const idStr = String(task.id).padStart(3, '0');
  const blocked = task.column === 'todo' && isBlocked(task);
  const blockedBadge = blocked
    ? `<span class="blocked-badge">🔒 Bloqueada</span>`
    : '';

  // Indicador de que está trabajando
  const workingBadge = task.column === 'in_progress' 
    ? `<span class="working-badge">⚡ Trabajando</span>`
    : '';

  // Contar criterios de aceptación completados
  const content = task.content || '';
  const criteriaTotal = (content.match(/- \[[x ]\]/g) || []).length;
  const criteriaDone = (content.match(/- \[x\]/g) || []).length;
  const criteriaHtml = criteriaTotal > 0 
    ? `<div class="card-criteria">${criteriaDone}/${criteriaTotal} criterios</div>`
    : '';

  card.innerHTML = `
    <div class="card-header">
      <span class="card-id">#${idStr}</span>
      <div class="card-badges">
        ${blockedBadge}
        ${workingBadge}
        <span class="badge badge-${task.type}">${task.type || 'feature'}</span>
        <span class="badge badge-${task.priority}">${task.priority || 'media'}</span>
      </div>
    </div>
    <div class="card-title">${escapeHtml(task.title)}</div>
    ${criteriaHtml}
    ${labels ? `<div class="card-labels">${labels}</div>` : ''}
    <div class="card-footer">
      <span class="card-branch" title="${escapeHtml(task.branch || '')}">${escapeHtml(task.branch || '')}</span>
      <button class="card-menu-btn" onclick="openDetailModal(event, '${task.id}')" title="Ver detalle">⋯</button>
    </div>
  `;

  // Drag & Drop
  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragend', onDragEnd);

  // Click para ver detalle
  card.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON' && !e.target.closest('.label-chip')) {
      openDetailModal(e, task.id);
    }
  });

  return card;
}

// ─────────────────────────────────────────────
// DRAG & DROP
// ─────────────────────────────────────────────
function onDragStart(e) {
  draggedCard = {
    taskId: e.currentTarget.dataset.taskId,
    fromColumn: e.currentTarget.dataset.column,
  };
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedCard.taskId);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
  draggedCard = null;
}

function setupDropZone(el, column) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.closest('.column').classList.add('drag-over');
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) {
      el.closest('.column').classList.remove('drag-over');
    }
  });

  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.closest('.column').classList.remove('drag-over');

    if (!draggedCard) return;
    if (draggedCard.fromColumn === column) return;

    await moveTaskTo(draggedCard.taskId, column);
  });
}

async function moveTaskTo(taskId, column) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column }),
    });

    const { success, error } = await res.json();
    if (!success) throw new Error(error);

    showToast(`Tarea movida a ${column}`, 'success');
    loadTasks(false);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────
// MODALES
// ─────────────────────────────────────────────
function openCreateModal(defaultColumn = 'backlog') {
  editingTaskId = null;
  document.getElementById('modalTitle').textContent = 'Nueva Tarea';
  document.getElementById('taskId').value = '';
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskType').value = 'feature';
  document.getElementById('taskPriority').value = 'media';
  document.getElementById('taskColumn').value = defaultColumn;
  document.getElementById('taskLabels').value = '';
  document.getElementById('taskDependsOn').value = '';
  document.getElementById('taskContent').value = '# Descripción\n\n\n# Criterios de aceptación\n- ';
  document.getElementById('deleteBtn').style.display = 'none';

  openModal('taskModal');
  setTimeout(() => document.getElementById('taskTitle').focus(), 100);
}

async function openEditModal(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`);
    const { success, data: task } = await res.json();
    if (!success) throw new Error('No se pudo cargar la tarea');

    editingTaskId = taskId;
    document.getElementById('modalTitle').textContent = `Editar #${String(taskId).padStart(3, '0')}`;
    document.getElementById('taskId').value = taskId;
    document.getElementById('taskTitle').value = task.title || '';
    document.getElementById('taskType').value = task.type || 'feature';
    document.getElementById('taskPriority').value = task.priority || 'media';
    document.getElementById('taskColumn').value = task.column || task.status || 'backlog';
    document.getElementById('taskLabels').value = (task.labels || []).join(', ');
    document.getElementById('taskDependsOn').value = (task.dependsOn || []).join(', ');
    document.getElementById('taskContent').value = task.content || '';
    document.getElementById('deleteBtn').style.display = 'inline-block';

    openModal('taskModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openDetailModal(e, taskId) {
  e.stopPropagation();

  currentDetailTaskId = taskId;

  // Buscar tarea en allTasks
  let task = null;
  for (const tasks of Object.values(allTasks)) {
    task = tasks.find(t => String(t.id) === String(taskId));
    if (task) break;
  }

  if (!task) return;

  // Mostrar tab de detalle por defecto
  switchTab('detail', document.querySelector('.task-tab[data-tab="detail"]'));

  const idStr = String(task.id).padStart(3, '0');
  const labels = (task.labels || []).map(l => `<span class="label-chip">${escapeHtml(l)}</span>`).join('');
  const deps = (task.dependsOn || []).join(', ');

  document.getElementById('detailTitle').innerHTML = `
    <span class="detail-modal-id">#${idStr}</span>
    <span class="badge badge-${task.type}">${task.type}</span>
    <span class="badge badge-${task.priority}">${task.priority}</span>
  `;

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-header-section">
      <div class="detail-task-title">${escapeHtml(task.title)}</div>
      ${labels ? `<div class="detail-labels">${labels}</div>` : ''}
      <div class="detail-meta-row">
        ${task.branch ? `<span class="detail-meta-item">🌿 <code class="md-inline">${escapeHtml(task.branch)}</code></span>` : ''}
        <span class="detail-meta-item">📂 ${escapeHtml(task.column || task.status || '')}</span>
        ${task.projectPath ? `<span class="detail-meta-item">📦 ${escapeHtml(resolveProjectLabel(task.projectPath))}</span>` : ''}
        ${deps ? `<span class="detail-meta-item">🔗 Deps: ${escapeHtml(deps)}</span>` : ''}
      </div>
      <div class="detail-dates-row">
        ${task.createdAt ? `<span class="detail-date">📅 Creada ${new Date(task.createdAt).toLocaleString()}</span>` : ''}
        ${task.completedAt ? `<span class="detail-date">✅ Completada ${new Date(task.completedAt).toLocaleString()}</span>` : ''}
        ${task.iterations ? `<span class="detail-date">🔄 ${task.iterations} iteraciones</span>` : ''}
      </div>
    </div>
    <div class="detail-content-section md-body">
      ${renderMarkdown(task.content)}
    </div>
  `;

  document.getElementById('editFromDetail').onclick = () => {
    closeModal('detailModal');
    openEditModal(taskId);
  };

  openModal('detailModal');
}

// ─────────────────────────────────────────────
// TABS EN MODAL DETALLE
// ─────────────────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.task-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  document.getElementById('detailBody').style.display = tab === 'detail' ? 'block' : 'none';
  document.getElementById('phasesBody').style.display = tab === 'phases' ? 'block' : 'none';
  document.getElementById('historyBody').style.display = tab === 'history' ? 'block' : 'none';
  document.getElementById('diffBody').style.display = tab === 'diff' ? 'block' : 'none';

  if (tab === 'phases' && currentDetailTaskId) {
    loadPhasesTab(currentDetailTaskId);
  }
  if (tab === 'history' && currentDetailTaskId) {
    loadHistoryTab(currentDetailTaskId);
  }
  if (tab === 'diff' && currentDetailTaskId) {
    loadDiffTab(currentDetailTaskId);
  }
}

async function loadPhasesTab(taskId) {
  const el = document.getElementById('phasesBody');
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px">Cargando fases...</div>';

  try {
    const [artifactsRes, historyRes] = await Promise.all([
      fetch(`/api/tasks/${taskId}/artifacts`),
      fetch(`/api/tasks/${taskId}/history`)
    ]);
    
    const { success: artifactsOk, data: artifacts } = await artifactsRes.json();
    const { success: historyOk, data: history } = await historyRes.json();
    
    if (!artifactsOk) throw new Error('Error cargando artefactos');
    
    if (!artifacts || artifacts.length === 0) {
      el.innerHTML = '<div class="history-empty">Sin artefactos de fases. Ejecuta la tarea con el motor IA.</div>';
      return;
    }

    const lastRun = history && history.length > 0 ? history[history.length - 1] : null;
    const phasesInfo = lastRun?.phases || {};

    const phaseOrder = ['plan', 'code-iter1', 'code-iter2', 'code-iter3', 'review-iter1', 'review-iter2', 'review-iter3', 'test-iter1', 'test-iter2', 'test-iter3', 'scope'];
    
    const sortedArtifacts = artifacts.sort((a, b) => {
      const aIdx = phaseOrder.findIndex(p => a.name.startsWith(p));
      const bIdx = phaseOrder.findIndex(p => b.name.startsWith(p));
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });

    el.innerHTML = `<div class="phases-list">
      ${sortedArtifacts.map(a => {
        const phaseLabel = a.name.replace('-iter', ' (iter ').replace('iter', 'iter ') + (a.name.includes('iter') ? ')' : '');
        const phaseIcon = a.name.startsWith('plan') ? '📋' 
          : a.name.startsWith('code') ? '💻'
          : a.name.startsWith('review') ? '🔍'
          : a.name.startsWith('test') ? '🧪'
          : a.name.startsWith('scope') ? '✅' : '📄';
        const logBadge = a.hasLog ? `<span class="phase-log-badge" title="Output disponible (${(a.logSize/1024).toFixed(1)}KB)">📜</span>` : '';
        return `
          <div class="phase-item" onclick="loadPhaseArtifact('${taskId}', '${a.name}')">
            <span class="phase-icon">${phaseIcon}</span>
            <span class="phase-name">${phaseLabel.toUpperCase()}</span>
            ${logBadge}
            <span class="phase-time">${new Date(a.mtime).toLocaleTimeString()}</span>
          </div>
        `;
      }).join('')}
    </div>
    <div id="phaseArtifactContent" style="margin-top:16px"></div>
    `;
  } catch (err) {
    el.innerHTML = '<div class="history-empty">Error cargando fases.</div>';
  }
}

async function loadPhaseArtifact(taskId, phaseName) {
  const el = document.getElementById('phaseArtifactContent');
  el.innerHTML = '<div style="color:var(--text-muted);padding:8px">Cargando...</div>';
  
  try {
    const res = await fetch(`/api/tasks/${taskId}/artifacts/${phaseName}`);
    if (!res.ok) throw new Error('No encontrado');
    const content = await res.text();
    
    // Verificar si tiene log disponible
    const artifactsRes = await fetch(`/api/tasks/${taskId}/artifacts`);
    const { data: artifacts } = await artifactsRes.json();
    const artifact = artifacts.find(a => a.name === phaseName);
    const hasLog = artifact?.hasLog;
    const logSize = artifact?.logSize || 0;
    
    const logButton = hasLog 
      ? `<button class="btn btn-secondary btn-sm" onclick="loadPhaseLog('${taskId}', '${phaseName}')" title="Ver output completo (${(logSize/1024).toFixed(1)}KB)">📜 Ver output completo</button>`
      : '';
    
    el.innerHTML = `
      <div class="phase-artifact">
        <div class="phase-artifact-header">
          <strong>${phaseName.toUpperCase()}</strong>
          ${logButton}
        </div>
        <pre class="phase-artifact-content">${escapeHtml(content)}</pre>
      </div>
    `;
  } catch (err) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:8px">Error cargando artefacto</div>';
  }
}

async function loadPhaseLog(taskId, phaseName) {
  const el = document.getElementById('phaseArtifactContent');
  el.innerHTML = '<div style="color:var(--text-muted);padding:8px">Cargando output completo...</div>';
  
  try {
    const res = await fetch(`/api/tasks/${taskId}/artifacts/${phaseName}?type=log`);
    if (!res.ok) throw new Error('No encontrado');
    const content = await res.text();
    const lines = content.split('\n').length;
    
    el.innerHTML = `
      <div class="phase-artifact">
        <div class="phase-artifact-header">
          <strong>${phaseName.toUpperCase()} - Output Completo</strong>
          <button class="btn btn-secondary btn-sm" onclick="loadPhaseArtifact('${taskId}', '${phaseName}')">📋 Ver resumen</button>
        </div>
        <div class="phase-log-info">${lines.toLocaleString()} líneas | ${(content.length/1024).toFixed(1)} KB</div>
        <pre class="phase-log-content">${escapeHtml(content)}</pre>
      </div>
    `;
  } catch (err) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:8px">Error cargando output: ' + err.message + '</div>';
  }
}

async function loadHistoryTab(taskId) {
  const el = document.getElementById('historyBody');
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px">Cargando historial...</div>';

  try {
    const res = await fetch(`/api/tasks/${taskId}/history`);
    const { success, data } = await res.json();
    if (!success || !data || data.length === 0) {
      el.innerHTML = '<div class="history-empty">Sin historial de ejecución para esta tarea.</div>';
      return;
    }

    // Mostrar del más reciente al más antiguo
    const entries = [...data].reverse();
    el.innerHTML = `<div class="history-list">${entries.map(renderHistoryEntry).join('')}</div>`;
  } catch {
    el.innerHTML = '<div class="history-empty">Error cargando historial.</div>';
  }
}

function renderHistoryEntry(entry) {
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—';
  const resultClass = entry.result === 'success' ? 'history-result-success' : 'history-result-failed';
  const resultLabel = entry.result === 'success' ? '✅ Exitosa' : '❌ Fallida';

  const planStatus = entry.phases?.plan?.status || 'pending';
  const codeEntries = entry.phases?.code || [];
  const reviewEntries = entry.phases?.review || [];
  const testEntries = entry.phases?.test || [];
  const scopeStatus = entry.phases?.scope?.status || 'pending';

  const lastCode = codeEntries[codeEntries.length - 1];
  const lastReview = reviewEntries[reviewEntries.length - 1];
  const lastTest = testEntries[testEntries.length - 1];

  const phaseBadge = (label, status) => {
    const cls = status === 'ok' || status === 'approved' ? 'phase-ok'
      : status === 'failed' ? 'phase-failed'
      : status === 'rejected' ? 'phase-rejected'
      : status === 'lost' ? 'phase-lost'
      : status === 'unknown' ? 'phase-unknown'
      : 'phase-pending';
    const icon = status === 'lost' ? '❓' : status === 'unknown' ? '❔' : '';
    return `<span class="history-phase-badge ${cls}">${icon}${label}</span>`;
  };

  const durationMin = entry.totalDuration ? Math.round(entry.totalDuration / 6000) / 10 : null;

  const isRecovered = planStatus === 'ok' && entry.phases?.plan?.summary?.includes('Reconstruido');
  const recoveredBadge = isRecovered ? '<span class="history-recovered-badge">🔄 Recuperado</span>' : '';

  return `
    <div class="history-entry">
      <div class="history-entry-header">
        <span class="history-entry-time">${time}</span>
        <span class="history-entry-result ${resultClass}">${resultLabel}</span>
        ${recoveredBadge}
      </div>
      <div class="history-phases">
        ${phaseBadge('PLAN', planStatus)}
        ${lastCode ? phaseBadge(`CODE×${codeEntries.length}`, lastCode.status) : ''}
        ${lastReview ? phaseBadge('REVIEW', lastReview.status) : ''}
        ${lastTest ? phaseBadge('TEST', lastTest.status) : ''}
        ${phaseBadge('SCOPE', scopeStatus)}
      </div>
      <div class="history-meta">
        ${entry.iterations ? `<span>🔄 ${entry.iterations} iter.</span>` : ''}
        ${durationMin !== null ? `<span>⏱ ${durationMin}m</span>` : ''}
      </div>
      ${entry.summary ? `<div class="history-summary">${escapeHtml(entry.summary)}</div>` : ''}
    </div>
  `;
}

async function loadDiffTab(taskId) {
  const el = document.getElementById('diffBody');
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px">Cargando diff...</div>';

  try {
    const res = await fetch(`/api/tasks/${taskId}/diff`);
    const { success, data } = await res.json();
    if (!success) throw new Error('Error');

    if (!data || data.trim() === '') {
      el.innerHTML = '<div class="diff-viewer"><div class="diff-empty">Sin diff disponible (branch no encontrado o sin cambios).</div></div>';
      return;
    }

    el.innerHTML = `<div class="diff-viewer"><pre>${renderDiff(data)}</pre></div>`;
  } catch {
    el.innerHTML = '<div class="diff-viewer"><div class="diff-empty">Error cargando diff.</div></div>';
  }
}

function renderDiff(diffText) {
  return diffText
    .split('\n')
    .map(line => {
      const escaped = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-line-add">${escaped}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-line-del">${escaped}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-line-hunk">${escaped}</span>`;
      }
      return escaped;
    })
    .join('\n');
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ─────────────────────────────────────────────
// GUARDAR TAREA
// ─────────────────────────────────────────────
async function saveTask() {
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) {
    showToast('El título es requerido', 'error');
    document.getElementById('taskTitle').focus();
    return;
  }

  const dependsOn = document.getElementById('taskDependsOn').value
    .split(',').map(s => s.trim()).filter(Boolean);

  const data = {
    title,
    type: document.getElementById('taskType').value,
    priority: document.getElementById('taskPriority').value,
    column: document.getElementById('taskColumn').value,
    labels: document.getElementById('taskLabels').value
      .split(',').map(l => l.trim()).filter(Boolean),
    content: document.getElementById('taskContent').value,
    dependsOn,
  };

  try {
    if (editingTaskId) {
      const currentTask = findTask(editingTaskId);
      const currentColumn = currentTask ? (currentTask.column || currentTask.status) : null;

      const res = await fetch(`/api/tasks/${editingTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const { success, error } = await res.json();
      if (!success) throw new Error(error);

      if (currentColumn && currentColumn !== data.column) {
        await fetch(`/api/tasks/${editingTaskId}/move`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column: data.column }),
        });
      }

      showToast('Tarea actualizada', 'success');
    } else {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const { success, error } = await res.json();
      if (!success) throw new Error(error);

      showToast('Tarea creada', 'success');
    }

    closeModal('taskModal');
    loadTasks(false);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────
// ELIMINAR TAREA
// ─────────────────────────────────────────────
async function confirmDeleteTask() {
  if (!editingTaskId) return;
  if (!confirm(`¿Eliminar la tarea #${editingTaskId}?`)) return;

  try {
    const res = await fetch(`/api/tasks/${editingTaskId}`, { method: 'DELETE' });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);

    showToast('Tarea eliminada', 'info');
    closeModal('taskModal');
    loadTasks(false);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────
// FILTROS
// ─────────────────────────────────────────────
function setFilter(filter, btn) {
  currentFilter = filter;

  document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  renderBoard();
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─────────────────────────────────────────────
// LOGS DEL MOTOR IA
// ─────────────────────────────────────────────
let logLines = [];
let logsOpen = false;
let unreadLogs = 0;
const MAX_LOG_LINES = 500;

function toggleLogs() {
  logsOpen = !logsOpen;
  document.getElementById('logDrawer').classList.toggle('open', logsOpen);
  if (logsOpen) {
    unreadLogs = 0;
    updateLogsBadge();
    // scroll al final al abrir
    const c = document.getElementById('logContent');
    if (c) c.scrollTop = c.scrollHeight;
  }
}

function clearLogs() {
  logLines = [];
  unreadLogs = 0;
  updateLogsBadge();
  document.getElementById('logContent').innerHTML = '<div class="log-empty">Sin logs aún. Inicia el motor IA para ver la actividad.</div>';
  document.getElementById('logCount').textContent = '— 0 líneas';
}

function addLogLine(text, level = '') {
  if (!text) return;
  logLines.push({ text, level });
  if (logLines.length > MAX_LOG_LINES) logLines.shift();

  const content = document.getElementById('logContent');
  if (!content) return;

  // Quitar el placeholder si existe
  const empty = content.querySelector('.log-empty');
  if (empty) empty.remove();

  // Clasificar nivel por color
  let cls = '';
  if (level === 'error' || /error|fail|❌/i.test(text)) cls = 'log-error';
  else if (/warn|⚠/i.test(text)) cls = 'log-warn';
  else if (/✅|done|completad|success/i.test(text)) cls = 'log-ok';
  else if (/→|start|inici|▶|plan:|code:|review:|test:/i.test(text)) cls = 'log-info';

  const now = new Date();
  const time = now.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${escapeHtml(text)}</span>`;
  content.appendChild(line);

  // Auto-scroll solo si el usuario está cerca del fondo
  const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
  if (nearBottom || logsOpen) content.scrollTop = content.scrollHeight;

  document.getElementById('logCount').textContent = `— ${logLines.length} líneas`;

  if (!logsOpen) {
    unreadLogs++;
    updateLogsBadge();
  }
}

function updateLogsBadge() {
  const btn = document.getElementById('logsBtn');
  if (!btn) return;
  const existing = btn.querySelector('.logs-btn-badge');
  if (unreadLogs > 0) {
    if (existing) existing.textContent = unreadLogs > 99 ? '99+' : unreadLogs;
    else {
      const badge = document.createElement('span');
      badge.className = 'logs-btn-badge';
      badge.textContent = unreadLogs > 99 ? '99+' : unreadLogs;
      btn.appendChild(badge);
    }
  } else {
    if (existing) existing.remove();
  }
}

// ─────────────────────────────────────────────
// MARKDOWN RENDERER
// ─────────────────────────────────────────────
function renderMarkdown(raw) {
  if (!raw || !raw.trim()) return '<span class="md-empty">Sin descripción</span>';

  const lines = raw.split('\n');
  const out = [];
  let inUl = false, inCode = false, codeLines = [];

  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  const inlineMd = (t) => {
    let s = escapeHtml(t);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');
    return s;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="md-pre"><code class="md-code-block">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = []; inCode = false;
      } else { closeUl(); inCode = true; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    if (line.startsWith('### ')) { closeUl(); out.push(`<h3 class="md-h3">${inlineMd(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## '))  { closeUl(); out.push(`<h2 class="md-h2">${inlineMd(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# '))   { closeUl(); out.push(`<h1 class="md-h1">${inlineMd(line.slice(2))}</h1>`); continue; }

    const li = line.match(/^[-*] (.*)/);
    if (li) {
      const c = li[1];
      if (!inUl) { out.push('<ul class="md-ul">'); inUl = true; }
      if (/^\[x\] /i.test(c)) out.push(`<li class="md-li md-check-done">✅ ${inlineMd(c.slice(4))}</li>`);
      else if (/^\[ \] /.test(c)) out.push(`<li class="md-li md-check">☐ ${inlineMd(c.slice(4))}</li>`);
      else out.push(`<li class="md-li">${inlineMd(c)}</li>`);
      continue;
    }

    closeUl();
    if (line.trim() === '') { out.push('<div class="md-br"></div>'); continue; }
    out.push(`<p class="md-p">${inlineMd(line)}</p>`);
  }
  closeUl();
  return out.join('');
}

// ─────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveProjectLabel(projectRef) {
  if (!projectRef) return '';
  const proj = registeredProjects.find(p => p.name === projectRef);
  return proj ? `${proj.name} (${proj.path})` : projectRef;
}

function findTask(id) {
  for (const tasks of Object.values(allTasks)) {
    const t = tasks.find(t => String(t.id) === String(id));
    if (t) return t;
  }
  return null;
}
