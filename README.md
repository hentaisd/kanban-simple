# AI-Kanban

Sistema local de automatización de desarrollo. Las tareas son archivos `.md`. El motor usa el CLI `claude` o `opencode` instalado en tu PC para ejecutarlas automáticamente.

---

## Instalación

```bash
npm install
npm link              # instala el comando `ai-kanban` globalmente
ai-kanban init        # configuración interactiva inicial
```

---

## Flujo de trabajo

```
1. Configuras el proyecto y el engine una vez:
   ai-kanban init

2. Creas tareas:
   ai-kanban create "crear endpoint POST /api/users"
   ai-kanban create --type=fix --title="Error 500 en login" --priority=alta

3. Las mueves a TODO cuando están listas:
   ai-kanban move 001 todo

4. Inicias el motor:
   ai-kanban start          # loop infinito
   ai-kanban start --once   # una tarea y termina

5. Ves el progreso en el tablero visual:
   ai-kanban board   → http://localhost:3847
```

---

## Comandos CLI

| Comando | Descripción |
|---------|-------------|
| `ai-kanban init` | Configuración interactiva (proyecto, engine, git) |
| `ai-kanban create "descripción"` | Crea tarea clasificando automáticamente |
| `ai-kanban create --type=feature --title="X" --priority=alta` | Crea con flags explícitos |
| `ai-kanban create --ai "descripción"` | Usa IA para clasificar (requiere claude/opencode) |
| `ai-kanban list` | Lista todas las tareas |
| `ai-kanban list todo` | Lista tareas de una columna |
| `ai-kanban list --label=auth` | Filtra por etiqueta |
| `ai-kanban move 001 todo` | Mueve tarea a otra columna |
| `ai-kanban show 001` | Muestra detalle de una tarea |
| `ai-kanban delete 001` | Elimina una tarea |
| `ai-kanban board` | Abre el tablero visual en navegador |
| `ai-kanban start` | Inicia el motor (loop infinito) |
| `ai-kanban start --once` | Procesa una tarea y termina |
| `ai-kanban start --dry-run` | Simula sin ejecutar |
| `ai-kanban start --interactive` | Modo interactivo con la IA |
| `ai-kanban interactive` o `ai-kanban i` | Sesión interactiva directa con la IA |

### Opciones de `create`

```bash
-t, --type <type>       # feature | fix | bug (default: feature)
-T, --title <title>     # título de la tarea
-p, --priority <p>      # alta | media | baja (default: media)
-l, --labels <labels>   # etiquetas separadas por coma: auth,api,ui
-c, --column <col>      # backlog | todo | in_progress | review | done
--ai                    # usar IA para clasificar texto libre
--engine <engine>       # claude | opencode
```

### Opciones de `start`

```bash
--once                  # procesar solo una tarea y salir
--dry-run               # simular sin ejecutar cambios
--interactive           # abrir sesión interactiva con la IA
--project <path>        # sobrescribir projectPath
--engine <engine>       # sobrescribir engine
```

---

## Columnas del Kanban

| Columna | Descripción |
|---------|-------------|
| `backlog` | Tareas pendientes de priorizar |
| `todo` | Listas para ejecutar — el motor las toma de aquí |
| `in_progress` | El agente está trabajando en ella |
| `review` | Falló o necesita revisión manual |
| `done` | Completadas exitosamente |

---

## Motor IA: Ciclo de ejecución

Por cada tarea el motor ejecuta este ciclo:

