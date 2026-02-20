/**
 * kanban.config.js — Configuración del sistema AI-Kanban
 *
 * MULTI-PROYECTO: registra tus proyectos en el bloque `projects`.
 * Al crear una tarea, selecciona el proyecto desde la UI o el CLI.
 * El agente IA trabajará en el directorio del proyecto seleccionado.
 */

module.exports = {

  // ─── PROYECTOS ──────────────────────────────────────────────────────────
  // Registra aquí todos los proyectos en los que trabaja el agente.
  // La clave es el nombre corto que usarás al crear tareas.
  //
  // Ejemplo:
  //   projects: {
  //     'mi-app': {
  //       path: '/home/usuario/proyectos/mi-app',
  //       git: { defaultBranch: 'main', autoPush: false, autoMerge: true },
  //     },
  //     'landing': {
  //       path: '/home/usuario/proyectos/landing',
  //     },
  //   },
  //   defaultProject: 'mi-app',
  //
  projects: {
    'kanban-simple': {
      path: '/home/phantom/Documents/proyectos/kanban-simple',
      git: { defaultBranch: 'main', autoPush: false, autoMerge: true },
    },
  },

  // Proyecto por defecto cuando una tarea no especifica ninguno.
  defaultProject: 'kanban-simple',

  // ─── PROYECTO LEGACY (fallback si no usas `projects`) ───────────────────
  // Se usa solo cuando `projects` está vacío o `defaultProject` no está seteado.
  projectPath: process.env.KANBAN_PROJECT || process.cwd(),

  // ─── MOTOR IA ────────────────────────────────────────────────────────────
  // 'claude'   → usa el CLI `claude` (Claude Code)
  // 'opencode' → usa el CLI `opencode`
  engine: process.env.KANBAN_ENGINE || 'claude',

  // ─── GIT (valores por defecto para todos los proyectos) ──────────────────
  git: {
    enabled: true,
    defaultBranch: 'main',
    autoPush: false,
    autoMerge: true,
  },

  // ─── UI ──────────────────────────────────────────────────────────────────
  port: process.env.PORT || 3847,

  // ─── LOOP ────────────────────────────────────────────────────────────────
  loop: {
    waitSeconds: 30,
    maxTasksPerRun: 0,
    // Reintento automático de tareas fallidas
    autoRetry: true,           // Habilitar reintento automático
    maxRetries: 3,             // Máximo de reintentos antes de dejar en review
    retryDelayMinutes: 5,      // Minutos entre reintentos
  },
};
