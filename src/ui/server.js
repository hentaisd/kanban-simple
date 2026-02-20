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
const { generateBranchName, writeTask, KANBAN_PATH, getKanbanPath, COLUMNS } = require('../core/task');
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
// SSE - Server-Sent Events para sync en tiempo real
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
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
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

    const task = createTask({
      id,
      title,
      type,
      priority,
      branch,
      labels,
      dependsOn,
      content: content || `# Descripción\n${title}\n\n# Criterios de aceptación\n- Implementar ${title}`,
    }, column, kanbanPath);

    await invalidateTaskCache(id, [column], kanbanPath);
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
    const kanbanPath = getActiveKanbanPath();
    const { column } = req.body;
    if (!column) {
      return res.status(400).json({ success: false, error: 'El campo column es requerido' });
    }

    const result = moveTask(req.params.id, column, kanbanPath);
    await invalidateTaskCache(req.params.id, [result.fromColumn, result.toColumn], kanbanPath);
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
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Tarea no encontrada' });
    }

    const updatedTask = { ...found.task, ...req.body };
    writeTask(updatedTask, found.filePath);

    await invalidateTaskCache(req.params.id, [found.column], kanbanPath);
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
    const kanbanPath = getActiveKanbanPath();
    const found = await getTaskByIdCached(req.params.id, kanbanPath);
    const column = found ? found.column : null;

    deleteTask(req.params.id, kanbanPath);
    await invalidateTaskCache(req.params.id, [column], kanbanPath);
    broadcastChange('deleted');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
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
// CONTROL DEL MOTOR IA — abre gnome-terminal
// ─────────────────────────────────────────────
const { spawn, execSync } = require('child_process');
const CLI_PATH  = path.join(__dirname, '../../src/cli/index.js');
const PID_FILE  = '/tmp/kanban-loop.pid';
const TASK_STATUS_FILE = '/tmp/kanban-task-status.json';

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

// Polling para detectar cuando termina una tarea
let taskPollInterval = null;
function startTaskPolling(taskId, engine) {
  if (taskPollInterval) clearInterval(taskPollInterval);
  
  taskPollInterval = setInterval(() => {
    try {
      if (fs.existsSync(TASK_STATUS_FILE)) {
        const status = JSON.parse(fs.readFileSync(TASK_STATUS_FILE, 'utf8'));
        if (status.taskId === taskId && status.status === 'done') {
          clearInterval(taskPollInterval);
          taskPollInterval = null;
          
          // Mover tarea a done
          const kanbanPath = getActiveKanbanPath();
          moveTask(taskId, 'done', kanbanPath);
          broadcastChange('task:completed', { taskId, title: status.title });
          
          // Notificación del sistema
          spawn('notify-send', ['AI-Kanban', `Tarea #${taskId} completada: ${status.title}`]);
          
          // Limpiar archivo de estado
          fs.unlinkSync(TASK_STATUS_FILE);
          
          // Buscar siguiente tarea
          setTimeout(() => processNextTask(engine), 2000);
        }
      }
    } catch {}
  }, 2000);
}