```
┌─────────────────────────────────────────────────────────────┐
│  FASE 1 — PLAN                                              │
│  Analiza el proyecto, lee archivos, planifica la solución   │
├─────────────────────────────────────────────────────────────┤
│  FASE 2 — CODE                                              │
│  Implementa según el plan                                   │
├─────────────────────────────────────────────────────────────┤
│  FASE 3 — REVIEW                                            │
│  Revisa el código, detecta bugs y problemas                 │
│  Si rechaza → vuelve a CODE con feedback (máx 3 iteraciones)│
├─────────────────────────────────────────────────────────────┤
│  FASE 4 — TEST                                              │
│  Ejecuta tests existentes o crea nuevos                     │
│  Si falla → vuelve a CODE con feedback                      │
├─────────────────────────────────────────────────────────────┤
│  FASE 5 — SCOPE                                             │
│  Verifica que cumple los criterios de aceptación            │
│  Actualiza el contexto del proyecto                         │
└─────────────────────────────────────────────────────────────┘
```

### Timeouts por fase

| Fase | Tiempo total | Inactividad máxima |
|------|--------------|-------------------|
| PLAN | 15 min | 8 min |
| CODE | 30 min | 12 min |
| REVIEW | 15 min | 8 min |
| TEST | 20 min | 10 min |
| SCOPE | 15 min | 8 min |

---

## Integración Git

El motor maneja git automáticamente:

```
1. Guarda stash si hay cambios pendientes
2. Checkout a la rama base (main/develop)
3. Crea branch: feature/titulo-de-la-tarea
4. Ejecuta la tarea (la IA escribe código)
5. git add + commit
6. Merge a rama base (si autoMerge=true)
7. Elimina el branch de la tarea
8. Restaura stash si había
```

### Configuración git

```js
git: {
  enabled: true,          // activar/desactivar integración
  defaultBranch: 'main',  // rama base del proyecto
  autoPush: false,        // push automático al remote
  autoMerge: true,        // merge automático a rama base
}
```

---

## Multi-proyecto

Puedes registrar varios proyectos en `kanban.config.js`:

```js
projects: {
  'mi-api': {
    path: '/home/user/proyectos/mi-api',
    git: { defaultBranch: 'main', autoPush: false, autoMerge: true },
  },
  'mi-app': {
    path: '/home/user/proyectos/mi-app',
    git: { defaultBranch: 'develop' },
  },
},
defaultProject: 'mi-api',
```

Desde la UI web puedes cambiar el proyecto activo.

---

## Formato de tarea (.md)

```markdown
---
id: "001"
title: Crear endpoint de usuarios
type: feature
priority: alta
branch: feature/crear-endpoint-de-usuarios
labels: [api, backend]
status: todo
dependsOn: []           # IDs de tareas que deben completarse antes
---

# Descripción
Crear POST /api/users en Express que reciba name y email.

# Archivos relevantes
- `src/routes/users.js`
- `src/models/User.js`

# Criterios de aceptación
- [ ] Endpoint responde 201 con el usuario creado
- [ ] Valida que email tenga formato correcto
- [ ] Los tests pasan
```

---

## UI Web

El tablero visual en `http://localhost:3847` permite:

- Ver todas las tareas en columnas drag & drop
- Crear, editar, eliminar tareas
- Mover tareas entre columnas
- Ver historial y artefactos de cada tarea
- Iniciar/detener el motor IA
- Cambiar entre proyectos
- Ver logs del motor en tiempo real
- Ver métricas agregadas

### API REST

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/tasks` | Lista tareas por columna |
| `GET /api/tasks/:id` | Detalle de tarea |
| `POST /api/tasks` | Crear tarea |
| `PUT /api/tasks/:id` | Actualizar tarea |
| `PUT /api/tasks/:id/move` | Mover tarea |
| `DELETE /api/tasks/:id` | Eliminar tarea |
| `GET /api/tasks/:id/history` | Historial de ejecución |
| `GET /api/tasks/:id/artifacts` | Artefactos de fases |
| `GET /api/tasks/:id/diff` | Diff git de la tarea |
| `POST /api/tasks/:id/rollback` | Rollback git |
| `GET /api/projects` | Lista proyectos |
| `POST /api/projects` | Agregar proyecto |
| `DELETE /api/projects/:name` | Eliminar proyecto |
| `POST /api/projects/active` | Cambiar proyecto activo |
| `GET /api/loop/status` | Estado del motor |
| `POST /api/loop/start` | Iniciar motor |
| `POST /api/loop/stop` | Detener motor |
| `GET /api/loop/logs` | Logs del motor |
| `GET /api/engine` | Engine configurado |
| `POST /api/engine` | Cambiar engine |
| `GET /api/metrics` | Métricas del tablero |
| `GET /api/notifications` | Notificaciones |
| `PUT /api/notifications/read` | Marcar como leídas |
| `GET /api/sync` | Estado de sincronización |
| `POST /api/sync` | Solicitar sincronización manual |

### WebSocket

Conexión en `ws://localhost:3847/ws` para actualizaciones en tiempo real.

