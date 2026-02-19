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

const { spawn, execSync } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const MAX_ITERATIONS = 3;

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

function promptPlan(task, projectPath) {
  const ctx = getProjectContext(projectPath);
  return `Eres un agente de desarrollo. Tu misión en esta fase es ANALIZAR y PLANIFICAR únicamente. NO escribas ni modifiques código todavía.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROYECTO: ${projectPath}
${ctx}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TAREA #${task.id} — ${task.title}
Tipo: ${task.type} | Prioridad: ${task.priority}

${task.content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES DE ESTA FASE:
1. Lee los archivos relevantes del proyecto para entender la estructura
2. Identifica exactamente qué archivos necesitarás crear o modificar
3. Define el enfoque técnico paso a paso
4. Anticipa posibles problemas o dependencias

En tu última línea escribe EXACTAMENTE:
PLAN: <plan detallado con los archivos a tocar y los cambios específicos>
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

function buildCommand(engine, prompt, projectPath) {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  if (engine === 'claude') {
    return { cmd: 'claude', args: ['--dangerously-skip-permissions', '-p', prompt], cwd: projectPath, env };
  }
  if (engine === 'opencode') {
    return { cmd: 'opencode', args: ['run', prompt, '--dir', projectPath], cwd: projectPath, env };
  }
  throw new Error(`Engine desconocido: ${engine}`);
}

/**
 * Ejecuta una fase y retorna { output, marker, value }
 * marker  = 'PLAN' | 'RESULTADO' | 'REVIEW' | 'TESTS'
 * value   = texto después del marcador
 *
 * Streaming: usa PassThrough para que el output fluya en tiempo real
 * hacia process.stdout Y se capture simultáneamente para parsear.
 */
function runPhase(engine, prompt, projectPath, label) {
  return new Promise((resolve) => {
    process.stdout.write(chalk.magenta(`\n  ┌─ FASE: ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}\n`));

    const startTime = Date.now();
    const { cmd, args, cwd, env } = buildCommand(engine, prompt, projectPath);
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let fullOutput = '';

    // PassThrough: los datos fluyen proc.stdout → capture (acumula) → process.stdout (muestra)
    const capture = new PassThrough();
    capture.on('data', (chunk) => { fullOutput += chunk.toString(); });
    capture.pipe(process.stdout, { end: false });
    proc.stdout.pipe(capture);

    // stderr directo al terminal
    proc.stderr.pipe(process.stderr, { end: false });

    proc.on('close', (code) => {
      // Esperar a que el PassThrough drene antes de parsear
      capture.once('finish', () => {
        const duration = Date.now() - startTime;
        process.stdout.write(chalk.magenta(`  └─ FIN: ${label}\n`));

        // Buscar marcador en las últimas 20 líneas
        const lines = fullOutput.trim().split('\n').reverse().slice(0, 20);
        for (const line of lines) {
          const trimmed = line.trim();
          for (const marker of ['PLAN', 'RESULTADO', 'REVIEW', 'TESTS']) {
            if (trimmed.startsWith(`${marker}:`)) {
              const value = trimmed.slice(marker.length + 1).trim();
              resolve({ output: fullOutput, marker, value, exitCode: code, duration });
              return;
            }
          }
        }

        resolve({ output: fullOutput, marker: null, value: null, exitCode: code, duration });
      });
      capture.end();
    });

    proc.on('error', (err) => {
      resolve({ output: '', marker: null, value: `error: ${err.message}`, exitCode: 1, duration: Date.now() - startTime });
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
  } = options;

  if (dryRun) {
    console.log(chalk.yellow('  🔍 DRY RUN — ciclo simulado'));
    return { success: true, summary: '[DRY RUN] Simulado', iterations: 0, phasesRecord: null };
  }

  const engine = detectAvailableEngine(preferredEngine);
  if (!engine) {
    return { success: false, reason: 'No se encontró `claude` ni `opencode` en el sistema.', phasesRecord: null };
  }

  console.log(chalk.blue(`\n  🤖 Engine : ${chalk.bold(engine)}`));
  console.log(chalk.blue(`  📁 Proyecto: ${chalk.bold(projectPath)}`));
  console.log(chalk.blue(`  🔄 Ciclo   : PLAN → CODE → REVIEW → TEST\n`));

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
    promptPlan(task, projectPath),
    projectPath,
    'PLAN — Análisis y planificación',
  );

  let plan;
  if (planResult.marker === 'PLAN' && planResult.value) {
    plan = planResult.value;
    phasesRecord.plan = { status: 'ok', duration: planResult.duration, summary: plan.slice(0, 200) };
    console.log(chalk.cyan(`\n  ✔ Plan generado`));
  } else {
    // Sin marcador formal → usar todo el output como plan
    plan = planResult.output.trim().slice(-2000) || 'Sin plan explícito — proceder con la descripción de la tarea.';
    phasesRecord.plan = { status: 'no-marker', duration: planResult.duration, summary: plan.slice(0, 200) };
    console.log(chalk.yellow(`  ⚠ Plan sin marcador formal, usando output completo`));
  }

  // ── CICLO: CODE → REVIEW → TEST ──────────────────────────
  let feedback = null;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(chalk.blue(`\n  ━━━ Iteración ${iteration}/${MAX_ITERATIONS} ━━━`));

    // ── FASE 2: CODE ────────────────────────────────────────
    const codeResult = await runPhase(
      engine,
      promptCode(task, projectPath, plan, feedback),
      projectPath,
      `CODE — Implementación (iter ${iteration})`,
    );

    const codeOk = codeResult.marker === 'RESULTADO'
      ? codeResult.value?.toLowerCase().startsWith('completado')
      : codeResult.exitCode === 0;

    if (!codeOk) {
      const reason = codeResult.value || `Salió con código ${codeResult.exitCode}`;
      phasesRecord.code.push({ iteration, status: 'failed', duration: codeResult.duration, summary: reason });
      console.log(chalk.red(`  ✖ CODE falló: ${reason}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `CODE falló tras ${MAX_ITERATIONS} intentos: ${reason}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = `La implementación anterior falló: ${reason}. Intenta un enfoque diferente.`;
      continue;
    }

    const codeSummary = codeResult.value?.replace(/^completado\s*-?\s*/i, '') || 'Implementado';
    phasesRecord.code.push({ iteration, status: 'ok', duration: codeResult.duration, summary: codeSummary });
    console.log(chalk.cyan(`  ✔ CODE completado: ${codeSummary}`));

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

    if (!reviewApproved) {
      const problems = reviewResult.value?.replace(/^rechazado\s*-?\s*/i, '') || 'Problemas no especificados';
      phasesRecord.review.push({ iteration, status: 'rejected', duration: reviewResult.duration, summary: problems });
      console.log(chalk.yellow(`  ⚠ REVIEW rechazó: ${problems}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `Review falló tras ${MAX_ITERATIONS} intentos: ${problems}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'review-failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = `El revisor rechazó el código con estos problemas:\n${problems}\nCorrige exactamente estos puntos.`;
      continue;
    }

    const reviewComment = reviewResult.value?.replace(/^aprobado\s*-?\s*/i, '') || 'OK';
    phasesRecord.review.push({ iteration, status: 'approved', duration: reviewResult.duration, summary: reviewComment });
    console.log(chalk.cyan(`  ✔ REVIEW aprobado: ${reviewComment}`));

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

    if (!testsOk) {
      const testFailure = testResult.value?.replace(/^fallido\s*-?\s*/i, '') || 'Tests fallaron';
      phasesRecord.test.push({ iteration, status: 'failed', duration: testResult.duration, summary: testFailure });
      console.log(chalk.yellow(`  ⚠ TEST falló: ${testFailure}`));
      if (iteration >= MAX_ITERATIONS) {
        return {
          success: false,
          reason: `Tests fallaron tras ${MAX_ITERATIONS} intentos: ${testFailure}`,
          iterations: iteration,
          phasesRecord: { ...phasesRecord, result: 'test-failed', totalDuration: Date.now() - executionStart },
        };
      }
      feedback = `Los tests fallaron con este resultado:\n${testFailure}\nCorrige el código para que pasen los tests.`;
      continue;
    }

    const testSummary = testResult.value?.replace(/^ok\s*-?\s*/i, '') || 'Tests pasaron';
    phasesRecord.test.push({ iteration, status: 'ok', duration: testResult.duration, summary: testSummary });
    console.log(chalk.green(`  ✔ TESTS OK: ${testSummary}`));

    // ── TODO OK ─────────────────────────────────────────────
    return {
      success: true,
      summary: codeSummary,
      iterations: iteration,
      plan,
      reviewComment,
      testSummary,
      phasesRecord: { ...phasesRecord, result: 'success', totalDuration: Date.now() - executionStart },
    };
  }

  // No debería llegar aquí, pero por seguridad
  return {
    success: false,
    reason: `Se agotaron las ${MAX_ITERATIONS} iteraciones sin completar el ciclo`,
    iterations: MAX_ITERATIONS,
    phasesRecord: { ...phasesRecord, result: 'exhausted', totalDuration: Date.now() - executionStart },
  };
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

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.on('close', () => {
      try {
        const match = output.match(/\{[\s\S]+?\}/);
        if (!match) throw new Error('Sin JSON en respuesta');
        resolve(JSON.parse(match[0]));
      } catch (e) {
        reject(new Error(`No se pudo parsear: ${e.message}\nOutput: ${output.slice(0, 200)}`));
      }
    });
    proc.on('error', reject);
  });
}

module.exports = {
  executeTask,
  classifyTask,
  detectAvailableEngine,
  cliExists,
};
