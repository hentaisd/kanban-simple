/**
 * loop.js — Ciclo de procesamiento de tareas
 *
 * Flujo por cada tarea:
 *   1. Lee config (projectPath, engine, git)
 *   2. Verifica dependencias (dependsOn)
 *   3. Mueve tarea: todo → in_progress (actualiza startedAt)
 *   4. Git: checkout main → crear branch de tarea
 *   5. Ciclo IA: PLAN → CODE → REVIEW → TEST (máx 3 iteraciones)
 *   6. Git: add → commit → push → merge (si autoPush)
 *   7. Si falla → rollback git
 *   8. Mueve tarea: in_progress → done | review (actualiza completedAt/iterations)
 *   9. Guarda historial de ejecución
 */

const path = require('path');
const fs   = require('fs');
const chalk = require('chalk');
const { getTasks, moveTask, getTaskById } = require('../kanban/board');
const { writeTask, getKanbanPath } = require('./task');
const { executeTask, detectAvailableEngine, killCurrentPhase, notify } = require('./ai-executor');
const { saveExecution } = require('./history');
const GitService = require('../git/gitService');

// ── PID file ──────────────────────────────────────────────────
const PID_FILE = '/tmp/kanban-loop.pid';
fs.writeFileSync(PID_FILE, String(process.pid));
const cleanPid = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
process.on('exit', cleanPid);
process.on('uncaughtException', (err) => { cleanPid(); console.error(err); process.exit(1); });

// Al recibir SIGTERM: matar el subprocess de IA y salir limpiamente
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n  ⏹ Señal de parada — terminando tarea actual...'));
  killCurrentPhase();
  setTimeout(() => process.exit(0), 500);
});

const KANBAN_ROOT = path.resolve(__dirname, '../../');
const KANBAN_DIR = path.join(KANBAN_ROOT, 'kanban');
const ACTIVE_PROJECT_FILE = path.join(KANBAN_DIR, '.active-project.json');
const PROJECTS_FILE = path.join(KANBAN_DIR, 'projects.json');

// ─────────────────────────────────────────────
// CARGAR CONFIG
// ─────────────────────────────────────────────

function loadConfig(overrides = {}) {
  let cfg = {};
  const cfgPath = path.join(KANBAN_ROOT, 'kanban.config.js');
  try {
    delete require.cache[require.resolve(cfgPath)];
    cfg = require(cfgPath);
  } catch {
    cfg = {};
  }

  // Leer engine desde archivo global (compartido con UI)
  const engineFile = '/tmp/ai-kanban-engine.json';
  let savedEngine = null;
  try {
    if (fs.existsSync(engineFile)) {
      const engineData = JSON.parse(fs.readFileSync(engineFile, 'utf8'));
      savedEngine = engineData.engine;
    }
  } catch {}

  // Variable de entorno AI_ENGINE tiene prioridad (viene del UI)
  const envEngine = process.env.AI_ENGINE || null;
  
  // Orden de prioridad: CLI flag > env var > archivo guardado > config > default
  const finalEngine = overrides.engine || envEngine || savedEngine || cfg.engine || 'opencode';
  
  // Debug: mostrar de dónde viene el engine
  console.log(chalk.cyan(`  Motor IA: ${chalk.bold(finalEngine)}`));
  if (overrides.engine) {
    console.log(chalk.gray(`    (desde CLI: --engine ${overrides.engine})`));
  } else if (envEngine) {
    console.log(chalk.gray(`    (desde variable de entorno)`));
  } else if (savedEngine) {
    console.log(chalk.gray(`    (desde configuración guardada)`));
  }

  return {
    projects:       cfg.projects      || {},
    defaultProject: cfg.defaultProject || '',
    projectPath:    overrides.project || cfg.projectPath || process.cwd(),
    engine:         finalEngine,
    git: {
      enabled:       cfg.git?.enabled       ?? true,
      defaultBranch: cfg.git?.defaultBranch ?? 'main',
      autoPush:      cfg.git?.autoPush      ?? false,
      autoMerge:     cfg.git?.autoMerge     ?? true,
    },
    loop: {
      waitSeconds:    cfg.loop?.waitSeconds    ?? 30,
      maxTasksPerRun: cfg.loop?.maxTasksPerRun ?? 0,
    },
  };
}

/**
 * Lee el proyecto activo y resuelve su path desde projects.json
 */