---

## Configuración: kanban.config.js

```js
module.exports = {
  // Multi-proyecto
  projects: {
    'nombre-proyecto': {
      path: '/ruta/al/proyecto',
      git: { defaultBranch: 'main', autoPush: false, autoMerge: true },
    },
  },
  defaultProject: 'nombre-proyecto',

  // Fallback si no hay proyectos configurados
  projectPath: process.cwd(),

  // Motor IA: 'claude' | 'opencode'
  engine: 'opencode',

  // Git global
  git: {
    enabled: true,
    defaultBranch: 'main',
    autoPush: false,
    autoMerge: true,
  },

  // Puerto de la UI
  port: 3847,

  // Loop del motor
  loop: {
    waitSeconds: 30,        // espera entre ciclos sin tareas
    maxTasksPerRun: 0,      // 0 = ilimitado
    autoRetry: true,        // reintentar tareas fallidas
    maxRetries: 3,          // máximo reintentos
    retryDelayMinutes: 5,   // minutos entre reintentos
  },
};
```

---

## Engines disponibles

| Engine | Comando | Instalación |
|--------|---------|-------------|
| Claude Code | `claude` | https://claude.ai/code |
| OpenCode | `opencode` | `npm i -g opencode-ai` |

El sistema detecta automáticamente cuál está disponible.

---

## Dependencias entre tareas

Puedes especificar que una tarea depende de otras:

```yaml
dependsOn: [5, 12]   # esta tarea espera a que #005 y #012 estén en done
```

El motor no procesará la tarea hasta que todas las dependencias estén completadas.

---

## Historial y artefactos

Cada ejecución guarda artefactos en `kanban/.history/{id}/`:

- `plan.md` / `plan.log` — Resultado de la fase PLAN
- `code-iter1.md` / `code-iter1.log` — Primera iteración de CODE
- `review-iter1.md` / `review-iter1.log` — Primera iteración de REVIEW
- `test-iter1.md` / `test-iter1.log` — Primera iteración de TEST
- etc.

---

## Notificaciones del sistema

El motor envía notificaciones de escritorio (Linux/macOS/Windows) cuando:
- Una tarea se completa
- Una tarea falla
- El motor se detiene

---

## Cache Redis (opcional)

Si tienes Redis corriendo, el sistema lo usa para cachear tareas y mejorar rendimiento. Si no está disponible, funciona en modo sin caché.

---

## Sincronización entre equipos (Multi-usuario)

Varias personas pueden trabajar en el mismo tablero simultáneamente. Los cambios se sincronizan en tiempo real via WebSocket.

### Características

- **Identificación automática**: Usa tu `git config user.name` como identificador
- **Sincronización inicial**: Al conectar, descarga tareas existentes de otros peers
- **Detección de conflictos**: Compara fechas de modificación (gana el más reciente)
- **Historial de quién hizo qué**: Cada cambio muestra el nombre del autor

### Arquitectura

```
Persona A                    Servidor Relay              Persona B
┌──────────┐                 ┌──────────┐               ┌──────────┐
│kanban/   │                 │  NUBE    │               │kanban/   │
│.md       │──WebSocket─────►│  Relay   │◄──WebSocket──│.md       │
│Motor IA  │                 │          │               │Motor IA  │
└──────────┘                 └──────────┘               └──────────┘
```

