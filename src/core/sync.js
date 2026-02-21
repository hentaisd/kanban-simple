const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

let ws = null;
let reconnectTimer = null;
let isConnected = false;
let kanbanPath = null;
let syncEnabled = false;

const RELAY_URL = process.env.KANBAN_SYNC_URL || '';

function connectSync(kanbanDir, onSync = null) {
  kanbanPath = kanbanDir;
  
  if (!RELAY_URL) {
    console.log(chalk.gray(`[Sync] Desactivado (sin KANBAN_SYNC_URL en .env)`));
    syncEnabled = false;
    return;
  }
  
  syncEnabled = true;
  connect(onSync);
}

function connect(onSync) {
  if (!syncEnabled || !RELAY_URL) return;
  
  console.log(chalk.gray(`[Sync] Conectando a ${RELAY_URL}...`));
  
  try {
    ws = new WebSocket(RELAY_URL);
  } catch (err) {
    console.log(chalk.yellow(`[Sync] Error creando WebSocket: ${err.message}`));
    scheduleReconnect(onSync);
    return;
  }
  
  ws.on('open', () => {
    isConnected = true;
    console.log(chalk.green(`[Sync] Conectado al relay`));
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'connected') {
        console.log(chalk.gray(`[Sync] Clientes conectados: ${msg.clients}`));
        return;
      }
      
      if (msg._local) return;
      
      if (onSync) {
        onSync(msg);
      } else {
        handleSyncMessage(msg);
      }
    } catch (err) {
      console.log(chalk.yellow(`[Sync] Error parseando mensaje: ${err.message}`));
    }
  });
  
  ws.on('close', () => {
    isConnected = false;
    console.log(chalk.yellow(`[Sync] Desconectado del relay`));
    scheduleReconnect(onSync);
  });
  
  ws.on('error', (err) => {
    isConnected = false;
    console.log(chalk.yellow(`[Sync] Error WebSocket: ${err.message}`));
  });
}

function scheduleReconnect(onSync) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (syncEnabled) connect(onSync);
  }, 5000);
}

function handleSyncMessage(msg) {
  if (!kanbanPath) return;
  
  const { type, task, fromColumn, toColumn, column, filename, content } = msg;
  
  switch (type) {
    case 'task:created':
    case 'task:updated':
      if (filename && content && column) {
        const filePath = path.join(kanbanPath, column, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(chalk.cyan(`[Sync] Tarea ${type === 'task:created' ? 'creada' : 'actualizada'}: ${filename}`));
      }
      break;
      
    case 'task:moved':
      if (filename && fromColumn && toColumn) {
        const fromPath = path.join(kanbanPath, fromColumn, filename);
        const toPath = path.join(kanbanPath, toColumn, filename);
        if (fs.existsSync(fromPath)) {
          fs.mkdirSync(path.dirname(toPath), { recursive: true });
          fs.renameSync(fromPath, toPath);
          console.log(chalk.cyan(`[Sync] Tarea movida: ${fromColumn} → ${toColumn}`));
        }
      }
      break;
      
    case 'task:deleted':
      if (filename && column) {
        const filePath = path.join(kanbanPath, column, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(chalk.cyan(`[Sync] Tarea eliminada: ${filename}`));
        }
      }
      break;
  }
}

function broadcastChange(type, data) {
  if (!isConnected || !ws) return;
  
  const msg = { type, ...data, _local: true };
  
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.log(chalk.yellow(`[Sync] Error enviando: ${err.message}`));
  }
}

function broadcastTaskCreated(task, column, filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    broadcastChange('task:created', {
      task,
      column,
      filename: path.basename(filePath),
      content
    });
  } catch (err) {
    console.log(chalk.yellow(`[Sync] Error leyendo archivo: ${err.message}`));
  }
}

function broadcastTaskMoved(taskId, fromColumn, toColumn, filename) {
  broadcastChange('task:moved', {
    taskId,
    fromColumn,
    toColumn,
    filename
  });
}

function broadcastTaskUpdated(task, column, filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    broadcastChange('task:updated', {
      task,
      column,
      filename: path.basename(filePath),
      content
    });
  } catch (err) {
    console.log(chalk.yellow(`[Sync] Error leyendo archivo: ${err.message}`));
  }
}

function broadcastTaskDeleted(taskId, column, filename) {
  broadcastChange('task:deleted', {
    taskId,
    column,
    filename
  });
}

function disconnectSync() {
  syncEnabled = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnected = false;
}

function getStatus() {
  return {
    enabled: syncEnabled,
    connected: isConnected,
    relayUrl: RELAY_URL
  };
}

module.exports = {
  connectSync,
  disconnectSync,
  broadcastChange,
  broadcastTaskCreated,
  broadcastTaskMoved,
  broadcastTaskUpdated,
  broadcastTaskDeleted,
  getStatus
};