function readActiveProject() {
  try {
    if (fs.existsSync(ACTIVE_PROJECT_FILE)) {
      const { name } = JSON.parse(fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8'));
      if (name && fs.existsSync(PROJECTS_FILE)) {
        const list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        return list.find(p => p.name === name) || null;
      }
    }
  } catch {}
  return null;
}

/**
 * Resuelve el projectPath a usar.
 * Orden: proyecto activo (UI/projects.json) → defaultProject (config) → projectPath global
 */
function resolveProjectPath(config) {
  const active = readActiveProject();
  if (active?.path) return active.path;

  if (config.defaultProject && config.projects[config.defaultProject]) {
    return config.projects[config.defaultProject].path;
  }
  return config.projectPath;
}

/**
 * Resuelve la config git para el proyecto activo.
 */
function resolveGitConfig(config) {
  const active = readActiveProject();
  const projectGit = active?.git || {};
  return {
    enabled:       projectGit.enabled       ?? config.git.enabled,
    defaultBranch: projectGit.defaultBranch ?? config.git.defaultBranch,
    autoPush:      projectGit.autoPush      ?? config.git.autoPush,
    autoMerge:     projectGit.autoMerge     ?? config.git.autoMerge,
  };
}

// ─────────────────────────────────────────────
// COUNTDOWN
// ─────────────────────────────────────────────

function wait(seconds) {
  return new Promise((resolve) => {
    let rem = seconds;
    const iv = setInterval(() => {
      process.stdout.write(chalk.gray(`\r  ⏳ ${rem}s hasta próxima revisión... (Ctrl+C para salir)   `));
      rem--;
      if (rem < 0) {
        clearInterval(iv);
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        resolve();
      }
    }, 1000);
  });
}

// ─────────────────────────────────────────────
// VERIFICAR DEPENDENCIAS
// ─────────────────────────────────────────────

/**
 * Comprueba si todas las dependencias de una tarea están en 'done'.
 * @param {Object} task - Tarea a verificar
 * @returns {{ ok: boolean, blocking: string[] }} - blocking = IDs que no están en done
 */
function checkDependencies(task, kanbanPath) {
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  if (deps.length === 0) return { ok: true, blocking: [] };

  const doneTasks = getTasks('done', kanbanPath);
  const doneIds = doneTasks.map(t => String(t.id).padStart(3, '0'));

  const blocking = deps.filter(depId => {
    const padded = String(depId).padStart(3, '0');
    return !doneIds.includes(padded);
  });

  return { ok: blocking.length === 0, blocking };
}

// ─────────────────────────────────────────────
// ACTUALIZAR FRONTMATTER DE TAREA
// ─────────────────────────────────────────────

function updateTaskFields(taskId, fields, kanbanPath) {
  try {
    const found = getTaskById(taskId, kanbanPath);
    if (!found) return;
    const updated = { ...found.task, ...fields };
    writeTask(updated, found.filePath);
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ No se pudo actualizar campos de tarea ${taskId}: ${err.message}`));
  }
}

// ─────────────────────────────────────────────
// PROCESAR UNA TAREA
// ─────────────────────────────────────────────

async function processTask(task, config) {
  const { engine, interactive } = config;

  const taskProjectPath = resolveProjectPath(config);
  const kanbanPath = getKanbanPath(taskProjectPath);
  const gitCfg = resolveGitConfig(config);

  console.log(chalk.blue.bold(`\n${'═'.repeat(62)}`));
  console.log(chalk.blue.bold(`  🚀 TAREA #${task.id}: ${task.title}`));
  console.log(chalk.blue.bold(`${'═'.repeat(62)}`));
  console.log(chalk.gray(`  tipo: ${task.type}  |  prioridad: ${task.priority}`));
  console.log(chalk.gray(`  branch: ${task.branch}`));
  console.log(chalk.gray(`  proyecto: ${chalk.white(taskProjectPath)}`));
  console.log(chalk.gray(`  engine: ${chalk.white(engine)}`));
  if (interactive) {
    console.log(chalk.magenta(`  modo: INTERACTIVO`));
  }
  console.log('');

  // ── PASO 1: todo → in_progress + actualizar startedAt ───
  moveTask(task.id, 'in_progress', kanbanPath);
  updateTaskFields(task.id, { startedAt: new Date().toISOString() }, kanbanPath);
  console.log(chalk.cyan('  ▶ Estado: in_progress'));

  const gitService = new GitService(taskProjectPath);
  let taskResult = null;
  let gitEnabled = false;

  try {
    // ── PASO 2: git checkout + crear branch ──
    if (gitCfg.enabled) {
      const isRepo = await gitService.isGitRepo();
      if (isRepo) {
        gitEnabled = true;
        try {
          const stashed = await gitService.stashIfNeeded();
          if (stashed) console.log(chalk.cyan('  ▶ Git: cambios pendientes guardados con stash'));
          console.log(chalk.cyan(`  ▶ Git: checkout ${gitCfg.defaultBranch}`));
          await gitService.checkout(gitCfg.defaultBranch);
          await gitService.createBranch(task.branch);
          console.log(chalk.cyan(`  ▶ Git: branch ${task.branch} creado`));
        } catch (e) {
          console.log(chalk.yellow(`  ⚠ Git branch: ${e.message} (continúa sin branch)`));
        }
      } else {
        console.log(chalk.gray('  ⚠ El projectPath no es un repo git'));
      }
    }

    // ── PASO 3: ejecutar con CLI ─────────────
    taskResult = await executeTask(task, { projectPath: taskProjectPath, engine, kanbanPath, interactive });

    // ── PASO 4: git add + commit ─────────────
    if (gitEnabled && taskResult?.success) {
      const prefix = task.type === 'feature' ? 'feat' : task.type;
      const commitMsg = `${prefix}(${task.id}): ${task.title}`;
      try {
        await gitService.addAll();
        await gitService.commit(commitMsg);
        console.log(chalk.cyan(`  ▶ Git: commit "${commitMsg}"`));

        if (gitCfg.autoPush) {
          await gitService.push(task.branch);
          console.log(chalk.cyan(`  ▶ Git: push origin ${task.branch}`));
        }

        if (gitCfg.autoMerge) {
          await gitService.checkout(gitCfg.defaultBranch);
          await gitService.merge(task.branch);
          console.log(chalk.cyan(`  ▶ Git: merge a ${gitCfg.defaultBranch}`));
        }
      } catch (e) {
        console.log(chalk.yellow(`  ⚠ Git post-tarea: ${e.message}`));
      }
    }

    // ── PASO 4b: rollback si falló ───────────
    if (gitEnabled && taskResult && !taskResult.success) {
      try {
        console.log(chalk.yellow('  ⚠ Tarea fallida — ejecutando rollback git'));
        await gitService.rollback(gitCfg.defaultBranch);
      } catch (e) {
        console.log(chalk.yellow(`  ⚠ Rollback falló: ${e.message}`));
      }
    }

  } catch (err) {
    taskResult = { success: false, reason: err.message, phasesRecord: null };
    if (gitEnabled) {
      try {
        await gitService.rollback(gitCfg.defaultBranch);
      } catch {}
    }
  }

  const now = new Date().toISOString();

  // ── PASO 5: mover a done o review + timestamps ───────────
  if (taskResult?.success && !taskResult.scopeIncomplete) {
    moveTask(task.id, 'done', kanbanPath);
    updateTaskFields(task.id, {
      completedAt: now,
      iterations: taskResult.iterations || 1,
    }, kanbanPath);
    console.log(chalk.green(`\n  ✅ DONE — ${taskResult.summary}`));
    if (taskResult.iterations > 1) {
      console.log(chalk.gray(`     (completado en ${taskResult.iterations} iteraciones)`));
    }
  } else if (taskResult?.success && taskResult.scopeIncomplete) {
    moveTask(task.id, 'review', kanbanPath);
    updateTaskFields(task.id, {
      completedAt: now,
      iterations: taskResult.iterations || 1,
    }, kanbanPath);
    console.log(chalk.yellow(`\n  ⚠ SCOPE INCOMPLETO → REVIEW`));
    console.log(chalk.yellow(`     ${taskResult.scopeNote}`));
  } else {
    moveTask(task.id, 'review', kanbanPath);
    updateTaskFields(task.id, { completedAt: now }, kanbanPath);
    console.log(chalk.yellow(`\n  ⚠  REVIEW — ${taskResult?.reason ?? 'Error desconocido'}`));
  }

  // ── PASO 6: guardar historial ────────────────────────────
  if (taskResult?.phasesRecord) {
    try {
      saveExecution(task.id, {
        result: taskResult.success ? 'success' : 'failed',
        totalDuration: taskResult.phasesRecord.totalDuration,
        iterations: taskResult.iterations || 0,
        summary: taskResult.success ? taskResult.summary : taskResult.reason,
        phases: {
          plan: taskResult.phasesRecord.plan,
          code: taskResult.phasesRecord.code,
          review: taskResult.phasesRecord.review,
          test: taskResult.phasesRecord.test,
          scope: taskResult.phasesRecord.scope,
        },
      });
    } catch (err) {
      console.log(chalk.gray(`  ⚠ No se pudo guardar historial: ${err.message}`));
    }
  }

  return taskResult;
}

// ─────────────────────────────────────────────
// LOOP PRINCIPAL
// ─────────────────────────────────────────────

async function startLoop(cliOverrides = {}) {
  const config = loadConfig(cliOverrides);
  const { waitSeconds, maxTasksPerRun } = config.loop;
  const dryRun = cliOverrides.dryRun || false;
  const interactive = cliOverrides.interactive || false;

  // Validar que el engine esté disponible
  const engine = detectAvailableEngine(config.engine);
  if (!engine && !dryRun) {
    console.log(chalk.red('\n  ❌ No se encontró ningún CLI (claude ni opencode).'));
    console.log(chalk.gray('     Instala uno de los dos para poder ejecutar tareas.\n'));
    process.exit(1);
  }

  console.log(chalk.blue.bold('\n  AI-Kanban — Motor iniciado'));
  console.log(chalk.gray(`  Proyecto : ${config.projectPath}`));
  console.log(chalk.gray(`  Engine   : ${engine || 'dry-run'}`));
  console.log(chalk.gray(`  Git      : ${config.git.enabled ? 'activado' : 'desactivado'}`));
  console.log(chalk.gray(`  Espera   : ${waitSeconds}s entre ciclos`));
  if (interactive) {
    console.log(chalk.magenta(`  Modo     : INTERACTIVO`));
  }
  console.log('');

  let cycle = 0;
  let processed = 0;

  while (true) {
    cycle++;
    console.log(chalk.gray(`\n  [ciclo ${cycle}]  ${new Date().toLocaleTimeString()}`));

    const resolvedProjectPath = resolveProjectPath(config);
    const loopKanbanPath = getKanbanPath(resolvedProjectPath);
    const todoTasks = getTasks('todo', loopKanbanPath);

    if (todoTasks.length === 0) {
      console.log(chalk.gray('  Sin tareas en TODO.'));
      if (cliOverrides.once) break;
      await wait(waitSeconds);
      continue;
    }

    console.log(chalk.gray(`  ${todoTasks.length} tarea(s) en TODO`));

    // Buscar la primera tarea sin dependencias bloqueantes
    let taskToProcess = null;
    for (const candidate of todoTasks) {
      const { ok, blocking } = checkDependencies(candidate, loopKanbanPath);
      if (ok) {
        taskToProcess = candidate;
        break;
      } else {
        console.log(chalk.yellow(`  ⏭ [${candidate.id}] ${candidate.title} — bloqueada por: ${blocking.join(', ')}`));
      }
    }

    if (!taskToProcess) {
      console.log(chalk.yellow('  Todas las tareas en TODO están bloqueadas por dependencias.'));
      if (cliOverrides.once) break;
      await wait(waitSeconds);
      continue;
    }

    console.log(chalk.cyan(`  → [${taskToProcess.id}] ${taskToProcess.title}`));

    if (dryRun) {
      console.log(chalk.yellow('  🔍 DRY RUN: se simula sin ejecutar\n'));
      moveTask(taskToProcess.id, 'in_progress', loopKanbanPath);
      await new Promise(r => setTimeout(r, 1000));
      moveTask(taskToProcess.id, 'done', loopKanbanPath);
      console.log(chalk.green('  ✅ DONE (simulado)'));
    } else {
      await processTask(taskToProcess, { ...config, engine, interactive });
    }

    processed++;

    if (cliOverrides.once) break;
    if (maxTasksPerRun > 0 && processed >= maxTasksPerRun) {
      console.log(chalk.blue(`\n  Límite de ${maxTasksPerRun} tareas alcanzado. Deteniendo.`));
      break;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  notify('AI-Kanban', `Motor detenido. ${processed} tareas procesadas.`);
  console.log(chalk.blue('\n  Motor detenido.\n'));
}

module.exports = { startLoop, processTask, loadConfig };
