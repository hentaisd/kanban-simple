/**
 * loop.js — Ciclo de procesamiento de tareas
 *
 * Flujo por cada tarea:
 *   1. Lee config (projectPath, engine, git) — resuelve proyecto activo
 *   2. Verifica dependencias (dependsOn)
 *   3. Mueve tarea: todo → in_progress (actualiza startedAt)
 *   4. Git: stash → checkout defaultBranch (developer/main) → crear branch de tarea
 *   5. Ciclo IA: PLAN → CODE → REVIEW → TEST → SCOPE (máx 3 iteraciones)
 *   6. Git: verificar branch → add → commit → merge a defaultBranch → borrar branch tarea
 *   7. Si falla → rollback git a defaultBranch
 *   8. Git: restaurar stash (cambios previos)
 *   9. Mueve tarea: in_progress → done | review (actualiza completedAt/iterations)
 *  10. Guarda historial de ejecución
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
const LOG_FILE = '/tmp/kanban-motor.log';
fs.writeFileSync(PID_FILE, String(process.pid));
const cleanPid = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
process.on('exit', cleanPid);
process.on('uncaughtException', (err) => { cleanPid(); console.error(err); process.exit(1); });

// ── Log file — escribe directo a disco para que la UI siempre tenga logs ──
// Si stdout ya está redirigido a archivo (desde server.js), solo necesitamos
// el WriteStream. Si es TTY (desde CLI directo), duplicamos a ambos.
const _isTTY = process.stdout.isTTY;
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function(chunk, encoding, callback) {
  _logStream.write(chunk, encoding);
  if (_isTTY) return _origStdoutWrite(chunk, encoding, callback);
  if (callback) callback();
  return true;
};
process.stderr.write = function(chunk, encoding, callback) {
  _logStream.write(chunk, encoding);
  if (_isTTY) return _origStderrWrite(chunk, encoding, callback);
  if (callback) callback();
  return true;
};

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
  const taskStart = Date.now();

  console.log(chalk.blue.bold(`\n${'═'.repeat(62)}`));
  console.log(chalk.blue.bold(`  TAREA #${task.id}: ${task.title}`));
  console.log(chalk.blue.bold(`${'═'.repeat(62)}`));
  console.log(chalk.gray(`  tipo      : ${task.type}  |  prioridad: ${task.priority}`));
  console.log(chalk.gray(`  branch    : ${task.branch}`));
  console.log(chalk.gray(`  proyecto  : ${chalk.white(taskProjectPath)}`));
  console.log(chalk.gray(`  engine    : ${chalk.white(engine)}`));
  console.log(chalk.gray(`  git       : ${gitCfg.enabled ? `ON (base: ${gitCfg.defaultBranch}, merge: ${gitCfg.autoMerge}, push: ${gitCfg.autoPush})` : 'OFF'}`));
  if (interactive) {
    console.log(chalk.magenta(`  modo      : INTERACTIVO`));
  }
  console.log('');

  // ── PASO 1: todo → in_progress + actualizar startedAt ───
  moveTask(task.id, 'in_progress', kanbanPath);
  updateTaskFields(task.id, { startedAt: new Date().toISOString() }, kanbanPath);
  console.log(chalk.cyan('  [1/6] Estado: todo → in_progress'));

  const gitService = new GitService(taskProjectPath);
  let taskResult = null;
  let gitEnabled = false;
  let stashed = false;

  try {
    // ── PASO 2: git checkout + crear branch ──
    if (gitCfg.enabled) {
      const isRepo = await gitService.isGitRepo();
      if (isRepo) {
        gitEnabled = true;

        // Verificar estado limpio ANTES de empezar
        const preCheck = await gitService.verify(gitCfg.defaultBranch);
        if (preCheck.fixed) {
          console.log(chalk.yellow(`  [2/6] Git: estado corregido antes de empezar`));
        }
        console.log(chalk.gray(`  [git] Pre-check: branch=${preCheck.branch}, clean=${preCheck.clean}`));

        try {
          stashed = await gitService.stashIfNeeded();
          if (stashed) console.log(chalk.cyan(`  [2/6] Git: stash guardado`));

          console.log(chalk.cyan(`  [2/6] Git: checkout ${gitCfg.defaultBranch}`));
          await gitService.checkout(gitCfg.defaultBranch);

          const baseBranch = await gitService.getCurrentBranch();
          console.log(chalk.gray(`  [git] Confirmado en branch base: ${baseBranch}`));

          await gitService.createBranch(task.branch);
          const taskBranch = await gitService.getCurrentBranch();
          console.log(chalk.cyan(`  [2/6] Git: branch '${task.branch}' creado desde '${gitCfg.defaultBranch}'`));
          console.log(chalk.gray(`  [git] Confirmado en branch de tarea: ${taskBranch}`));
        } catch (e) {
          console.log(chalk.yellow(`  [2/6] Git branch falló: ${e.message}`));
          console.log(chalk.yellow(`         Continuando sin branch aislado`));
        }
      } else {
        console.log(chalk.yellow('  [2/6] El projectPath no es un repo git — saltando git'));
      }
    } else {
      console.log(chalk.gray('  [2/6] Git desactivado'));
    }

    // ── PASO 3: ejecutar con CLI ─────────────
    console.log(chalk.cyan(`  [3/6] Ejecutando IA (${engine})...`));
    taskResult = await executeTask(task, { projectPath: taskProjectPath, engine, kanbanPath, interactive });

    // ── PASO 3b: verificar que la IA no cambió de branch ──
    if (gitEnabled) {
      const branchCheck = await gitService.ensureBranch(task.branch);
      if (!branchCheck.ok && branchCheck.restored) {
        console.log(chalk.yellow(`  [3/6] La IA cambió a '${branchCheck.actual}' — restaurado a '${task.branch}'`));
      } else if (!branchCheck.ok && !branchCheck.restored) {
        console.log(chalk.red(`  [3/6] La IA dejó el repo en '${branchCheck.actual}' y no se pudo restaurar`));
      }
    }

    // ── PASO 4: git — merge si éxito, abort si fallo ─────────────
    if (gitEnabled && taskResult?.success) {
      const prefixes = { feature: 'feat', fix: 'fix', bug: 'fix', architecture: 'chore', chore: 'chore' };
      const prefix = prefixes[task.type] || task.type;
      const commitMsg = `${prefix}(${task.id}): ${task.title}`;
      try {
        await gitService.addAll();
        const commitResult = await gitService.commit(commitMsg);
        if (commitResult) {
          console.log(chalk.cyan(`  [4/6] Git: commit "${commitMsg}"`));
        } else {
          console.log(chalk.gray(`  [4/6] Git: nada nuevo que commitear (la IA ya commiteo)`));
        }

        if (gitCfg.autoPush) {
          await gitService.push(task.branch);
          console.log(chalk.cyan(`  [4/6] Git: push origin ${task.branch}`));
        }

        if (gitCfg.autoMerge) {
          await gitService.checkout(gitCfg.defaultBranch);
          const mergeResult = await gitService.merge(task.branch);
          console.log(chalk.cyan(`  [4/6] Git: merge '${task.branch}' → '${gitCfg.defaultBranch}'`));

          // Limpiar branch de tarea después del merge exitoso
          await gitService.deleteBranch(task.branch);
          console.log(chalk.gray(`  [git] Branch '${task.branch}' eliminado`));
        }

        // Confirmar estado limpio
        const postCheck = await gitService.verify(gitCfg.defaultBranch);
        console.log(chalk.gray(`  [git] Post-merge: branch=${postCheck.branch}, clean=${postCheck.clean}`));
      } catch (e) {
        console.log(chalk.red(`  [4/6] Git post-tarea falló: ${e.message}`));
        // Merge falló (conflicto u otro) → abort completo
        console.log(chalk.yellow(`  [4/6] Ejecutando abort completo...`));
        await gitService.abort(gitCfg.defaultBranch, task.branch);
        // Marcar como fallida si el merge falla
        if (taskResult?.success) {
          taskResult = {
            ...taskResult,
            success: false,
            reason: `Merge a ${gitCfg.defaultBranch} falló: ${e.message}`,
          };
        }
      }
    } else if (gitEnabled && taskResult && !taskResult.success) {
      // ── PASO 4b: tarea falló → abort completo (limpieza total) ──
      console.log(chalk.yellow(`  [4/6] Tarea fallida — abort git (limpieza completa)`));
      await gitService.abort(gitCfg.defaultBranch, task.branch);
      console.log(chalk.gray(`  [git] Abort completo — repo limpio en ${gitCfg.defaultBranch}`));
    }

  } catch (err) {
    console.log(chalk.red(`  [!] Error inesperado: ${err.message}`));
    taskResult = { success: false, reason: err.message, phasesRecord: null };
    if (gitEnabled) {
      try {
        console.log(chalk.yellow('  [git] Abort de emergencia...'));
        await gitService.abort(gitCfg.defaultBranch, task.branch);
        console.log(chalk.gray(`  [git] Abort de emergencia completado`));
      } catch (abortErr) {
        console.log(chalk.red(`  [git] Abort de emergencia falló: ${abortErr.message}`));
      }
    }
  }

  // ── PASO 4c: restaurar stash si se guardó al inicio ────
  if (gitEnabled && stashed) {
    try {
      const popped = await gitService.popStashIfNeeded();
      if (popped) {
        console.log(chalk.cyan('  [git] Stash restaurado (cambios previos recuperados)'));
      }
    } catch (e) {
      console.log(chalk.yellow(`  [git] No se pudo restaurar stash: ${e.message}`));
    }
  }

  // ── PASO 4d: verificación final del repo ────
  if (gitEnabled) {
    const finalCheck = await gitService.verify(gitCfg.defaultBranch);
    if (!finalCheck.clean) {
      console.log(chalk.red(`  [git] ⚠ Repo NO quedó limpio: branch=${finalCheck.branch}, dirty=${finalCheck.dirty}`));
      console.log(chalk.yellow(`  [git] Forzando limpieza final...`));
      await gitService.abort(gitCfg.defaultBranch, task.branch);
    }
  }

  const now = new Date().toISOString();
  const elapsed = Math.round((Date.now() - taskStart) / 1000);

  // ── PASO 5: mover a done o review + timestamps ───────────
  if (taskResult?.success && !taskResult.scopeIncomplete) {
    moveTask(task.id, 'done', kanbanPath);
    updateTaskFields(task.id, {
      completedAt: now,
      iterations: taskResult.iterations || 1,
    }, kanbanPath);
    console.log(chalk.green(`\n  [5/6] DONE — ${taskResult.summary} (${elapsed}s)`));
    if (taskResult.iterations > 1) {
      console.log(chalk.gray(`         (completado en ${taskResult.iterations} iteraciones)`));
    }
  } else if (taskResult?.success && taskResult.scopeIncomplete) {
    moveTask(task.id, 'review', kanbanPath);
    updateTaskFields(task.id, {
      completedAt: now,
      iterations: taskResult.iterations || 1,
    }, kanbanPath);
    console.log(chalk.yellow(`\n  [5/6] SCOPE INCOMPLETO → REVIEW (${elapsed}s)`));
    console.log(chalk.yellow(`         ${taskResult.scopeNote}`));
  } else {
    moveTask(task.id, 'review', kanbanPath);
    updateTaskFields(task.id, { completedAt: now }, kanbanPath);
    console.log(chalk.yellow(`\n  [5/6] FALLIDA → REVIEW (${elapsed}s)`));
    console.log(chalk.yellow(`         Razón: ${taskResult?.reason ?? 'Error desconocido'}`));
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
      }, kanbanPath);
      console.log(chalk.gray(`  [6/6] Historial guardado`));
    } catch (err) {
      console.log(chalk.yellow(`  [6/6] No se pudo guardar historial: ${err.message}`));
    }
  }

  console.log(chalk.blue.bold(`${'═'.repeat(62)}`));
  console.log(chalk.blue.bold(`  FIN TAREA #${task.id} — ${taskResult?.success ? 'OK' : 'FALLIDA'} — ${elapsed}s total`));
  console.log(chalk.blue.bold(`${'═'.repeat(62)}\n`));

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

  // Resolver proyecto activo y git config
  const resolvedPath = resolveProjectPath(config);
  const resolvedGit = resolveGitConfig(config);
  const activeProject = readActiveProject();

  console.log(chalk.blue.bold('\n  AI-Kanban — Motor iniciado'));
  console.log(chalk.blue.bold('  ─────────────────────────────────────────'));
  if (activeProject) {
    console.log(chalk.white(`  Proyecto : ${activeProject.name} (${resolvedPath})`));
  } else {
    console.log(chalk.white(`  Proyecto : ${resolvedPath}`));
  }
  console.log(chalk.white(`  Engine   : ${engine || 'dry-run'}`));
  console.log(chalk.white(`  Git      : ${resolvedGit.enabled ? 'ON' : 'OFF'}`));
  if (resolvedGit.enabled) {
    console.log(chalk.white(`    base   : ${resolvedGit.defaultBranch}`));
    console.log(chalk.white(`    merge  : ${resolvedGit.autoMerge ? 'auto' : 'manual'}`));
    console.log(chalk.white(`    push   : ${resolvedGit.autoPush ? 'auto' : 'manual'}`));
  }
  console.log(chalk.white(`  Espera   : ${waitSeconds}s entre ciclos`));
  if (interactive) {
    console.log(chalk.magenta(`  Modo     : INTERACTIVO`));
  }
  console.log(chalk.blue.bold('  ─────────────────────────────────────────'));
  console.log('');

  let cycle = 0;
  let processed = 0;

  while (true) {
    cycle++;
    const cycleTime = new Date().toLocaleTimeString();
    console.log(chalk.gray(`\n  ┌─ ciclo ${cycle} ─ ${cycleTime} ${'─'.repeat(Math.max(0, 40 - cycleTime.length))}`));

    const resolvedProjectPath = resolveProjectPath(config);
    const loopKanbanPath = getKanbanPath(resolvedProjectPath);

    // Verificar estado git al inicio de cada ciclo (limpieza completa)
    if (resolvedGit.enabled) {
      try {
        const gs = new GitService(resolvedProjectPath);
        const isRepo = await gs.isGitRepo();
        if (isRepo) {
          const check = await gs.verify(resolvedGit.defaultBranch);
          if (check.fixed) {
            console.log(chalk.yellow(`  │ git: estado corregido (branch=${check.branch}, clean=${check.clean})`));
          } else {
            console.log(chalk.gray(`  │ git: ${check.branch} (limpio)`));
          }
        }
      } catch (gitErr) {
        console.log(chalk.yellow(`  │ git check falló: ${gitErr.message}`));
      }
    }

    const todoTasks = getTasks('todo', loopKanbanPath);

    if (todoTasks.length === 0) {
      console.log(chalk.gray('  │ Sin tareas en TODO.'));
      console.log(chalk.gray('  └─────────────────────────────────────────'));
      if (cliOverrides.once) break;
      await wait(waitSeconds);
      continue;
    }

    console.log(chalk.gray(`  │ ${todoTasks.length} tarea(s) en TODO`));

    // Buscar la primera tarea sin dependencias bloqueantes
    let taskToProcess = null;
    for (const candidate of todoTasks) {
      const { ok, blocking } = checkDependencies(candidate, loopKanbanPath);
      if (ok) {
        taskToProcess = candidate;
        break;
      } else {
        console.log(chalk.yellow(`  │ skip [${candidate.id}] ${candidate.title} — bloqueada por: ${blocking.join(', ')}`));
      }
    }

    if (!taskToProcess) {
      console.log(chalk.yellow('  │ Todas las tareas en TODO están bloqueadas.'));
      console.log(chalk.gray('  └─────────────────────────────────────────'));
      if (cliOverrides.once) break;
      await wait(waitSeconds);
      continue;
    }

    console.log(chalk.cyan(`  │ Procesando: [${taskToProcess.id}] ${taskToProcess.title}`));
    console.log(chalk.gray('  └─────────────────────────────────────────'));

    if (dryRun) {
      console.log(chalk.yellow('  DRY RUN: simulando tarea\n'));
      moveTask(taskToProcess.id, 'in_progress', loopKanbanPath);
      await new Promise(r => setTimeout(r, 1000));
      moveTask(taskToProcess.id, 'done', loopKanbanPath);
      console.log(chalk.green('  DONE (simulado)'));
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
