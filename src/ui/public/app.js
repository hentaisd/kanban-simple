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
let metricsVisible = false;
let registeredProjects = []; // proyectos desde kanban.config.js

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildBoard();
  loadTasks();
  loadProjects();
  setupSSE();
  setupKeyboardShortcuts();
  initNotifications();
});

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('taskModal');
      closeModal('detailModal');
    }
    // Ctrl/Cmd + N: nueva tarea
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      openCreateModal();
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
    const { success, data, defaultProject } = await res.json();
    if (!success) return;

    registeredProjects = data;
    populateProjectSelect(defaultProject);
  } catch {}
}

function populateProjectSelect(defaultProject) {
  const select = document.getElementById('taskProjectPath');
  if (!select) return;

  // Limpiar opciones excepto la primera (sin proyecto)
  while (select.options.length > 1) select.remove(1);

  for (const proj of registeredProjects) {
    const opt = document.createElement('option');
    opt.value = proj.name;
    opt.textContent = proj.isDefault
      ? `${proj.name} (por defecto) — ${proj.path}`
      : `${proj.name} — ${proj.path}`;
    if (proj.isDefault && !defaultProject) opt.selected = true;
    select.appendChild(opt);
  }

  // Si solo hay un proyecto, seleccionarlo automáticamente
  if (registeredProjects.length === 1) {
    select.value = registeredProjects[0].name;
  }
}

