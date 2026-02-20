/**
 * ai-executor.js — Motor multi-fase con ciclo autónomo
 *
 * Ciclo por tarea:
 *   FASE 1 — PLAN    : Lee el proyecto, analiza y planifica (sin código)
 *   FASE 2 — CODE    : Implementa según el plan
 *   FASE 3 — REVIEW  : Revisa el código propio, detecta problemas
 *   FASE 4 — TEST    : Ejecuta / crea tests y verifica funcionalidad
 *
 * Si REVIEW rechaza → vuelve a CODE con feedback
 * Si TEST falla     → vuelve a CODE con feedback
 * Máximo MAX_ITERATIONS intentos de CODE antes de renunciar
 */

const { spawn, exec, execSync } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');
const { readContext, getContextPath } = require('./project-context');
const { getHistory } = require('./history');

const MAX_ITERATIONS = 3;

// ─── ARTEFACTOS POR FASE — guarda .md en kanban/.history/{id}/ ──────────────
function getArtifactsDir(kanbanPath, taskId) {
  const padded = String(taskId).padStart(3, '0');
  return path.join(kanbanPath, '.history', padded);
}

function saveArtifact(kanbanPath, taskId, phase, content) {
  if (!kanbanPath) return null;
  const dir = getArtifactsDir(kanbanPath, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${phase}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function readArtifact(kanbanPath, taskId, phase) {
  if (!kanbanPath) return null;
  const file = path.join(getArtifactsDir(kanbanPath, taskId), `${phase}.md`);
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Genera un resumen de intentos anteriores para que la IA no repita errores.
 */
function getPreviousAttemptsContext(kanbanPath, taskId) {
  const history = getHistory(taskId, kanbanPath);
  if (!history || history.length === 0) return '';

  const recent = history.slice(-3); // últimos 3 intentos
  const lines = recent.map((h, i) => {
    const parts = [];
    parts.push(`Intento ${i + 1} (${h.timestamp}): ${h.result}`);
    if (h.summary) parts.push(`  Resultado: ${h.summary}`);
    if (h.phases?.plan?.summary) parts.push(`  Plan: ${h.phases.plan.summary.slice(0, 150)}`);
    if (h.phases?.code?.length) {
      h.phases.code.forEach(c => parts.push(`  Code iter${c.iteration}: ${c.status} — ${c.summary?.slice(0, 100)}`));
    }
    if (h.phases?.review?.length) {
      h.phases.review.forEach(r => parts.push(`  Review iter${r.iteration}: ${r.status} — ${r.summary?.slice(0, 100)}`));
    }
    if (h.phases?.test?.length) {
      h.phases.test.forEach(t => parts.push(`  Test iter${t.iteration}: ${t.status} — ${t.summary?.slice(0, 100)}`));
    }
    return parts.join('\n');
  });
  return lines.join('\n\n');
}

// Proceso actual corriendo (claude/opencode) — para poder matarlo con SIGTERM
let currentProc = null;

// ─── NOTIFICACIONES DEL SISTEMA ─────────────────────────────────────────────
function notify(title, message) {
  const platform = process.platform;
  if (platform === 'linux') {
    exec(`notify-send "${title}" "${message}"`, () => {});
  } else if (platform === 'darwin') {
    exec(`osascript -e 'display notification "${message}" with title "${title}"'`, () => {});
  } else if (platform === 'win32') {
    exec(`powershell -command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null; $template = '<toast><visual><binding template=\\"ToastText02\\"><text id=\\"1\\">${title}</text><text id=\\"2\\">${message}</text></binding></visual></toast>'; $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml($template); $toast = New-Object Windows.UI.Notifications.ToastNotification $xml; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AI-Kanban').Show($toast)"`, () => {});
  }
}

/**
 * Mata el subprocess de IA que esté corriendo en este momento.
 * Llamado desde loop.js al recibir SIGTERM.
 */
function killCurrentPhase() {
  if (currentProc) {
    try { currentProc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { currentProc?.kill('SIGKILL'); } catch {} }, 3000);
  }
}

// ─── TIMEOUTS ────────────────────────────────────────────────
// Tiempo máximo total por fase (IA puede tardar en CODE/TEST)
const PHASE_TIMEOUT_MS      = 15 * 60 * 1000;   // 15 min
// Si no llega ningún byte de output durante este tiempo → colgado
// Claude puede pasar varios minutos leyendo archivos sin generar output
const INACTIVITY_TIMEOUT_MS =  5 * 60 * 1000;   // 5 min sin actividad

// ─────────────────────────────────────────────
// DETECCIÓN DE CLIs
// ─────────────────────────────────────────────

function cliExists(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectAvailableEngine(preferred) {
  if (preferred === 'claude'    && cliExists('claude'))    return 'claude';
  if (preferred === 'opencode'  && cliExists('opencode'))  return 'opencode';
  if (cliExists('claude'))    return 'claude';
  if (cliExists('opencode'))  return 'opencode';
  return null;
}

// ─────────────────────────────────────────────
// CONTEXTO DEL PROYECTO
// ─────────────────────────────────────────────

function getProjectContext(projectPath) {
  try {
    const root = fs.readdirSync(projectPath)
      .filter(f => !f.startsWith('.') && f !== 'node_modules')
      .join(', ');
    let ctx = `Archivos en raíz: ${root}`;
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ctx += `\nProyecto: ${pkg.name || 'desconocido'}`;
      if (pkg.description) ctx += ` — ${pkg.description}`;
      if (pkg.scripts) ctx += `\nScripts: ${Object.keys(pkg.scripts).join(', ')}`;
    }
    return ctx;
  } catch {
    return `Proyecto en: ${projectPath}`;
  }
}

// ─────────────────────────────────────────────
// PROMPTS POR FASE
// ─────────────────────────────────────────────

function promptPlan(task, projectPath, projectContext, previousAttempts) {
  const ctx = getProjectContext(projectPath);
  const ctxSection = projectContext
    ? `CONTEXTO ACUMULADO DEL PROYECTO (decisiones anteriores, stack, convenciones):
${projectContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`
    : '';

  const historySection = previousAttempts
    ? `⚠️ INTENTOS ANTERIORES DE ESTA TAREA (NO repitas los mismos errores):
${previousAttempts}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`
    : '';

  return `Eres un agente de desarrollo. Tu misión en esta fase es ANALIZAR y PLANIFICAR únicamente. NO escribas ni modifiques código todavía.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
${ctx}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ctxSection}${historySection}
TAREA #${task.id} — ${task.title}
Tipo: ${task.type} | Prioridad: ${task.priority}

${task.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES DE ESTA FASE:
1. Lee los archivos relevantes del proyecto para entender la estructura
2. Si hay CONTEXTO ACUMULADO, respeta las decisiones y patrones ya tomados
3. Si hay INTENTOS ANTERIORES, analiza qué falló y evita repetirlo
4. Identifica exactamente qué archivos necesitarás crear o modificar
5. Define el enfoque técnico paso a paso
6. Anticipa posibles problemas o dependencias

En tu última línea escribe EXACTAMENTE:
PLAN: <plan detallado con los archivos a tocar y los cambios específicos>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function promptCodeArchitecture(task, projectPath, plan) {
  return `Eres un arquitecto de software. Tu misión es crear la estructura base del proyecto desde cero.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TAREA #${task.id} — ${task.title}
${task.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN APROBADO:
${plan}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES:
- Trabaja dentro de: ${projectPath}
- Crea la estructura de directorios completa
- Crea package.json con las dependencias del stack elegido
- Crea archivos base (index/server, config, README.md, .gitignore, .env.example)
- Ejecuta npm install para instalar dependencias
- NO implementes lógica de negocio — solo la estructura y boilerplate base
- Deja comentarios TODO donde irá la lógica futura

En tu última línea escribe EXACTAMENTE:
RESULTADO: completado - <resumen de la estructura creada>
RESULTADO: fallido - <motivo>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function promptScope(task, projectPath, plan, codeSummary, kanbanPath, projectContext) {
  const contextFile = getContextPath(kanbanPath);
  const ctxSection = projectContext
    ? `CONTEXTO ACUMULADO DEL PROYECTO:
${projectContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`
    : '';

  return `Eres un agente de validación de alcance. Tu misión es VERIFICAR que la implementación cumple exactamente los requisitos, y actualizar la memoria del proyecto.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ctxSection}
TAREA #${task.id} — ${task.title}
Tipo: ${task.type} | Prioridad: ${task.priority}

REQUISITOS Y CRITERIOS DE ACEPTACIÓN ORIGINALES:
${task.content}

PLAN QUE SE SIGUIÓ:
${plan}

RESUMEN DE LO IMPLEMENTADO:
${codeSummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES — EJECUTA EN ESTE ORDEN:

1. Lee los archivos que se modificaron para esta tarea
2. Contrasta CADA criterio de aceptación contra la implementación real:
   - ¿Está implementado?  ¿Funciona correctamente?  ¿Está completo o a medias?
3. Verifica la integración: ¿se conecta bien con el resto del sistema?
4. Pregúntate: "¿Si el usuario que pidió esto probara ahora mismo la funcionalidad, quedaría satisfecho?"

5. Si la implementación está COMPLETA:
   Actualiza el archivo ${contextFile}
   - Si no existe, créalo con esta estructura:
     # Contexto del Proyecto
     ## Stack tecnológico
     ## Decisiones de arquitectura
     ## Features implementadas
     ## Convenciones del proyecto
   - Añade lo aprendido en esta tarea (no elimines información anterior)
   - Incluye: qué stack/librerías se usaron, patrones adoptados, qué feature se completó

En tu ÚLTIMA LÍNEA escribe EXACTAMENTE una de estas dos opciones:
SCOPE: ok - <resumen de qué criterios se verificaron y cumplieron>
SCOPE: incompleto - <lista concreta y específica de qué falta o está mal>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function promptCode(task, projectPath, plan, feedback = null) {
  const ctx = getProjectContext(projectPath);
  const feedbackSection = feedback
    ? `\nFEEDBACK DE ITERACIÓN ANTERIOR:\n${feedback}\nCorrige exactamente los problemas indicados.\n`
    : '';

  return `Eres un agente de desarrollo. Tu misión es IMPLEMENTAR la tarea según el plan aprobado.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
${ctx}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TAREA #${task.id} — ${task.title}
Tipo: ${task.type} | Prioridad: ${task.priority}

${task.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN APROBADO:
${plan}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${feedbackSection}
INSTRUCCIONES DE ESTA FASE:
- Trabaja dentro de: ${projectPath}
- Lee los archivos antes de modificarlos
- Implementa exactamente lo que describe el plan
- No hagas cambios fuera del alcance de la tarea
- Guarda todos los archivos modificados

En tu última línea escribe EXACTAMENTE una de estas dos opciones:
RESULTADO: completado - <resumen breve de lo que hiciste>
RESULTADO: fallido - <motivo>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function promptReview(task, projectPath, plan) {
  return `Eres un revisor de código senior. Tu misión es REVISAR el código implementado para la tarea y detectar problemas.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TAREA #${task.id} — ${task.title}

PLAN QUE SE DEBÍA IMPLEMENTAR:
${plan}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES DE ESTA FASE:
1. Lee los archivos que se modificaron para esta tarea
2. Verifica que el código implementa correctamente lo pedido
3. Busca bugs, errores de lógica, problemas de seguridad, código roto
4. Verifica que no se rompió funcionalidad existente
5. Revisa que el código sigue las convenciones del proyecto

En tu última línea escribe EXACTAMENTE una de estas dos opciones:
REVIEW: aprobado - <breve comentario positivo>
REVIEW: rechazado - <lista concreta de problemas a corregir>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function promptTest(task, projectPath) {
  return `Eres un agente de QA. Tu misión es VERIFICAR que la implementación funciona correctamente mediante tests.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TAREA #${task.id} — ${task.title}
${task.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES DE ESTA FASE:
1. Busca si hay tests existentes en el proyecto y ejecútalos
2. Si no hay tests para esta funcionalidad, crea tests básicos y ejecútalos
3. Verifica manualmente que la funcionalidad implementada cumple los criterios de aceptación
4. Si hay scripts en package.json (test, lint), ejecútalos

En tu última línea escribe EXACTAMENTE una de estas dos opciones:
TESTS: ok - <resumen de qué se verificó y resultados>
TESTS: fallido - <qué test falló y por qué>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ─────────────────────────────────────────────
// RUNNER DE FASE
// ─────────────────────────────────────────────

function buildCommand(engine, prompt, projectPath, interactive = false) {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  if (engine === 'claude') {
    if (interactive) {
      return { cmd: 'claude', args: ['--dangerously-skip-permissions'], cwd: projectPath, env, interactive: true };
    }
    return { cmd: 'claude', args: ['--dangerously-skip-permissions', '-p', prompt], cwd: projectPath, env, interactive: false };
  }
  if (engine === 'opencode') {
    if (interactive) {
      return { cmd: 'opencode', args: [], cwd: projectPath, env, interactive: true };
    }
    return { cmd: 'opencode', args: ['run', prompt, '--dir', projectPath], cwd: projectPath, env, interactive: false };
  }
  throw new Error(`Engine desconocido: ${engine}`);
}

/**
 * Ejecuta una sesión interactiva con la IA en una ventana nueva de terminal
 * El usuario puede escribir y ver output en tiempo real
 * Retorna una promesa que se resuelve cuando el usuario confirma
 */
function runInteractiveSession(engine, projectPath, initialPrompt = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
    console.log(chalk.magenta(`  🖥️  ABRIENDO VENTANA INTERACTIVA — ${engine.toUpperCase()}`));
    console.log(chalk.magenta(`  📁 ${projectPath}`));
    console.log(chalk.gray(`  ────────────────────────────────────────────────────`));
    console.log(chalk.gray(`  Se abrirá una ventana nueva de terminal.`));
    console.log(chalk.gray(`  Trabaja ahí, cierra cuando termines, y presiona Enter aquí.`));
    console.log(chalk.magenta(`${'═'.repeat(60)}\n`));

    const env = { ...process.env };
    delete env.CLAUDECODE;

    let cmd, args;
    if (engine === 'claude') {
      cmd = 'claude';
      args = ['--dangerously-skip-permissions'];
      if (initialPrompt) args.push('-p', initialPrompt);
    } else {
      cmd = 'opencode';
      args = ['run'];
      if (initialPrompt) args.push(initialPrompt, '--dir', projectPath);
    }

    // Crear script temporal que mantiene la ventana abierta
    const scriptContent = `#!/bin/bash
cd "${projectPath}"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  AI-Kanban - Sesión ${engine.toUpperCase()}"
echo "  Proyecto: ${projectPath}"
echo "════════════════════════════════════════════════════════════════"
echo ""
${cmd} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ✓ Sesión terminada. Cierra esta ventana."
echo "════════════════════════════════════════════════════════════════"
read -p ""
`;
    
    const scriptPath = `/tmp/ai-kanban-session-${Date.now()}.sh`;
    require('fs').writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    // Abrir gnome-terminal
    const terminal = spawn('gnome-terminal', [
      '--title', `AI-Kanban: ${engine}`,
      '--', 'bash', '-c', `bash '${scriptPath}'`
    ], {
      env: { ...env, TERM: 'xterm-256color' },
      detached: true,
      stdio: 'ignore'
    });

    terminal.unref();
    terminal.on('error', (err) => {
      console.log(chalk.red(`  ✗ Error abriendo terminal: ${err.message}`));
      // Fallback: ejecutar en misma terminal
      console.log(chalk.yellow('  Ejecutando en esta terminal...'));
      runInteractiveBlocking(engine, projectPath, initialPrompt).then(resolve);
    });

    // Esperar confirmación del usuario
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(chalk.cyan('\n  Presiona Enter cuando hayas terminado en la ventana de IA... '), () => {
      rl.close();
      
      // Limpiar script temporal
      try { require('fs').unlinkSync(scriptPath); } catch {}
      
      const duration = Date.now() - startTime;
      console.log(chalk.green(`\n  ✓ Sesión completada (${Math.round(duration / 1000)}s)\n`));
      
      resolve({ 
        exitCode: 0, 
        duration, 
        success: true,
        output: ''
      });
    });
  });
}

/**
 * Ejecuta una sesión interactiva bloqueante (en la misma terminal)
 * para cuando el usuario quiere control total
 */
function runInteractiveBlocking(engine, projectPath, initialPrompt = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
    console.log(chalk.magenta(`  🖥️  SESIÓN INTERACTIVA — ${engine.toUpperCase()}`));
    console.log(chalk.magenta(`  📁 ${projectPath}`));
    console.log(chalk.gray(`  ────────────────────────────────────────────────────`));
    console.log(chalk.gray(`  Escribe tus comandos. Ctrl+C o /exit para terminar.`));
    console.log(chalk.magenta(`${'═'.repeat(60)}\n`));

    const env = { ...process.env };
    delete env.CLAUDECODE;

    let cmd, args;
    if (engine === 'claude') {
      cmd = 'claude';
      args = ['--dangerously-skip-permissions'];
      if (initialPrompt) args.push('-p', initialPrompt);
    } else {
      cmd = 'opencode';
      args = [];
      if (initialPrompt) args.push('run', initialPrompt, '--dir', projectPath);
    }

    const proc = spawn(cmd, args, { 
      cwd: projectPath, 
      env, 
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    currentProc = proc;

    proc.on('close', (code) => {
      currentProc = null;
      const duration = Date.now() - startTime;
      
      console.log(chalk.magenta(`\n${'═'.repeat(60)}`));
      console.log(chalk.magenta(`  SESIÓN FINALIZADA (${Math.round(duration / 1000)}s)`));
      console.log(chalk.magenta(`${'═'.repeat(60)}\n`));
      
      resolve({ 
        exitCode: code, 
        duration, 
        success: code === 0,
        output: ''
      });
    });

    proc.on('error', (err) => {
      currentProc = null;
      resolve({
        exitCode: 1,
        duration: Date.now() - startTime,
        success: false,
        output: err.message
      });
    });
  });
}

/**
 * Ejecuta una fase y retorna { output, marker, value, timedOut? }
 *
 * Timeouts:
 *  - PHASE_TIMEOUT_MS     : tiempo máximo total por fase
 *  - INACTIVITY_TIMEOUT_MS: tiempo máximo sin recibir ningún byte de output
 *
 * Si cualquiera se dispara → mata el proceso y retorna timedOut: true
 */
function runPhase(engine, prompt, projectPath, label) {
  return new Promise((resolve) => {
    const mins = (ms) => `${ms / 60000}min`;
    process.stdout.write(chalk.magenta(`\n  ┌─ FASE: ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}\n`));
    process.stdout.write(chalk.gray(`  │  ⏱  max ${mins(PHASE_TIMEOUT_MS)} · inactividad ${mins(INACTIVITY_TIMEOUT_MS)}\n`));

    const startTime = Date.now();
    const { cmd, args, cwd, env } = buildCommand(engine, prompt, projectPath);
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    currentProc = proc;

    let fullOutput = '';
    let resolved   = false;

    // ── Matar proceso limpiamente ───────────────────────────
    const killProc = (reason) => {
      if (resolved) return;
      process.stdout.write(chalk.red(`\n  ✖ TIMEOUT — ${reason}. Matando proceso...\n`));
      proc.kill('SIGTERM');
      // Si no muere en 5 s → SIGKILL
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    };

    // Timer total de la fase
    const phaseTimer = setTimeout(
      () => killProc(`la fase superó ${mins(PHASE_TIMEOUT_MS)}`),
      PHASE_TIMEOUT_MS,
    );

    // Timer de inactividad (se reinicia con cada chunk)
    let inactivityTimer = setTimeout(
      () => killProc(`sin actividad durante ${mins(INACTIVITY_TIMEOUT_MS)}`),
      INACTIVITY_TIMEOUT_MS,
    );

    const clearTimers = () => {
      clearTimeout(phaseTimer);
      clearTimeout(inactivityTimer);
    };

    // ── Captura de output ───────────────────────────────────
    const capture = new PassThrough();
    capture.on('data', (chunk) => {
      fullOutput += chunk.toString();
      // Reiniciar inactividad con cada byte recibido
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => killProc(`sin actividad durante ${mins(INACTIVITY_TIMEOUT_MS)}`),
        INACTIVITY_TIMEOUT_MS,
      );
    });
    capture.pipe(process.stdout, { end: false });
    proc.stdout.pipe(capture);
    proc.stderr.pipe(process.stderr, { end: false });

    // ── Cierre del proceso ──────────────────────────────────
    // Resolver la promesa cuando tengamos todo el output.
    // Usamos proc.on('close') + un pequeño delay para asegurar
    // que capture haya procesado todos los chunks pendientes.
    proc.on('close', (code) => {
      currentProc = null;
      clearTimers();

      // Dar tiempo a que capture procese los últimos chunks del pipe
      setTimeout(() => {
        if (resolved) return;
        resolved = true;

        const duration = Date.now() - startTime;
        const timedOut = code === null || (code !== 0 && fullOutput.trim() === '');

        process.stdout.write(chalk.magenta(`  └─ FIN: ${label} (${Math.round(duration / 1000)}s)\n`));

        // Si fue un timeout detectado por SIGTERM (code = null o señal)
        if (code === null) {
          resolve({
            output: fullOutput,
            marker: null,
            value: `Timeout — la fase no respondió a tiempo`,
            exitCode: -1,
            duration,
            timedOut: true,
          });
          return;
        }

        // Buscar marcador en las últimas 30 líneas
        const allLines = fullOutput.trim().split('\n');
        const searchLines = allLines.slice(-30);
        for (let i = searchLines.length - 1; i >= 0; i--) {
          const trimmed = searchLines[i].trim();
          for (const marker of ['PLAN', 'RESULTADO', 'REVIEW', 'TESTS', 'SCOPE']) {
            if (trimmed.startsWith(`${marker}:`)) {
              let value = trimmed.slice(marker.length + 1).trim();
              // Si el valor está vacío, el contenido puede estar en las líneas siguientes
              if (!value && i < searchLines.length - 1) {
                value = searchLines.slice(i + 1).map(l => l.trim()).filter(Boolean).join('\n');
              }
              // Si aún vacío, tomar las últimas 2000 chars del output completo
              if (!value) value = fullOutput.trim().slice(-2000);
              resolve({ output: fullOutput, marker, value, exitCode: code, duration, timedOut: false });
              return;
            }
          }
        }

        resolve({ output: fullOutput, marker: null, value: null, exitCode: code, duration, timedOut: false });
      }, 500);
    });

    proc.on('error', (err) => {
      clearTimers();
      if (resolved) return;
      resolved = true;
      resolve({
        output: '',
        marker: null,
        value: `error al iniciar proceso: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        timedOut: false,
      });
    });
  });
}

// ─────────────────────────────────────────────
// EJECUTOR PRINCIPAL — CICLO MULTI-FASE
// ─────────────────────────────────────────────

async function executeTask(task, options = {}) {
  const {
    projectPath = process.cwd(),
    engine: preferredEngine = 'claude',
    dryRun = false,
    kanbanPath = null,
    interactive = false,
  } = options;

  if (dryRun) {
    console.log(chalk.yellow('  🔍 DRY RUN — ciclo simulado'));
    return { success: true, summary: '[DRY RUN] Simulado', iterations: 0, phasesRecord: null };
  }

  const engine = detectAvailableEngine(preferredEngine);
  if (!engine) {
    return { success: false, reason: 'No se encontró `claude` ni `opencode` en el sistema.', phasesRecord: null };
  }

  // ── MODO INTERACTIVO ─────────────────────────────────────────
  if (interactive) {
    const initialPrompt = `TAREA #${task.id}: ${task.title}

${task.content}

Por favor, analiza esta tarea y realiza los cambios necesarios en el proyecto.`;
    
    const result = await runInteractiveBlocking(engine, projectPath, initialPrompt);
    
    notify(
      `AI-Kanban: Tarea #${task.id} ${result.success ? 'completada' : 'fallida'}`,
      result.success ? task.title : 'Revisa el output para más detalles'
    );
    
    return {
      success: result.success,
      summary: result.success ? 'Sesión interactiva completada' : 'Sesión terminada con errores',
      iterations: 1,
      phasesRecord: { 
        interactive: true, 
        duration: result.duration,
        result: result.success ? 'success' : 'failed' 
      },
    };
  }

  // ── MODO AUTOMÁTICO ─────────────────────────────────────────
  // Leer contexto acumulado del proyecto (si existe)
  const projectContext = kanbanPath ? readContext(kanbanPath) : null;
  if (projectContext) {
    console.log(chalk.gray(`  📖 Contexto del proyecto cargado (${projectContext.length} chars)`));
  }

  // Leer historial de intentos anteriores de esta tarea
  const previousAttempts = getPreviousAttemptsContext(kanbanPath, task.id);
  if (previousAttempts) {
    console.log(chalk.yellow(`  📋 Historial: ${getHistory(task.id, kanbanPath).length} intento(s) anteriores cargados`));
  }

  const isArchitecture = task.type === 'architecture';
  const cycleLabel = isArchitecture
    ? 'PLAN → CODE(scaffold) → SCOPE'
    : 'PLAN → CODE → REVIEW → TEST → SCOPE';

  console.log(chalk.blue(`\n  🤖 Engine : ${chalk.bold(engine)}`));
  console.log(chalk.blue(`  📁 Proyecto: ${chalk.bold(projectPath)}`));
  console.log(chalk.blue(`  🔄 Ciclo   : ${cycleLabel}`));
  if (kanbanPath) {
    console.log(chalk.gray(`  📂 Artefactos: ${getArtifactsDir(kanbanPath, task.id)}/`));
  }
  console.log('');

  const executionStart = Date.now();

  // Registro de fases para historial
  const phasesRecord = {
    plan: { status: 'pending', duration: 0, summary: '' },
    code: [],
    review: [],
    test: [],
  };

  // ── FASE 1: PLAN ──────────────────────────────────────────
  const planResult = await runPhase(
    engine,
    promptPlan(task, projectPath, projectContext, previousAttempts),
    projectPath,
    'PLAN — Análisis y planificación',
  );

  let plan;
  if (planResult.timedOut) {
    phasesRecord.plan = { status: 'timeout', duration: planResult.duration, summary: 'PLAN no respondió a tiempo' };
    console.log(chalk.red(`  ✖ PLAN agotó el tiempo — abortando tarea`));
    return {
      success: false,
      reason: `PLAN no respondió en ${PHASE_TIMEOUT_MS / 60000} minutos`,
      iterations: 0,
      phasesRecord: { ...phasesRecord, result: 'timeout', totalDuration: Date.now() - executionStart },
    };
  } else if (planResult.marker === 'PLAN' && planResult.value) {
    plan = planResult.value;
    phasesRecord.plan = { status: 'ok', duration: planResult.duration, summary: plan.slice(0, 200) };
    console.log(chalk.cyan(`\n  ✔ Plan generado`));
  } else {
    // Sin marcador formal → usar todo el output como plan
    plan = planResult.output.trim().slice(-2000) || 'Sin plan explícito — proceder con la descripción de la tarea.';
    phasesRecord.plan = { status: 'no-marker', duration: planResult.duration, summary: plan.slice(0, 200) };
    console.log(chalk.yellow(`  ⚠ Plan sin marcador formal, usando output completo`));
  }

  // Guardar artefacto del plan
  const planFile = saveArtifact(kanbanPath, task.id, 'plan', `# Plan — Tarea #${task.id}: ${task.title}\n\n${plan}\n\n---\n_Generado: ${new Date().toISOString()} | Engine: ${engine} | Duración: ${Math.round(planResult.duration / 1000)}s_\n`);
  if (planFile) console.log(chalk.gray(`  💾 Plan guardado: ${planFile}`));

  // ── CICLO: CODE → REVIEW → TEST  (architecture: solo CODE) ──
  let feedback = null;
  let iteration = 0;
  let finalCodeSummary = '';

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(chalk.blue(`\n  ━━━ Iteración ${iteration}/${MAX_ITERATIONS} ━━━`));

    // ── FASE 2: CODE ────────────────────────────────────────
    const codePrompt = isArchitecture
      ? promptCodeArchitecture(task, projectPath, plan)
      : promptCode(task, projectPath, plan, feedback);

    const codeResult = await runPhase(
      engine,
      codePrompt,
      projectPath,
      `CODE — ${isArchitecture ? 'Scaffolding' : 'Implementación'} (iter ${iteration})`,
    );

    const codeOk = codeResult.marker === 'RESULTADO'
      ? codeResult.value?.toLowerCase().startsWith('completado')
      : codeResult.exitCode === 0;

    if (codeResult.timedOut || !codeOk) {
      const reason = codeResult.timedOut
        ? `CODE no respondió en ${PHASE_TIMEOUT_MS / 60000} minutos (proceso colgado)`
        : (codeResult.value || `Salió con código ${codeResult.exitCode}`);
      const status = codeResult.timedOut ? 'timeout' : 'failed';
      phasesRecord.code.push({ iteration, status, duration: codeResult.duration, summary: reason });
      console.log(chalk.red(`  ✖ CODE ${status}: ${reason}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `CODE falló tras ${MAX_ITERATIONS} intentos: ${reason}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = codeResult.timedOut
        ? `La fase CODE se colgó y fue terminada por timeout. Intenta una solución más simple y directa.`
        : `La implementación anterior falló: ${reason}. Intenta un enfoque diferente.`;
      continue;
    }

    const codeSummary = codeResult.value?.replace(/^completado\s*-?\s*/i, '') || 'Implementado';
    finalCodeSummary = codeSummary;
    phasesRecord.code.push({ iteration, status: 'ok', duration: codeResult.duration, summary: codeSummary });
    console.log(chalk.cyan(`  ✔ CODE completado: ${codeSummary}`));

    // Guardar artefacto del código
    saveArtifact(kanbanPath, task.id, `code-iter${iteration}`, `# Code — Tarea #${task.id} (iter ${iteration})\n\n**Resultado:** ${codeSummary}\n\n---\n_${new Date().toISOString()} | ${Math.round(codeResult.duration / 1000)}s_\n`);

    // ── Architecture: salta REVIEW y TEST, va directo a SCOPE ─
    if (isArchitecture) break;

    // ── FASE 3: REVIEW ──────────────────────────────────────
    const reviewResult = await runPhase(
      engine,
      promptReview(task, projectPath, plan),
      projectPath,
      'REVIEW — Revisión de código',
    );

    const reviewApproved = reviewResult.marker === 'REVIEW'
      ? reviewResult.value?.toLowerCase().startsWith('aprobado')
      : reviewResult.exitCode === 0; // Sin marcador → asumir ok

    if (reviewResult.timedOut || !reviewApproved) {
      const problems = reviewResult.timedOut
        ? `REVIEW no respondió en ${PHASE_TIMEOUT_MS / 60000} minutos (proceso colgado)`
        : (reviewResult.value?.replace(/^rechazado\s*-?\s*/i, '') || 'Problemas no especificados');
      const status = reviewResult.timedOut ? 'timeout' : 'rejected';
      phasesRecord.review.push({ iteration, status, duration: reviewResult.duration, summary: problems });
      console.log(chalk.yellow(`  ⚠ REVIEW ${status}: ${problems}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `Review falló tras ${MAX_ITERATIONS} intentos: ${problems}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'review-failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = reviewResult.timedOut
        ? `La fase REVIEW se colgó. Revisa el código manualmente y simplifica si es posible.`
        : `El revisor rechazó el código con estos problemas:\n${problems}\nCorrige exactamente estos puntos.`;
      continue;
    }

    const reviewComment = reviewResult.value?.replace(/^aprobado\s*-?\s*/i, '') || 'OK';
    phasesRecord.review.push({ iteration, status: 'approved', duration: reviewResult.duration, summary: reviewComment });
    console.log(chalk.cyan(`  ✔ REVIEW aprobado: ${reviewComment}`));

    // Guardar artefacto del review
    saveArtifact(kanbanPath, task.id, `review-iter${iteration}`, `# Review — Tarea #${task.id} (iter ${iteration})\n\n**Veredicto:** Aprobado\n**Comentario:** ${reviewComment}\n\n---\n_${new Date().toISOString()} | ${Math.round(reviewResult.duration / 1000)}s_\n`);

    // ── FASE 4: TEST ────────────────────────────────────────
    const testResult = await runPhase(
      engine,
      promptTest(task, projectPath),
      projectPath,
      'TEST — Verificación funcional',
    );

    const testsOk = testResult.marker === 'TESTS'
      ? testResult.value?.toLowerCase().startsWith('ok')
      : testResult.exitCode === 0;

    if (testResult.timedOut || !testsOk) {
      const testFailure = testResult.timedOut
        ? `TEST no respondió en ${PHASE_TIMEOUT_MS / 60000} minutos (proceso colgado o tests infinitos)`
        : (testResult.value?.replace(/^fallido\s*-?\s*/i, '') || 'Tests fallaron');
      const status = testResult.timedOut ? 'timeout' : 'failed';
      phasesRecord.test.push({ iteration, status, duration: testResult.duration, summary: testFailure });
      console.log(chalk.yellow(`  ⚠ TEST ${status}: ${testFailure}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `Tests fallaron tras ${MAX_ITERATIONS} intentos: ${testFailure}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'test-failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = testResult.timedOut
        ? `Los tests se colgaron (timeout). Verifica que no haya bucles infinitos ni procesos que no terminan.`
        : `Los tests fallaron con este resultado:\n${testFailure}\nCorrige el código para que pasen los tests.`;
      continue;
    }

    const testSummary = testResult.value?.replace(/^ok\s*-?\s*/i, '') || 'Tests pasaron';
    phasesRecord.test.push({ iteration, status: 'ok', duration: testResult.duration, summary: testSummary });
    console.log(chalk.green(`  ✔ TESTS OK: ${testSummary}`));

    // Guardar artefacto de tests
    saveArtifact(kanbanPath, task.id, `test-iter${iteration}`, `# Tests — Tarea #${task.id} (iter ${iteration})\n\n**Resultado:** OK\n**Detalle:** ${testSummary}\n\n---\n_${new Date().toISOString()} | ${Math.round(testResult.duration / 1000)}s_\n`);

    finalCodeSummary = codeSummary;
    break; // salir del while para ir a SCOPE
  }

  // ── FASE 5: SCOPE — Validación de alcance ─────────────────
  // Solo llega aquí si CODE (y REVIEW+TEST para tareas normales) pasaron
  if (finalCodeSummary && kanbanPath) {
    console.log(chalk.blue(`\n  ━━━ Validación de alcance ━━━`));
    const scopeResult = await runPhase(
      engine,
      promptScope(task, projectPath, plan, finalCodeSummary, kanbanPath, projectContext),
      projectPath,
      'SCOPE — Validación de requisitos y contexto',
    );

    const scopeOk = scopeResult.timedOut
      ? false
      : (scopeResult.marker === 'SCOPE'
          ? scopeResult.value?.toLowerCase().startsWith('ok')
          : scopeResult.exitCode === 0);

    if (scopeResult.timedOut) {
      phasesRecord.scope = { status: 'timeout', duration: scopeResult.duration, summary: 'SCOPE no respondió a tiempo' };
      console.log(chalk.yellow(`  ⚠ SCOPE timeout — marcando para revisión`));
      return {
        success: true,
        scopeIncomplete: true,
        scopeNote: 'La validación de alcance no respondió a tiempo. Revisa manualmente.',
        summary: finalCodeSummary,
        iterations: iteration,
        plan,
        phasesRecord: { ...phasesRecord, result: 'scope-timeout', totalDuration: Date.now() - executionStart },
      };
    }

    if (!scopeOk) {
      const gaps = scopeResult.value?.replace(/^incompleto\s*-?\s*/i, '') || 'Requisitos incompletos';
      phasesRecord.scope = { status: 'incomplete', duration: scopeResult.duration, summary: gaps };
      console.log(chalk.yellow(`\n  ⚠ SCOPE detectó gaps: ${gaps}`));
      return {
        success: true,         // el código se commitea (no se pierde el trabajo)
        scopeIncomplete: true, // pero va a Review, no a Done
        scopeNote: gaps,
        summary: finalCodeSummary,
        iterations: iteration,
        plan,
        phasesRecord: { ...phasesRecord, result: 'scope-incomplete', totalDuration: Date.now() - executionStart },
      };
    }

    const scopeSummary = scopeResult.value?.replace(/^ok\s*-?\s*/i, '') || 'Requisitos verificados';
    phasesRecord.scope = { status: 'ok', duration: scopeResult.duration, summary: scopeSummary };
    console.log(chalk.green(`  ✔ SCOPE ok: ${scopeSummary}`));

    // Guardar artefacto de scope
    saveArtifact(kanbanPath, task.id, 'scope', `# Scope — Tarea #${task.id}: ${task.title}\n\n**Veredicto:** OK\n**Detalle:** ${scopeSummary}\n\n---\n_${new Date().toISOString()} | ${Math.round(scopeResult.duration / 1000)}s_\n`);
  } else if (finalCodeSummary) {
    // Sin kanbanPath no podemos leer/escribir contexto — continúa sin SCOPE
    console.log(chalk.gray('  ⚠ Sin kanbanPath — fase SCOPE omitida'));
    phasesRecord.scope = { status: 'skipped', duration: 0, summary: 'Omitida (sin kanbanPath)' };
  } else {
    // No llegó a código exitoso
    return {
      success: false,
      reason: `Se agotaron las ${MAX_ITERATIONS} iteraciones sin completar el ciclo`,
      iterations: MAX_ITERATIONS,
      phasesRecord: { ...phasesRecord, result: 'exhausted', totalDuration: Date.now() - executionStart },
    };
  }

  const result = {
    success: true,
    summary: finalCodeSummary,
    iterations: iteration,
    plan,
    phasesRecord: { ...phasesRecord, result: 'success', totalDuration: Date.now() - executionStart },
  };
  
  notify(
    `AI-Kanban: Tarea completada ✓`,
    `${task.title} (${iteration} iteración${iteration > 1 ? 'es' : ''})`
  );
  
  return result;
}

// ─────────────────────────────────────────────
// CLASIFICADOR DE TEXTO LIBRE
// ─────────────────────────────────────────────

function classifyTask(text, engine = 'claude') {
  return new Promise((resolve, reject) => {
    const available = detectAvailableEngine(engine);
    if (!available) {
      reject(new Error('No hay CLI disponible para clasificar'));
      return;
    }

    const prompt = `Clasifica el siguiente texto como tarea de desarrollo de software.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin bloques markdown.

Texto: "${text}"

Formato de respuesta:
{"type":"feature","title":"título conciso","priority":"media","labels":["tag1"],"criteria":["criterio 1","criterio 2"]}

Valores posibles: type = feature|fix|bug   priority = alta|media|baja`;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const { cmd, args } = available === 'claude'
      ? { cmd: 'claude', args: ['--dangerously-skip-permissions', '-p', prompt] }
      : { cmd: 'opencode', args: ['run', prompt] };

    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    // Timeout de 2 min para clasificación
    const classifyTimeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Clasificación agotó el tiempo (2 min)'));
    }, 2 * 60 * 1000);

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.on('close', () => {
      clearTimeout(classifyTimeout);
      try {
        const match = output.match(/\{[\s\S]+?\}/);
        if (!match) throw new Error('Sin JSON en respuesta');
        resolve(JSON.parse(match[0]));
      } catch (e) {
        reject(new Error(`No se pudo parsear: ${e.message}\nOutput: ${output.slice(0, 200)}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(classifyTimeout); reject(err); });
  });
}

module.exports = {
  executeTask,
  classifyTask,
  detectAvailableEngine,
  cliExists,
  killCurrentPhase,
  runInteractiveSession,
  runInteractiveBlocking,
  notify,
};