// Crear script para ejecutar tarea
function createTaskScript(task, engine) {
  const taskId = task.id;
  const taskTitle = (task.title || '').replace(/'/g, "'\\''");
  const taskContent = (task.content || '').replace(/'/g, "'\\''");
  const prompt = `TAREA #${taskId}: ${taskTitle}. ${taskContent}`;
  
  const script = `#!/bin/bash
cd /home/phantom/Documents/proyectos/tennat-app-com

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  AI-KANBAN - TAREA #${taskId}"
echo "  ${taskTitle}"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  Motor: ${engine.toUpperCase()}"
echo "  Estado: Trabajando..."
echo ""

# Ejecutar IA
${engine === 'opencode' 
  ? `opencode run '${prompt}' --dir /home/phantom/Documents/proyectos/tennat-app-com`
  : `claude -p '${prompt}' --dangerously-skip-permissions`}

EXIT_CODE=$?

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ $EXIT_CODE -eq 0 ]; then
  echo "  ✓ Tarea completada"
else
  echo "  ✗ Error: código $EXIT_CODE"
fi
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  Cerrando en 2 segundos..."
sleep 2

# Guardar estado de completado
echo '{"taskId":${taskId},"status":"done","title":"${taskTitle}"}' > ${TASK_STATUS_FILE}
exit
`;
  
  const scriptPath = `/tmp/ai-kanban-task-${taskId}.sh`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

// Auto-start: procesar tareas automáticamente al iniciar
let autoProcessInterval = null;

function startAutoProcessing() {
  if (autoProcessInterval) return;
  
  autoProcessInterval = setInterval(async () => {
    const kanbanPath = getActiveKanbanPath();
    const todoTasks = getTasks('todo', kanbanPath);
    const inProgressTasks = getTasks('in_progress', kanbanPath);
    
    // Si hay tareas en TODO y ninguna en progreso, empezar una
    if (todoTasks.length > 0 && inProgressTasks.length === 0) {
      console.log('[Auto] Iniciando siguiente tarea automáticamente...');
      const engineData = readEngine();
      const engine = engineData.engine || 'opencode';
      await processNextTask(engine);
    }
  }, 5000); // Revisar cada 5 segundos
}

function stopAutoProcessing() {
  if (autoProcessInterval) {
    clearInterval(autoProcessInterval);
    autoProcessInterval = null;
  }
}

// Procesar siguiente tarea automáticamente
async function processNextTask(engine) {
  const kanbanPath = getActiveKanbanPath();
  const todoTasks = getTasks('todo', kanbanPath);
  const task = todoTasks[0];
  
  if (!task) {
    broadcastChange('loop:stopped', {});
    return;
  }
  
  const title = `AI-Kanban — ${engine.toUpperCase()}`;
  const scriptPath = createTaskScript(task, engine);
  
  spawn('gnome-terminal', ['--title', title, '--', 'bash', '-c', `bash '${scriptPath}'`], { detached: true, stdio: 'ignore' }).unref();
  moveTask(task.id, 'in_progress', kanbanPath);
  broadcastChange('loop:started', { taskId: task.id });
  startTaskPolling(task.id, engine);
}

/**
 * GET /api/loop/status
 */
app.get('/api/loop/status', (req, res) => {
  const pid = readLoopPid();
  res.json({ status: pid ? 'running' : 'stopped', pid: pid || null });
});

/**
 * POST /api/loop/start — inicia el procesamiento automático
 */
app.post('/api/loop/start', async (req, res) => {
  const engineData = readEngine();
  const engine = engineData.engine || 'opencode';

  // Leer la primera tarea en TODO
  const kanbanPath = getActiveKanbanPath();
  const todoTasks = getTasks('todo', kanbanPath);
  const task = todoTasks[0];

  if (!task) {
    return res.json({ success: false, error: 'No hay tareas en TODO' });
  }

  // Iniciar procesamiento automático
  startAutoProcessing();

  const scriptPath = createTaskScript(task, engine);

  // Abrir terminal
  spawn('gnome-terminal', ['--title', `AI-Kanban — ${engine.toUpperCase()}`, '--', 'bash', '-c', `bash '${scriptPath}'`], { detached: true, stdio: 'ignore' }).unref();

  // Mover tarea a in_progress
  moveTask(task.id, 'in_progress', kanbanPath);
  broadcastChange('loop:started', { taskId: task.id });

  // Iniciar polling para detectar cuando termine
  startTaskPolling(task.id, engine);

  res.json({ success: true, engine, taskId: task.id, title: task.title, message: 'Procesamiento automático iniciado' });
});

/**
 * POST /api/loop/stop — detiene el procesamiento de tareas
 */
app.post('/api/loop/stop', (req, res) => {
  stopAutoProcessing();
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }
  try { fs.unlinkSync(TASK_STATUS_FILE); } catch {}
  broadcastChange('loop:stopped', {});
  res.json({ success: true, message: 'Procesamiento automático detenido' });
});

/**
 * POST /api/loop/start — abre una terminal con la IA y la tarea
 */
app.post('/api/loop/start', async (req, res) => {
  const engineData = readEngine();
  const engine = engineData.engine || 'opencode';
  const title = `AI-Kanban — ${engine.toUpperCase()}`;

  // Leer la primera tarea en TODO
  const kanbanPath = getActiveKanbanPath();
  const todoTasks = getTasks('todo', kanbanPath);
  const task = todoTasks[0];

  if (!task) {
    return res.json({ success: false, error: 'No hay tareas en TODO' });
  }

  // Prompt simple
  const prompt = `TAREA #${task.id}: ${task.title}. ${task.content || ''}`.replace(/'/g, "'\\''");

  // Comando: ejecuta IA, guarda estado cuando termina, y cierra
  let cmd;
  if (engine === 'opencode') {
    cmd = `cd /home/phantom/Documents/proyectos/tennat-app-com && opencode run '${prompt}' --dir /home/phantom/Documents/proyectos/tennat-app-com; echo '{"taskId":${task.id},"status":"done","title":"${task.title.replace(/"/g, '\\"')}"}' > ${TASK_STATUS_FILE}; exit`;
  } else {
    cmd = `cd /home/phantom/Documents/proyectos/tennat-app-com && claude '${prompt}' --dangerously-skip-permissions; echo '{"taskId":${task.id},"status":"done","title":"${task.title.replace(/"/g, '\\"')}"}' > ${TASK_STATUS_FILE}; exit`;
  }

  // Abrir terminal
  spawn('gnome-terminal', ['--title', title, '--', 'bash', '-c', cmd], { detached: true, stdio: 'ignore' }).unref();

  // Mover tarea a in_progress
  moveTask(task.id, 'in_progress', kanbanPath);
  broadcastChange('loop:started', { taskId: task.id });

  // Iniciar polling para detectar cuando termine
  startTaskPolling(task.id, engine);

  res.json({ success: true, engine, taskId: task.id, title: task.title });
});

/**
 * POST /api/loop/stop — detiene el procesamiento de tareas
 */
app.post('/api/loop/stop', (req, res) => {
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }
  try { fs.unlinkSync(TASK_STATUS_FILE); } catch {}
  broadcastChange('loop:stopped', {});
  res.json({ success: true });
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
// INICIAR SERVIDOR
// ─────────────────────────────────────────────
cache.connect().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🖥  AI-Kanban UI corriendo en: http://localhost:${PORT}`);
    console.log(`📁 Kanban path: ${getActiveKanbanPath()}`);
    const cacheStatus = cache.getStatus();
    console.log(`🗄  Cache Redis: ${cacheStatus.connected ? `conectado (${cacheStatus.url})` : 'no disponible (modo sin caché)'}\n`);
  });
});

module.exports = app;
