# Plan — Tarea #004: sistema de notificaciones push con WebSockets

**Engine:** claude
**Duración:** 73s
**ExitCode:** 0
**TimedOut:** false

---

Crear `src/core/notifications.js` (NotificationManager con historial en memoria, tipos, prioridades, mark-read). Agregar `ws` a package.json. Modificar `src/ui/server.js` para crear WebSocketServer sobre el http.Server existente, instanciar NotificationManager, reemplazar `broadcastChange()` por `notifications.broadcast()`, agregar endpoints `GET /api/notifications` y `PUT /api/notifications/read`. Modificar `src/ui/public/app.js` para usar WebSocket como transporte primario con fallback a SSE, implementar Notification Center con historial, badge de no-leídas y reconexión con backoff exponencial. Modificar `src/ui/public/index.html` para agregar el panel dropdown del Notification Center junto al bell icon. Modificar `src/ui/public/style.css` con estilos del notification center. Crear `tests/test-notifications.js` con tests del NotificationManager (crear, almacenar, límite, markRead, broadcast).