// ─────────────────────────────────────────────
// SSE - Sincronización en tiempo real
// ─────────────────────────────────────────────
function setupSSE() {
  const es = new EventSource('/api/events');

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;

      loadTasks(false);

      // Notificación OS + badge en título
      if (data.type === 'task:completed') {
        const label = data.title || 'Tarea completada';
        sendOSNotification('✅ Tarea completada', label);
        flashTitleBadge();
      } else if (data.type === 'task:review') {
        const label = data.title || 'Tarea en review';
        sendOSNotification('🔍 Tarea en review', label);
        flashTitleBadge();
      }
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
    document.getElementById('statusText').textContent = 'En vivo';
  };
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

  card.innerHTML = `
    <div class="card-header">
      <span class="card-id">#${idStr}</span>
      <div class="card-badges">
        ${blockedBadge}
        <span class="badge badge-${task.type}">${task.type || 'feature'}</span>
        <span class="badge badge-${task.priority}">${task.priority || 'media'}</span>
      </div>
    </div>
    <div class="card-title">${escapeHtml(task.title)}</div>
    ${labels ? `<div class="card-labels">${labels}</div>` : ''}
    <div class="card-footer">
      <span class="card-branch" title="${escapeHtml(task.branch || '')}">${escapeHtml(task.branch || '')}</span>
      <button class="card-menu-btn" onclick="openDetailModal(event, '${task.id}')" title="Ver detalle">⋯</button>
    </div>
  `;

  // Drag & Drop
  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragend', onDragEnd);

  // Click para editar
  card.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON' && !e.target.closest('.label-chip')) {
      openEditModal(task.id);
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
  // Seleccionar proyecto por defecto
  const sel = document.getElementById('taskProjectPath');
  const defProj = registeredProjects.find(p => p.isDefault);
  sel.value = defProj ? defProj.name : (registeredProjects.length === 1 ? registeredProjects[0].name : '');
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
    // Restaurar proyecto: si es un nombre registrado úsalo, si no déjalo vacío
    const projSel = document.getElementById('taskProjectPath');
    const projVal = task.projectPath || '';
    const isRegistered = registeredProjects.some(p => p.name === projVal);
    projSel.value = isRegistered ? projVal : '';
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
  const labels = (task.labels || []).map(l => `<span class="label-chip">${l}</span>`).join(' ');
  const deps = (task.dependsOn || []).join(', ');

  document.getElementById('detailTitle').innerHTML = `
    <span>#${idStr}</span>
    <span class="badge badge-${task.type}" style="margin-left:8px">${task.type}</span>
  `;

  document.getElementById('detailBody').innerHTML = `
    <div style="margin-bottom:12px">
      <div style="font-size:1rem;font-weight:600;margin-bottom:8px">${escapeHtml(task.title)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <span class="badge badge-${task.priority}">${task.priority}</span>
        ${labels}
      </div>
      <div style="font-size:0.75rem;color:var(--text-muted);font-family:monospace;margin-bottom:8px">
        📁 ${task.branch || '—'} &nbsp;|&nbsp; 📂 ${task.column || task.status}
      </div>
      ${task.projectPath ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px">📦 Proyecto: ${escapeHtml(resolveProjectLabel(task.projectPath))}</div>` : ''}
      ${deps ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px">🔗 Depende de: ${escapeHtml(deps)}</div>` : ''}
      ${task.createdAt ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px">📅 Creada: ${new Date(task.createdAt).toLocaleString()}</div>` : ''}
      ${task.completedAt ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px">✅ Completada: ${new Date(task.completedAt).toLocaleString()}</div>` : ''}
      ${task.iterations ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:12px">🔄 Iteraciones: ${task.iterations}</div>` : ''}
    </div>
    <div style="background:var(--bg-3);border-radius:8px;padding:16px;font-family:monospace;font-size:0.8rem;white-space:pre-wrap;max-height:300px;overflow-y:auto;border:1px solid var(--border)">
      ${escapeHtml(task.content || '(sin descripción)')}
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
  // Actualizar botones
  document.querySelectorAll('.task-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Mostrar panel correcto
  document.getElementById('detailBody').style.display = tab === 'detail' ? 'block' : 'none';
  document.getElementById('historyBody').style.display = tab === 'history' ? 'block' : 'none';
  document.getElementById('diffBody').style.display = tab === 'diff' ? 'block' : 'none';

  if (tab === 'history' && currentDetailTaskId) {
    loadHistoryTab(currentDetailTaskId);
  }
  if (tab === 'diff' && currentDetailTaskId) {
    loadDiffTab(currentDetailTaskId);
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

  const lastCode = codeEntries[codeEntries.length - 1];
  const lastReview = reviewEntries[reviewEntries.length - 1];
  const lastTest = testEntries[testEntries.length - 1];

  const phaseBadge = (label, status) => {
    const cls = status === 'ok' || status === 'approved' ? 'phase-ok'
      : status === 'failed' ? 'phase-failed'
      : status === 'rejected' ? 'phase-rejected'
      : 'phase-pending';
    return `<span class="history-phase-badge ${cls}">${label}</span>`;
  };

  const durationMin = entry.totalDuration ? Math.round(entry.totalDuration / 6000) / 10 : null;

  return `
    <div class="history-entry">
      <div class="history-entry-header">
        <span class="history-entry-time">${time}</span>
        <span class="history-entry-result ${resultClass}">${resultLabel}</span>
      </div>
      <div class="history-phases">
        ${phaseBadge('PLAN', planStatus)}
        ${lastCode ? phaseBadge(`CODE×${codeEntries.length}`, lastCode.status) : ''}
        ${lastReview ? phaseBadge('REVIEW', lastReview.status) : ''}
        ${lastTest ? phaseBadge('TEST', lastTest.status) : ''}
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

  const dependsOnRaw = document.getElementById('taskDependsOn').value;
  const dependsOn = dependsOnRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const projectPath = document.getElementById('taskProjectPath').value.trim() || null;

  const data = {
    title,
    type: document.getElementById('taskType').value,
    priority: document.getElementById('taskPriority').value,
    column: document.getElementById('taskColumn').value,
    labels: document.getElementById('taskLabels').value
      .split(',').map(l => l.trim()).filter(Boolean),
    content: document.getElementById('taskContent').value,
    dependsOn,
    projectPath,
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
