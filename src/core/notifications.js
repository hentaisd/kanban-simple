/**
 * notifications.js - NotificationManager con historial en memoria, tipos, prioridades, mark-read
 */

const NOTIFICATION_TYPES = {
  TASK_CREATED: 'task:created',
  TASK_MOVED: 'task:moved',
  TASK_UPDATED: 'task:updated',
  TASK_DELETED: 'task:deleted',
  TASK_COMPLETED: 'task:completed',
  LOOP_STARTED: 'loop:started',
  LOOP_STOPPED: 'loop:stopped',
  ENGINE_CHANGED: 'engine:changed',
  PROJECT_CHANGED: 'project:changed',
  SYSTEM: 'system',
};

const PRIORITY_LEVELS = {
  low: 0,
  normal: 1,
  high: 2,
};

const MAX_NOTIFICATIONS = 200;

class NotificationManager {
  constructor() {
    this.notifications = [];
    this.wsClients = new Set();
    this.counter = 0;
  }

  /**
   * Crea una nueva notificación y la envía por WebSocket
   */
  create({ type, title, message, priority = 'normal', meta = {} }) {
    const notification = {
      id: ++this.counter,
      type: type || NOTIFICATION_TYPES.SYSTEM,
      title: title || '',
      message: message || '',
      priority,
      meta,
      read: false,
      timestamp: Date.now(),
    };

    this.notifications.push(notification);

    // Límite de historial
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    }

    this.broadcast({
      event: 'notification',
      data: notification,
    });

    return notification;
  }

  /**
   * Obtiene todas las notificaciones (más recientes primero)
   */
  getAll({ limit = 50, unreadOnly = false } = {}) {
    let result = [...this.notifications];
    if (unreadOnly) {
      result = result.filter(n => !n.read);
    }
    return result.reverse().slice(0, limit);
  }

  /**
   * Cuenta notificaciones no leídas
   */
  getUnreadCount() {
    return this.notifications.filter(n => !n.read).length;
  }

  /**
   * Marca una notificación como leída
   */
  markRead(id) {
    const notif = this.notifications.find(n => n.id === id);
    if (notif) {
      notif.read = true;
      this.broadcast({
        event: 'notification:read',
        data: { id },
      });
    }
    return notif || null;
  }

  /**
   * Marca todas como leídas
   */
  markAllRead() {
    let count = 0;
    for (const n of this.notifications) {
      if (!n.read) {
        n.read = true;
        count++;
      }
    }
    if (count > 0) {
      this.broadcast({
        event: 'notification:allRead',
        data: { count },
      });
    }
    return count;
  }

  /**
   * Registra un cliente WebSocket
   */
  addClient(ws) {
    this.wsClients.add(ws);
  }

  /**
   * Elimina un cliente WebSocket
   */
  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  /**
   * Envía un mensaje a todos los clientes WebSocket conectados
   */
  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.wsClients) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(msg);
        }
      } catch {
        this.wsClients.delete(ws);
      }
    }
  }

  /**
   * Broadcast de cambio del kanban (reemplaza broadcastChange del SSE)
   */
  broadcastChange(type = 'update', extra = {}) {
    this.broadcast({
      event: 'board:change',
      data: { type, timestamp: Date.now(), ...extra },
    });
  }
}

module.exports = { NotificationManager, NOTIFICATION_TYPES, PRIORITY_LEVELS, MAX_NOTIFICATIONS };
