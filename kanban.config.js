/**
 * kanban.config.js — Configuración del sistema AI-Kanban
 *
 * Edita este archivo para apuntar al proyecto donde trabajará el agente.
 */

module.exports = {
  // ─── PROYECTO TARGET ────────────────────────────────────────────────
  // Ruta absoluta del proyecto donde el agente leerá y escribirá código.
  // El agente IA usará este directorio como working directory.
  // Puedes sobreescribir con: ai-kanban start --project /ruta/otro
  projectPath: process.env.KANBAN_PROJECT || process.cwd(),

  // ─── MOTOR IA ───────────────────────────────────────────────────────
  // 'claude'    → usa el CLI `claude` (Claude Code)
  // 'opencode'  → usa el CLI `opencode`
  // Puedes sobreescribir con: ai-kanban start --engine opencode
  engine: process.env.KANBAN_ENGINE || 'claude',

  // ─── GIT ────────────────────────────────────────────────────────────
  git: {
    enabled: true,           // false para desactivar git completamente
    defaultBranch: 'main',   // branch base (main | master | develop)
    autoPush: false,         // true para hacer push automático al remote
    autoMerge: true,         // true para merge automático después del push
  },

  // ─── UI ─────────────────────────────────────────────────────────────
  // Puerto del tablero visual (ai-kanban board)
  port: process.env.PORT || 3847,

  // ─── COMPORTAMIENTO DEL LOOP ────────────────────────────────────────
  loop: {
    waitSeconds: 30,         // segundos de espera entre ciclos cuando no hay tareas
    maxTasksPerRun: 0,       // 0 = ilimitado; N = procesar máximo N tareas por sesión
  },
};
