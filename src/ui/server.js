/**
 * server.js - API REST + WebSocket + servidor de archivos estáticos para el Kanban UI
 */

require('dotenv').config();

const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { WebSocketServer } = require('ws');
const {
  getTasksCached,
  getTaskByIdCached,
  invalidateTaskCache,
  moveTask,
  createTask,
  deleteTask,
  getTasks,
} = require('../kanban/board');
const { nextId } = require('../core/id-generator');
const { generateBranchName, writeTask, KANBAN_PATH, getKanbanPath, COLUMNS } = require('../core/task');
const cache = require('../core/cache');
const { getHistory } = require('../core/history');
const GitService = require('../git/gitService');
const { NotificationManager, NOTIFICATION_TYPES } = require('../core/notifications');
const sync = require('../core/sync');

const app = express();

// Leer puerto desde config, env o default 3847
let PORT = 3847;
try {
  const cfg = require('../../kanban.config.js');
  PORT = process.env.PORT || cfg.port || 3847;
} catch {
  PORT = process.env.PORT || 3847;
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// GESTIÓN DE PROYECTOS
// ─────────────────────────────────────────────

const PROJECTS_FILE = path.join(KANBAN_PATH, 'projects.json');
const ACTIVE_PROJECT_FILE = path.join(KANBAN_PATH, '.active-project.json');

function readProjectsFile() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    }
  } catch {}
  try {
    delete require.cache[require.resolve('../../kanban.config.js')];
    const cfg = require('../../kanban.config.js');
    if (cfg.projects && Object.keys(cfg.projects).length > 0) {
      return Object.entries(cfg.projects).map(([name, data]) => ({
        name,
        path: data.path,
        git: data.git || {},
      }));
    }
  } catch {}
  return [];
}

