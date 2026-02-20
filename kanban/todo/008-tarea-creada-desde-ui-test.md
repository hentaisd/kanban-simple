---
id: 008
title: Tarea creada desde UI test
type: bug
priority: alta
branch: bug/tarea-creada-desde-ui-test
labels:
  - uitest
  - automated
status: in_progress
---
# Descripción
Bug: La función `isEmptyPlaceholder` en app.js no tenía null-check, causando error cuando el contenido estaba vacío o era null.

# Criterios de aceptación
- [x] Agregado null-check en `isEmptyPlaceholder` (app.js:1372)
- [x] La función ahora retorna `true` si content es null/undefined
