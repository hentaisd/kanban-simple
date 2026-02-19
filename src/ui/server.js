/**
 * server.js - API REST + servidor de archivos estáticos para el Kanban UI
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
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
const { generateBranchName, writeTask, KANBAN_PATH } = require('../core/task');
const cache = require('../core/cache');
const { getHistory } = require('../core/history');
const GitService = require('../git/gitService');

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
// SSE - Server-Sent Events para sync en tiempo real
// ─────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Enviar evento inicial
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastChange(type = 'update', extra = {}) {
  const data = JSON.stringify({ type, timestamp: Date.now(), ...extra });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Watcher de archivos para detectar cambios en el filesystem
// También invalida el caché para mantener consistencia con cambios desde CLI
const watcher = chokidar.watch(KANBAN_PATH, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true,
});

watcher.on('all', () => {
  cache.flush();
  broadcastChange('update');
});

// ─────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────

/**
 * GET /api/tasks - Obtener todas las tareas agrupadas por columna
 */
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await getTasksCached();
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
    const found = await getTaskByIdCached(req.params.id);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }
    res.json({ success: true, data: found.task });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tasks - Crear nueva tarea
 */
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, type = 'feature', priority = 'media', labels = [], column = 'backlog', content, dependsOn = [], projectPath: taskProjectPath = null } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'El título es requerido' });
    }

    const id = nextId();
    const branch = generateBranchName(type, title);

    const task = createTask({
      id,
      title,
      type,
      priority,
      branch,
      labels,
      dependsOn,
      projectPath: taskProjectPath,
      content: content || `# Descripción\n${title}\n\n# Criterios de aceptación\n- Implementar ${title}`,
    }, column);

    await invalidateTaskCache(id, [column]);
    broadcastChange('created');
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
    const { column } = req.body;
    if (!column) {
      return res.status(400).json({ success: false, error: 'El campo column es requerido' });
    }

    const result = moveTask(req.params.id, column);
    await invalidateTaskCache(req.params.id, [result.fromColumn, result.toColumn]);
    broadcastChange('moved');
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
    const found = await getTaskByIdCached(req.params.id);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    const updatedTask = { ...found.task, ...req.body };
    writeTask(updatedTask, found.filePath);

    await invalidateTaskCache(req.params.id, [found.column]);
    broadcastChange('updated');

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
    const found = await getTaskByIdCached(req.params.id);
    const column = found ? found.column : null;

    deleteTask(req.params.id);
    await invalidateTaskCache(req.params.id, [column]);
    broadcastChange('deleted');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GESTIÓN DE PROYECTOS (persiste en projects.json)
// ─────────────────────────────────────────────
const PROJECTS_FILE = path.join(KANBAN_PATH, 'projects.json');
const ACTIVE_PROJECT_FILE = path.join(KANBAN_PATH, '.active-project.json');

function readProjectsFile() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    }
  } catch {}
  // Fallback: leer desde kanban.config.js
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

    const list = readProjectsFile();
    if (list.find(p => p.name === name)) {
      return res.status(400).json({ success: false, error: `El proyecto "${name}" ya existe` });
    }

    const newProject = { name, path: projectPath, git: git || {} };
    list.push(newProject);
    writeProjectsFile(list);

    // Si es el primero, activarlo automáticamente
    if (list.length === 1) {
      writeActiveProject({ name, setAt: new Date().toISOString() });
    }

    broadcastChange('projects:updated');
    res.status(201).json({ success: true, data: newProject });
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
    const filtered = list.filter(p => p.name !== req.params.name);
    if (filtered.length === list.length) {
      return res.status(404).json({ success: false, error: 'Proyecto no encontrado' });
    }
    writeProjectsFile(filtered);

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
    broadcastChange('project:changed', { project: name });
    res.json({ success: true, active: name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id/history - Historial de ejecución de una tarea
 */
app.get('/api/tasks/:id/history', async (req, res) => {
  try {
    const history = getHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/tasks/:id/diff - Diff del branch de la tarea vs rama principal
 */
app.get('/api/tasks/:id/diff', async (req, res) => {
  try {
    const found = await getTaskByIdCached(req.params.id);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    let cfg = {};
    try { cfg = require('../../kanban.config.js'); } catch {}
    const defaultBranch = cfg.git?.defaultBranch || 'main';
    const projectPath = found.task.projectPath || cfg.projectPath || process.cwd();

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
 * GET /api/metrics - Estadísticas agregadas del tablero
 */
app.get('/api/metrics', async (req, res) => {
  try {
    const allTasks = getTasks();
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
    const found = await getTaskByIdCached(req.params.id);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    let cfg = {};
    try { cfg = require('../../kanban.config.js'); } catch {}
    const defaultBranch = cfg.git?.defaultBranch || 'main';
    const projectPath = found.task.projectPath || cfg.projectPath || process.cwd();

    const gitService = new GitService(projectPath);
    try {
      await gitService.rollback(defaultBranch);
    } catch (e) {
      console.log(`Rollback git warning: ${e.message}`);
    }

    const result = moveTask(req.params.id, 'review');
    await invalidateTaskCache(req.params.id, [result.fromColumn, 'review']);
    broadcastChange('moved', { taskId: req.params.id });

    res.json({ success: true, message: 'Rollback ejecutado, tarea movida a review' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/health - Health check con estado del caché
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    kanbanPath: KANBAN_PATH,
    timestamp: new Date().toISOString(),
    cache: cache.getStatus(),
  });
});

// ─────────────────────────────────────────────
// INICIAR SERVIDOR
// ─────────────────────────────────────────────
cache.connect().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🖥  AI-Kanban UI corriendo en: http://localhost:${PORT}`);
    console.log(`📁 Kanban path: ${KANBAN_PATH}`);
    const cacheStatus = cache.getStatus();
    console.log(`🗄  Cache Redis: ${cacheStatus.connected ? `conectado (${cacheStatus.url})` : 'no disponible (modo sin caché)'}\n`);
  });
});

module.exports = app;