function writeProjectsFile(list) {
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function readActiveProject() {
  try {
    if (fs.existsSync(ACTIVE_PROJECT_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function writeActiveProject(data) {
  fs.writeFileSync(ACTIVE_PROJECT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Resuelve el directorio kanban del proyecto activo.
 * Si hay proyecto activo → {projectPath}/kanban
 * Si no → KANBAN_PATH global (kanban/ de este repo)
 */
function getActiveKanbanPath() {
  try {
    const active = readActiveProject();
    if (active?.name) {
      const list = readProjectsFile();
      const project = list.find(p => p.name === active.name);
      if (project?.path) {
        return getKanbanPath(project.path);
      }
    }
  } catch {}
  return KANBAN_PATH;
}

/**
 * Crea los subdirectorios del kanban si no existen
 */
function ensureKanbanDirs(kanbanPath) {
  for (const col of COLUMNS) {
    fs.mkdirSync(path.join(kanbanPath, col), { recursive: true });
  }
}

// ─────────────────────────────────────────────
// NOTIFICATION MANAGER
// ─────────────────────────────────────────────
const notifications = new NotificationManager();

// ─────────────────────────────────────────────
// SSE - Server-Sent Events (fallback para clientes sin WebSocket)
// ─────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastChange(type = 'update', extra = {}) {
  const data = JSON.stringify({ type, timestamp: Date.now(), ...extra });
  // SSE fallback
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
  // WebSocket broadcast
  notifications.broadcastChange(type, extra);
}

// Watcher — vigila el kanban de todos los proyectos registrados
function getWatchPaths() {
  const paths = [KANBAN_PATH];
  try {
    const list = readProjectsFile();
    for (const p of list) {
      if (p.path) paths.push(getKanbanPath(p.path));
    }
  } catch {}
  return [...new Set(paths)];
}

const watcher = chokidar.watch(getWatchPaths(), {
  ignored: /(^|[/\\])\../,
  persistent: true,
  ignoreInitial: true,
});

watcher.on('all', () => {
  cache.flush();
  broadcastChange('update');
});

// ─────────────────────────────────────────────
// API ENDPOINTS — TAREAS
// ─────────────────────────────────────────────

/**
 * GET /api/tasks - Obtener todas las tareas agrupadas por columna
 */
app.get('/api/tasks', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const tasks = await getTasksCached(null, kanbanPath);
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id - Detalle de una tarea
 */
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }
    res.json({ success: true, data: found.task });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function isEmptyPlaceholder(content) {
  if (!content) return true;
  const normalized = content.replace(/\s+/g, ' ').trim();
  const emptyPatterns = [
    /^# Descripción\s*# Criterios de aceptación\s*-?\s*$/,
    /^# Descripción\s+# Criterios de aceptación\s*$/,
  ];
  return emptyPatterns.some(p => p.test(normalized));
}

function generateTaskContent(type, title) {
  let criteria;
  if (type === 'feature') {
    criteria = [
      `La funcionalidad "${title}" está implementada y funcionando`,
      'Los tests relevantes pasan correctamente',
      'El código está documentado',
    ];
  } else if (type === 'fix' || type === 'bug') {
    criteria = [
      `El problema "${title}" está resuelto`,
      'El caso que causaba el error ya no ocurre',
      'No se han introducido regresiones',
    ];
  } else {
    criteria = [`La tarea "${title}" está completada`];
  }
  return `# Descripción\n${title}\n\n# Criterios de aceptación\n- ${criteria.join('\n- ')}`;
}

/**
 * POST /api/tasks - Crear nueva tarea
 */
app.post('/api/tasks', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const { title, type = 'feature', priority = 'media', labels = [], column = 'backlog', content, dependsOn = [] } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'El título es requerido' });
    }

    const id = nextId(kanbanPath);
    const branch = generateBranchName(type, title);

    const taskContent = isEmptyPlaceholder(content)
      ? generateTaskContent(type, title)
      : content;

    const task = createTask({
      id,
      title,
      type,
      priority,
      branch,
      labels,
      dependsOn,
      content: taskContent,
    }, column, kanbanPath);

    await invalidateTaskCache(id, [column], kanbanPath);
    broadcastChange('created');
    sync.broadcastTaskCreated(task, column, task.filePath);
    notifications.create({
      type: NOTIFICATION_TYPES.TASK_CREATED,
      title: 'Tarea creada',
      message: `#${id} ${title}`,
      priority: priority === 'alta' ? 'high' : 'normal',
      meta: { taskId: id },
    });
    res.status(201).json({ success: true, data: task });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/tasks/:id/move - Mover tarea a otra columna
 */
app.put('/api/tasks/:id/move', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const { column } = req.body;
    if (!column) {
      return res.status(400).json({ success: false, error: 'El campo column es requerido' });
    }

    const result = moveTask(req.params.id, column, kanbanPath);
    await invalidateTaskCache(req.params.id, [result.fromColumn, result.toColumn], kanbanPath);
    broadcastChange('moved');
    sync.broadcastTaskMoved(req.params.id, result.fromColumn, result.toColumn, result.fileName);
    notifications.create({
      type: NOTIFICATION_TYPES.TASK_MOVED,
      title: 'Tarea movida',
      message: `#${req.params.id} ${result.fromColumn} -> ${result.toColumn}`,
      meta: { taskId: req.params.id, from: result.fromColumn, to: result.toColumn },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/tasks/:id - Actualizar datos de una tarea
 */
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    const updatedTask = { ...found.task, ...req.body };
    writeTask(updatedTask, found.filePath);

    await invalidateTaskCache(req.params.id, [found.column], kanbanPath);
    broadcastChange('updated');
    sync.broadcastTaskUpdated(updatedTask, found.column, found.filePath);
    notifications.create({
      type: NOTIFICATION_TYPES.TASK_UPDATED,
      title: 'Tarea actualizada',
      message: `#${req.params.id} ${updatedTask.title || ''}`,
      meta: { taskId: req.params.id },
    });

    res.json({ success: true, data: updatedTask });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/tasks/:id - Eliminar tarea
 */
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    const column = found ? found.column : null;
    const fileName = found ? found.fileName : null;

    deleteTask(req.params.id, kanbanPath);
    await invalidateTaskCache(req.params.id, [column], kanbanPath);
    broadcastChange('deleted');
    sync.broadcastTaskDeleted(req.params.id, column, fileName);
    notifications.create({
      type: NOTIFICATION_TYPES.TASK_DELETED,
      title: 'Tarea eliminada',
      message: `#${req.params.id}`,
      meta: { taskId: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tasks/:id/retry - Mover tarea de REVIEW a TODO
 */
app.post('/api/tasks/:id/retry', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const result = moveTask(req.params.id, 'todo', kanbanPath);
    await invalidateTaskCache(req.params.id, [result.fromColumn, 'todo'], kanbanPath);
    broadcastChange('moved');
    sync.broadcastTaskMoved(req.params.id, result.fromColumn, 'todo', result.fileName);
    notifications.create({
      type: NOTIFICATION_TYPES.TASK_MOVED,
      title: 'Tarea reintentada',
      message: `#${req.params.id} ${result.fromColumn} → todo`,
      meta: { taskId: req.params.id },
    });
    res.json({ success: true, from: result.fromColumn, to: 'todo' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/unstuck - Detectar tareas atascadas
 */
app.get('/api/unstuck', (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const inProgress = getTasks('in_progress', kanbanPath);
    const review = getTasks('review', kanbanPath);
    
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const stuck = [];
    
    for (const task of inProgress) {
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
      if (startedAt && startedAt < oneHourAgo) {
        stuck.push({
          id: task.id,
          title: task.title,
          column: 'in_progress',
          startedAt: task.startedAt,
          minutesAgo: Math.round((Date.now() - startedAt) / 60000),
        });
      }
    }
    
    for (const task of review) {
      stuck.push({
        id: task.id,
        title: task.title,
        column: 'review',
        retryCount: task.retryCount || 0,
        lastError: task.lastError,
      });
    }
    
    res.json({ success: true, count: stuck.length, tasks: stuck });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/unstuck - Arreglar tareas atascadas
 */
app.post('/api/unstuck', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const { all } = req.body || {};
    
    const inProgress = getTasks('in_progress', kanbanPath);
    const review = getTasks('review', kanbanPath);
    
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const fixed = [];
    
    for (const task of inProgress) {
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
      if (startedAt && startedAt < oneHourAgo) {
        moveTask(task.id, 'review', kanbanPath);
        fixed.push({ id: task.id, from: 'in_progress', to: 'review' });
      }
    }
    
    if (all) {
      for (const task of review) {
        moveTask(task.id, 'todo', kanbanPath);
        fixed.push({ id: task.id, from: 'review', to: 'todo' });
      }
    }
    
    cache.flush();
    broadcastChange('moved');
    
    res.json({ success: true, fixed: fixed.length, tasks: fixed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// API ENDPOINTS — PROYECTOS
// ─────────────────────────────────────────────

/**
 * GET /api/projects - Lista los proyectos
 */
app.get('/api/projects', (req, res) => {
  try {
    const list = readProjectsFile();
    const active = readActiveProject();
    const activeName = active?.name || (list[0]?.name ?? '');
    res.json({ success: true, data: list, active: activeName });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/projects - Agregar un proyecto nuevo
 */
app.post('/api/projects', (req, res) => {
  try {
    const { name, path: projectPath, git } = req.body;
    if (!name || !projectPath) {
      return res.status(400).json({ success: false, error: 'name y path son requeridos' });
    }

    if (!fs.existsSync(projectPath)) {
      return res.status(400).json({ success: false, error: `El directorio no existe: ${projectPath}` });
    }

    const list = readProjectsFile();
    if (list.find(p => p.name === name)) {
      return res.status(400).json({ success: false, error: `El proyecto "${name}" ya existe` });
    }

    // Crear estructura kanban/ dentro del proyecto
    const kanbanPath = getKanbanPath(projectPath);
    ensureKanbanDirs(kanbanPath);

    // Añadir al watcher
    watcher.add(kanbanPath);

    const newProject = { name, path: projectPath, git: git || {} };
    list.push(newProject);
    writeProjectsFile(list);

    // Si es el primero, activarlo automáticamente
    if (list.length === 1) {
      writeActiveProject({ name, setAt: new Date().toISOString() });
    }

    broadcastChange('projects:updated');
    res.status(201).json({ success: true, data: newProject, kanbanPath });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/projects/:name - Eliminar un proyecto
 */
app.delete('/api/projects/:name', (req, res) => {
  try {
    const list = readProjectsFile();
    const toDelete = list.find(p => p.name === req.params.name);
    const filtered = list.filter(p => p.name !== req.params.name);
    if (filtered.length === list.length) {
      return res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
    }
    writeProjectsFile(filtered);

    // Dejar de vigilar el kanban de ese proyecto
    if (toDelete?.path) {
      watcher.unwatch(getKanbanPath(toDelete.path));
    }

    // Si era el activo, activar el primero disponible
    const active = readActiveProject();
    if (active?.name === req.params.name) {
      writeActiveProject({ name: filtered[0]?.name ?? '', setAt: new Date().toISOString() });
    }

    broadcastChange('projects:updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/projects/active - Cambiar el proyecto activo
 */
app.post('/api/projects/active', (req, res) => {
  try {
    const { name } = req.body;
    writeActiveProject({ name: name || '', setAt: new Date().toISOString() });
    cache.flush();
    broadcastChange('project:changed', { project: name });
    res.json({ success: true, active: name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// API ENDPOINTS — HISTORIAL, DIFF, MÉTRICAS
// ─────────────────────────────────────────────

/**
 * GET /api/tasks/:id/history - Historial de ejecución de una tarea
 */
app.get('/api/tasks/:id/history', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const history = getHistory(req.params.id, kanbanPath);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id/artifacts/:phase - Leer artefacto de una fase específica
 */
app.get('/api/tasks/:id/artifacts/:phase', async (req, res) => {
  try {
    const { id, phase } = req.params;
    const type = req.query.type || 'md';
    const kanbanPath = getActiveKanbanPath();
    const paddedId = String(id).padStart(3, '0');
    const artifactPath = path.join(kanbanPath, '.history', paddedId, `${phase}.${type}`);
    
    if (!fs.existsSync(artifactPath)) {
      return res.status(404).json({ success: false, error: 'Artefacto no encontrado' });
    }
    
    const content = fs.readFileSync(artifactPath, 'utf8');
    
    if (type === 'log') {
      res.type('text/plain').send(content);
    } else {
      res.type('text/markdown').send(content);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id/artifacts - Listar todos los artefactos de una tarea
 */
app.get('/api/tasks/:id/artifacts', async (req, res) => {
  try {
    const { id } = req.params;
    const kanbanPath = getActiveKanbanPath();
    const paddedId = String(id).padStart(3, '0');
    const artifactsDir = path.join(kanbanPath, '.history', paddedId);
    
    if (!fs.existsSync(artifactsDir)) {
      return res.json({ success: true, data: [] });
    }
    
    const allFiles = fs.readdirSync(artifactsDir);
    const mdFiles = allFiles.filter(f => f.endsWith('.md'));
    
    const files = mdFiles.map(f => {
      const name = f.replace('.md', '');
      const hasLog = allFiles.includes(`${name}.log`);
      const logSize = hasLog ? fs.statSync(path.join(artifactsDir, `${name}.log`)).size : 0;
      return {
        name,
        path: f,
        mtime: fs.statSync(path.join(artifactsDir, f)).mtime,
        hasLog,
        logSize,
      };
    });
    
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id/diff - Diff del branch de la tarea vs rama principal
 */
app.get('/api/tasks/:id/diff', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    const active = readActiveProject();
    const list = readProjectsFile();
    const project = list.find(p => p.name === active?.name);

    let cfg = {};
    try { cfg = require('../../kanban.config.js'); } catch {}
    const defaultBranch = project?.git?.defaultBranch || cfg.git?.defaultBranch || 'main';
    const projectPath = project?.path || cfg.projectPath || process.cwd();

    const gitService = new GitService(projectPath);
    const branch = found.task.branch;

    if (!branch) {
      return res.json({ success: true, data: '' });
    }

    const diff = await gitService.getDiff(branch, defaultBranch);
    res.json({ success: true, data: diff });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/metrics - Estadísticas agregadas del tablero activo
 */
app.get('/api/metrics', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const allTasks = getTasks(null, kanbanPath);
    const allFlat = Object.values(allTasks).flat();

    let totalDuration = 0;
    let completedCount = 0;
    let totalIterations = 0;
    const byType = { feature: 0, fix: 0, bug: 0 };
    const byColumn = {};

    for (const task of allFlat) {
      byType[task.type] = (byType[task.type] || 0) + 1;
      byColumn[task.column] = (byColumn[task.column] || 0) + 1;

      if (task.column === 'done' && task.completedAt && task.createdAt) {
        const created = new Date(task.createdAt).getTime();
        const completed = new Date(task.completedAt).getTime();
        if (!isNaN(created) && !isNaN(completed)) {
          totalDuration += completed - created;
          completedCount++;
        }
        totalIterations += (task.iterations || 0);
      }
    }

    const avgDurationMs = completedCount > 0 ? totalDuration / completedCount : 0;
    const avgIterations = completedCount > 0 ? totalIterations / completedCount : 0;

    res.json({
      success: true,
      data: {
        total: allFlat.length,
        byColumn,
        byType,
        completed: completedCount,
        avgDurationMs: Math.round(avgDurationMs),
        avgDurationMin: Math.round(avgDurationMs / 60000 * 10) / 10,
        avgIterations: Math.round(avgIterations * 10) / 10,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tasks/:id/rollback - Rollback git y mover tarea a review
 */
app.post('/api/tasks/:id/rollback', async (req, res) => {
  try {
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    const active = readActiveProject();
    const list = readProjectsFile();
    const project = list.find(p => p.name === active?.name);

    let cfg = {};
    try { cfg = require('../../kanban.config.js'); } catch {}
    const defaultBranch = project?.git?.defaultBranch || cfg.git?.defaultBranch || 'main';
    const projectPath = project?.path || cfg.projectPath || process.cwd();

    const gitService = new GitService(projectPath);
    try {
      await gitService.rollback(defaultBranch);
    } catch (e) {
      console.log(`Rollback git warning: ${e.message}`);
    }

    const result = moveTask(req.params.id, 'review', kanbanPath);
    await invalidateTaskCache(req.params.id, [result.fromColumn, 'review'], kanbanPath);
    broadcastChange('moved', { taskId: req.params.id });

    res.json({ success: true, message: 'Rollback ejecutado, tarea movida a review' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// CONFIGURACIÓN DEL MOTOR IA (engine)
// ─────────────────────────────────────────────
// Usar ruta fija para que loop.js lo encuentre siempre
const ENGINE_FILE = '/tmp/ai-kanban-engine.json';

function readEngine() {
  try {
    if (fs.existsSync(ENGINE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8'));
      if (data.engine) return data;
    }
  } catch {}
  return { engine: 'opencode' };
}

function writeEngine(data) {
  fs.writeFileSync(ENGINE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/engine', (req, res) => {
  res.json({ success: true, ...readEngine() });
});

app.post('/api/engine', (req, res) => {
  const { engine } = req.body;
  if (!['claude', 'opencode'].includes(engine)) {
    return res.status(400).json({ success: false, error: 'Motor no válido. Opciones: claude, opencode' });
  }
  writeEngine({ engine });
  console.log(`[Engine] Guardado: ${engine} en ${ENGINE_FILE}`);
  broadcastChange('engine:changed', { engine });
  res.json({ success: true, engine });
});

// ─────────────────────────────────────────────
// CONTROL DEL MOTOR IA — usa loop.js con flujo git completo
// ─────────────────────────────────────────────
const { spawn, execSync } = require('child_process');
const CLI_PATH  = path.join(__dirname, '../cli/index.js');
const PID_FILE  = '/tmp/kanban-loop.pid';
const TASK_STATUS_FILE = '/tmp/kanban-task-status.json';
const LOOP_LOG_FILE = '/tmp/kanban-motor.log';

/** Lee el PID del loop desde el archivo, o null si no existe / muerto */
function readLoopPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

function getLoopStatus() {
  return readLoopPid() !== null ? 'running' : 'stopped';
}

/**
 * Resuelve el path del proyecto activo.
 */
function getActiveProjectPath() {
  try {
    const active = readActiveProject();
    if (active?.name) {
      const list = readProjectsFile();
      const project = list.find(p => p.name === active.name);
      if (project?.path) return project.path;
    }
  } catch {}
  return path.resolve(__dirname, '../../');
}

// Polling para detectar cuando termina una tarea (lee kanban)
let taskPollInterval = null;
function startTaskPolling(taskId, engine) {
  if (taskPollInterval) clearInterval(taskPollInterval);

  taskPollInterval = setInterval(() => {
    try {
      const kanbanPath = getActiveKanbanPath();
      // Verificar si la tarea ya no está en in_progress (loop.js la mueve)
      const inProgress = getTasks('in_progress', kanbanPath);
      const stillRunning = inProgress.some(t => String(t.id) === String(taskId));

      if (!stillRunning) {
        clearInterval(taskPollInterval);
        taskPollInterval = null;

        // Verificar a dónde fue (done o review)
        const doneTasks = getTasks('done', kanbanPath);
        const reviewTasks = getTasks('review', kanbanPath);
        const inDone = doneTasks.some(t => String(t.id) === String(taskId));
        const inReview = reviewTasks.some(t => String(t.id) === String(taskId));

        if (inDone) {
          broadcastChange('task:completed', { taskId, status: 'done' });
          notifications.create({
            type: NOTIFICATION_TYPES.TASK_COMPLETED,
            title: 'Tarea completada',
            message: `#${taskId} terminada exitosamente`,
            priority: 'high',
            meta: { taskId, status: 'done' },
          });
          spawn('notify-send', ['AI-Kanban', `Tarea #${taskId} completada`], { stdio: 'ignore' });
        } else if (inReview) {
          broadcastChange('task:completed', { taskId, status: 'review' });
          notifications.create({
            type: NOTIFICATION_TYPES.TASK_COMPLETED,
            title: 'Tarea en review',
            message: `#${taskId} enviada a review`,
            priority: 'high',
            meta: { taskId, status: 'review' },
          });
          spawn('notify-send', ['AI-Kanban', `Tarea #${taskId} enviada a review`], { stdio: 'ignore' });
        }

        // Verificar si el loop sigue corriendo (procesará la siguiente tarea)
        const pid = readLoopPid();
        if (pid) {
          // El loop sigue — buscar si tomó otra tarea
          setTimeout(() => {
            const nextInProgress = getTasks('in_progress', kanbanPath);
            if (nextInProgress.length > 0) {
              const next = nextInProgress[0];
              broadcastChange('loop:started', { taskId: next.id, title: next.title });
              startTaskPolling(next.id, engine);
            } else {
              // Puede que esté esperando, seguir polling
              startLoopPolling(engine);
            }
          }, 5000);
        } else {
          broadcastChange('loop:stopped', {});
        }
      }
    } catch {}
  }, 3000);
}

// Polling para detectar cuando el loop toma una nueva tarea
function startLoopPolling(engine) {
  if (taskPollInterval) clearInterval(taskPollInterval);

  let checks = 0;
  taskPollInterval = setInterval(() => {
    checks++;
    try {
      const kanbanPath = getActiveKanbanPath();
      const inProgress = getTasks('in_progress', kanbanPath);

      if (inProgress.length > 0) {
        clearInterval(taskPollInterval);
        taskPollInterval = null;
        const task = inProgress[0];
        broadcastChange('loop:started', { taskId: task.id, title: task.title });
        startTaskPolling(task.id, engine);
      } else if (checks > 20) {
        // 60s sin actividad — el loop probablemente terminó
        clearInterval(taskPollInterval);
        taskPollInterval = null;
        const pid = readLoopPid();
        if (!pid) broadcastChange('loop:stopped', {});
      }
    } catch {}
  }, 3000);
}

/**
 * GET /api/loop/status
 */
app.get('/api/loop/status', (req, res) => {
  const pid = readLoopPid();
  const kanbanPath = getActiveKanbanPath();
  const inProgress = getTasks('in_progress', kanbanPath);
  const currentTask = inProgress.length > 0 ? inProgress[0] : null;

  res.json({
    status: pid ? 'running' : 'stopped',
    pid: pid || null,
    currentTask: currentTask ? { id: currentTask.id, title: currentTask.title } : null,
    logFile: LOOP_LOG_FILE,
  });
});

/**
 * GET /api/loop/logs — últimas líneas del log del motor
 */
app.get('/api/loop/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  try {
    if (fs.existsSync(LOOP_LOG_FILE)) {
      const content = fs.readFileSync(LOOP_LOG_FILE, 'utf8');
      const allLines = content.split('\n');
      const lastLines = allLines.slice(-lines).join('\n');
      res.type('text/plain').send(lastLines);
    } else {
      res.type('text/plain').send('Sin logs todavía.');
    }
  } catch (err) {
    res.status(500).type('text/plain').send(`Error leyendo logs: ${err.message}`);
  }
});

/**
 * POST /api/loop/start — inicia el motor usando loop.js (flujo completo con git)
 */
app.post('/api/loop/start', async (req, res) => {
  // Verificar si ya está corriendo
  const existingPid = readLoopPid();
  if (existingPid) {
    return res.json({ success: false, error: 'El motor ya está corriendo', pid: existingPid });
  }

  const engineData = readEngine();
  const engine = engineData.engine || 'opencode';
  const { once } = req.body || {};

  // Verificar que hay tareas
  const kanbanPath = getActiveKanbanPath();
  const todoTasks = getTasks('todo', kanbanPath);
  if (todoTasks.length === 0) {
    return res.json({ success: false, error: 'No hay tareas en TODO' });
  }

  const firstTask = todoTasks[0];

  // Lanzar el loop como proceso independiente
  const args = [CLI_PATH, 'start', '--engine', engine];
  if (once) args.push('--once');
  
  const loopProc = spawn('node', args, {
    cwd: path.resolve(__dirname, '../../'),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AI_ENGINE: engine },
  });
  loopProc.unref();

  console.log(`[Motor] Lanzado con engine: ${engine}, once: ${!!once}, log: ${LOOP_LOG_FILE}`);

  // Esperar a que loop.js escriba su PID file y arranque
  let retries = 0;
  const waitForPid = setInterval(() => {
    retries++;
    const pid = readLoopPid();
    if (pid) {
      clearInterval(waitForPid);
      console.log(`[Motor] PID confirmado: ${pid}`);
      if (!once) startLoopPolling(engine);
    } else if (retries > 10) {
      clearInterval(waitForPid);
      console.log('[Motor] Timeout esperando PID — el motor puede haber fallado');
      if (!once) startLoopPolling(engine);
    }
  }, 1000);

  broadcastChange('loop:started', { taskId: firstTask.id, title: firstTask.title });

  res.json({
    success: true,
    engine,
    taskId: firstTask.id,
    title: firstTask.title,
    todoCount: todoTasks.length,
    logFile: LOOP_LOG_FILE,
    message: once 
      ? `Procesando tarea #${firstTask.id}`
      : `Motor iniciado — ${todoTasks.length} tareas en cola`,
  });
});

/**
 * POST /api/loop/stop — detiene el motor
 */
app.post('/api/loop/stop', (req, res) => {
  // Detener polling
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }

  // Matar el proceso del loop
  const pid = readLoopPid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[Motor] Enviado SIGTERM a PID ${pid}`);
    } catch (err) {
      console.log(`[Motor] Error matando PID ${pid}: ${err.message}`);
    }
  }

  // Limpiar archivos temporales
  try { fs.unlinkSync(TASK_STATUS_FILE); } catch {}

  broadcastChange('loop:stopped', {});
  res.json({ success: true, message: 'Motor detenido' });
});

/**
 * GET /api/health - Health check con estado del caché
 */
app.get('/api/health', (req, res) => {
  const kanbanPath = getActiveKanbanPath();
  res.json({
    status: 'ok',
    kanbanPath,
    timestamp: new Date().toISOString(),
    cache: cache.getStatus(),
  });
});

// ─────────────────────────────────────────────
// API ENDPOINTS — NOTIFICACIONES
// ─────────────────────────────────────────────
// API ENDPOINTS — SYNC
// ─────────────────────────────────────────────

/**
 * GET /api/sync - Estado de sincronización
 */
app.get('/api/sync', (req, res) => {
  res.json({ success: true, ...sync.getStatus() });
});

/**
 * POST /api/sync - Solicitar sincronización manual
 */
app.post('/api/sync', (req, res) => {
  try {
    sync.requestSync();
    res.json({ success: true, message: 'Sincronización solicitada' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────

/**
 * GET /api/notifications - Obtener notificaciones
 */
app.get('/api/notifications', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const unreadOnly = req.query.unread === 'true';
  const items = notifications.getAll({ limit, unreadOnly });
  const unreadCount = notifications.getUnreadCount();
  res.json({ success: true, data: items, unreadCount });
});

/**
 * PUT /api/notifications/read - Marcar notificaciones como leídas
 */
app.put('/api/notifications/read', (req, res) => {
  const { id } = req.body;
  if (id) {
    const notif = notifications.markRead(id);
    if (!notif) {
      return res.status(404).json({ success: false, error: 'Notificación no encontrada' });
    }
    res.json({ success: true, data: notif });
  } else {
    const count = notifications.markAllRead();
    res.json({ success: true, markedRead: count });
  }
});

// ─────────────────────────────────────────────
// INICIAR SERVIDOR con WebSocket
// ─────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  notifications.addClient(ws);

  // Enviar estado inicial
  ws.send(JSON.stringify({
    event: 'connected',
    data: { unreadCount: notifications.getUnreadCount() },
  }));

  ws.on('close', () => {
    notifications.removeClient(ws);
  });

  ws.on('error', () => {
    notifications.removeClient(ws);
  });
});

cache.connect().then(() => {
  const kanbanPath = getActiveKanbanPath();
  sync.connectSync(kanbanPath, (msg) => {
    cache.flush();
    broadcastChange(msg.type);
    notifications.create({
      type: NOTIFICATION_TYPES.SYSTEM,
      title: 'Sincronización',
      message: `Cambio recibido de otro equipo`,
      meta: msg,
    });
  });
  
  server.listen(PORT, () => {
    console.log(`\n🖥  AI-Kanban UI corriendo en: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket activo en: ws://localhost:${PORT}/ws`);
    console.log(`📁 Kanban path: ${kanbanPath}`);
    const syncStatus = sync.getStatus();
    console.log(`🔄 Sync: ${syncStatus.connected ? 'conectado' : 'desconectado'} (${syncStatus.relayUrl})`);
    const cacheStatus = cache.getStatus();
    console.log(`🗄  Cache Redis: ${cacheStatus.connected ? `conectado (${cacheStatus.url})` : 'no disponible (modo sin caché)'}\n`);
  });
});

module.exports = app;