- Cada persona tiene sus archivos `.md` locales
- La IA lee/escribe archivos locales como siempre
- Los cambios se transmiten automáticamente a todos los conectados

### Configuración

Crea un archivo `.env` en la raíz del proyecto:

```bash
# Copiar el ejemplo
cp .env.example .env
```

Contenido del `.env`:

```env
# Sincronización entre equipos (dejar vacío para desactivar)
KANBAN_SYNC_URL=wss://tu-relay-server.com

# Motor IA (opcional, sobrescribe config)
# KANBAN_ENGINE=opencode

# Puerto de la UI (opcional)
# PORT=3847
```

Sin `KANBAN_SYNC_URL`, el sistema funciona normalmente sin sincronización.

### Estado del sync

```bash
curl http://localhost:3847/api/sync
```

Respuesta:
```json
{
  "success": true,
  "enabled": true,
  "connected": true,
  "relayUrl": "wss://tu-relay-server.com"
}
```

### Cómo usar en equipo

**Tu compañero debe:**

1. Tener AI-Kanban instalado en su PC
2. Crear un archivo `.env` con la MISMA URL del relay:
   ```env
   KANBAN_SYNC_URL=wss://ai-kanban-relay-production.up.railway.app
   ```
3. Iniciar el servidor:
   ```bash
   npm run board
   ```

**Cuando ambos estén conectados:**

- Tú creas una tarea → aparece en el tablero de tu compañero
- Tu compañero mueve una tarea → se mueve en tu tablero
- Ambos pueden ejecutar el motor IA
- Los archivos `.md` se mantienen sincronizados

### Desplegar servidor relay

Ver repositorio: https://github.com/hentaisd/ai-kanban-relay

1. Crear cuenta en Railway.app
2. Conectar con GitHub
3. Desplegar el repositorio
4. Usar la URL generada (ej: `wss://xxx.up.railway.app`)

---

## Archivos importantes

```
kanban-simple/
├── src/
│   ├── cli/               # Comandos CLI
│   │   ├── index.js       # Entry point
│   │   └── commands/      # Cada comando
│   ├── core/
│   │   ├── loop.js        # Motor principal
│   │   ├── ai-executor.js # Ejecutor de fases IA
│   │   ├── task.js        # Gestión de tareas
│   │   ├── history.js     # Historial
│   │   ├── cache.js       # Cache Redis
│   │   ├── sync.js        # Sincronización entre equipos
│   │   └── notifications.js
│   ├── kanban/
│   │   └── board.js       # Operaciones del tablero
│   ├── git/
│   │   └── gitService.js  # Integración git
│   └── ui/
│       ├── server.js      # API REST + WebSocket
│       └── public/        # Frontend
├── kanban/
│   ├── backlog/           # Tareas en backlog
│   ├── todo/              # Tareas listas
│   ├── in_progress/       # En ejecución
│   ├── review/            # Pendientes de revisión
│   ├── done/              # Completadas
│   ├── .history/          # Artefactos de ejecución
│   ├── templates/         # Templates de tarea
│   └── projects.json      # Proyectos registrados
└── kanban.config.js       # Configuración
```

---

## Lo que NO está implementado

| Característica | Estado |
|----------------|--------|
| Integración con Telegram | No implementado |
| Crear tareas desde Telegram | No implementado |
| Notificaciones a Telegram | No implementado |
| Integración con Slack | No implementado |
| Integración con Discord | No implementado |
| Autenticación de usuarios | No implementado (cualquiera con acceso al relay puede sincronizar) |

---

## Requisitos

- Node.js >= 18
- `claude` o `opencode` instalado globalmente
- Git (opcional, para integración git)
- Redis (opcional, para caché)
