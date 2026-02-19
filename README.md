# 🤖 AI-Kanban

Sistema local de automatización de desarrollo. Las tareas son archivos `.md`. El motor usa el CLI `claude` o `opencode` instalado en tu PC para ejecutarlas automáticamente.

---

## Instalación rápida

```bash
npm install
ai-kanban init        # configura proyecto y engine una vez
```

---

## Flujo de trabajo

```
1. Configuras el proyecto y el engine una vez:
   ai-kanban init

2. Creas tareas describiendo lo que quieres:
   ai-kanban create "crear endpoint POST /api/users en Express"
   ai-kanban create --type=fix --title="Error 500 en login" --priority=alta

3. Las mueves a TODO cuando están listas:
   ai-kanban move 001 todo

4. Arrancas el motor — ejecuta las tareas automáticamente:
   ai-kanban start

   El motor por cada tarea:
   ┌─────────────────────────────────────────────────┐
   │ 1. Lee el .md de la tarea                       │
   │ 2. Crea branch git (feature/fix/bug)            │
   │ 3. Lanza claude o opencode en tu proyecto       │
   │ 4. El agente escribe el código real             │
   │ 5. git add + commit (+ push si autoPush=true)   │
   │ 6. Mueve la tarea a DONE o REVIEW               │
   └─────────────────────────────────────────────────┘

5. Ves el progreso en el tablero visual:
   ai-kanban board      →  http://localhost:3000
```

---

## Configuración: `kanban.config.js`

```js
module.exports = {
  // Dónde está el proyecto donde el agente escribirá código
  projectPath: '/ruta/a/mi-proyecto',

  // CLI a usar: 'claude' | 'opencode'
  engine: 'claude',

  git: {
    enabled: true,
    defaultBranch: 'main',
    autoPush: false,    // true para push automático
    autoMerge: true,
  },

  loop: {
    waitSeconds: 30,    // espera entre ciclos cuando no hay tareas
    maxTasksPerRun: 0,  // 0 = ilimitado
  },
};
```

También puedes sobreescribir desde la línea de comandos:
```bash
ai-kanban start --project /otro/proyecto --engine opencode
```

---

## Comandos CLI

```bash
# Configurar (wizard interactivo)
ai-kanban init

# Crear tarea con flags
ai-kanban create --type=feature --title="Mi tarea" --priority=alta --labels=auth,ui

# Crear desde texto libre (clasifica automáticamente)
ai-kanban create "arreglar el bug del login"
ai-kanban create --ai "arreglar el bug del login"   # usa claude/opencode para clasificar

# Listar tablero
ai-kanban list
ai-kanban list todo
ai-kanban list --label=auth

# Mover tarea
ai-kanban move 001 todo
ai-kanban move 001 done

# Ver detalle
ai-kanban show 001

# Tablero visual (abre http://localhost:3000)
ai-kanban board

# Motor de automatización
ai-kanban start                             # loop infinito
ai-kanban start --once                      # procesa una tarea y termina
ai-kanban start --dry-run                   # simula sin ejecutar
ai-kanban start --project /ruta --engine opencode   # sobreescribir config
```

---

## Formato de tarea (`.md`)

Ver template completo en: `kanban/templates/task-template.md`

```markdown
---
id: "001"
title: Crear endpoint de usuarios
type: feature
priority: alta
branch: feature/crear-endpoint-de-usuarios
labels: [api, backend]
status: todo
---

# Descripción
Crear POST /api/users en Express que reciba name y email.

# Archivos relevantes
- `src/routes/users.js`
- `src/models/User.js`

# Criterios de aceptación
- [ ] Endpoint responde 201 con el usuario creado
- [ ] Valida que email tenga formato correcto
- [ ] Tests pasan
```

---

## Engines disponibles

| Engine | Comando | Instalación |
|--------|---------|-------------|
| Claude Code | `claude` | https://claude.ai/code |
| OpenCode | `opencode` | `npm i -g opencode-ai` |

El sistema detecta automáticamente cuál está disponible. Si tienes los dos, elige con `--engine`.

---

## Columnas del Kanban

| Columna | Descripción |
|---------|-------------|
| `backlog` | Tareas por priorizar |
| `todo` | Listas para ejecutar — el motor las toma de aquí |
| `in_progress` | El agente está trabajando en ella |
| `review` | Falló o necesita revisión manual |
| `done` | Completadas |
