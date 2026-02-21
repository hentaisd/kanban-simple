const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');

let ws = null;
let reconnectTimer = null;
let isConnected = false;
let kanbanPath = null;
let syncEnabled = false;
let peerId = null;
let peerName = null;
let initialSyncDone = false;

const RELAY_URL = process.env.KANBAN_SYNC_URL || '';

function getPeerInfo() {
  if (peerId) return { id: peerId, name: peerName };
  
  const idFile = path.join(require('os').homedir(), '.ai-kanban-peer.json');
  
  try {
    if (fs.existsSync(idFile)) {
      const data = JSON.parse(fs.readFileSync(idFile, 'utf8'));
      peerId = data.id;
      peerName = data.name;
      return { id: peerId, name: peerName };
    }
  } catch {}
  
  try {
    peerName = execSync('git config user.name 2>/dev/null', { encoding: 'utf8' }).trim() || 'Anonymous';
  } catch {
    peerName = 'Anonymous';
  }
  
  peerId = 'peer-' + Math.random().toString(36).slice(2, 10);
  
  try {
    fs.writeFileSync(idFile, JSON.stringify({ id: peerId, name: peerName }, null, 2));
  } catch {}
  
  return { id: peerId, name: peerName };
}

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
  
  const peer = getPeerInfo();
  console.log(chalk.gray(`[Sync] Conectando como ${peer.name} (${peer.id})...`));
  
  try {
    ws = new WebSocket(RELAY_URL, {
      headers: {
        'x-peer-id': peer.id,
        'x-peer-name': encodeURIComponent(peer.name)
      }
    });
  } catch (err) {
    console.log(chalk.yellow(`[Sync] Error creando WebSocket: ${err.message}`));
    scheduleReconnect(onSync);
    return;
  }
  
  ws.on('open', () => {
    isConnected = true;
    initialSyncDone = false;
    console.log(chalk.green(`[Sync] Conectado al relay como ${chalk.cyan(peer.name)}`));
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
      
      if (msg.type === 'sync:request') {
        handleSyncRequest(msg, onSync);
        return;
      }
      
      if (msg.type === 'sync:full') {
        handleFullSync(msg, onSync);
        return;
      }
      
      if (msg.peerId === peer.id) return;
      
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
    initialSyncDone = false;
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

function handleSyncRequest(msg, onSync) {
  if (!kanbanPath) return;
  
  console.log(chalk.cyan(`[Sync] Enviando tareas locales a ${msg.peerName || 'nuevo peer'}...`));
  
  const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  const tasks = {};
  
  for (const col of COLUMNS) {
    const colPath = path.join(kanbanPath, col);
    if (!fs.existsSync(colPath)) continue;
    
    const files = fs.readdirSync(colPath).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(colPath, file);
      tasks[file] = {
        column: col,
        content: fs.readFileSync(filePath, 'utf8'),
        mtime: fs.statSync(filePath).mtime.getTime()
      };
    }
  }
  
  const peer = getPeerInfo();
  ws.send(JSON.stringify({
    type: 'sync:full',
    peerId: peer.id,
    peerName: peer.name,
    targetPeerId: msg.peerId,
    tasks
  }));
}

function handleFullSync(msg, onSync) {
  if (msg.targetPeerId && msg.targetPeerId !== peer.id) return;
  if (initialSyncDone) return;
  
  console.log(chalk.cyan(`[Sync] Recibiendo ${Object.keys(msg.tasks).length} tareas de ${msg.peerName}...`));
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  
  for (const [filename, data] of Object.entries(msg.tasks)) {
    const filePath = path.join(kanbanPath, data.column, filename);
    
    if (fs.existsSync(filePath)) {
      const localMtime = fs.statSync(filePath).mtime.getTime();
      if (data.mtime > localMtime) {
        fs.writeFileSync(filePath, data.content, 'utf8');
        updated++;
      } else {
        skipped++;
      }
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data.content, 'utf8');
      created++;
    }
  }
  
  initialSyncDone = true;
  console.log(chalk.green(`[Sync] Sincronización inicial: ${created} creadas, ${updated} actualizadas, ${skipped} sin cambios`));
  
  if (onSync) {
    onSync({ type: 'sync:complete', created, updated, skipped });
  }
}

function handleSyncMessage(msg) {
  if (!kanbanPath) return;
  
  const { type, task, fromColumn, toColumn, column, filename, content, peerName } = msg;
  const who = peerName ? chalk.magenta(`(${peerName})`) : '';
  
  switch (type) {
    case 'task:created':
    case 'task:updated':
      if (filename && content && column) {
        const filePath = path.join(kanbanPath, column, filename);
        
        if (fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, content, 'utf8');
          console.log(chalk.cyan(`[Sync] ${who} Tarea actualizada: ${filename}`));
        } else {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
          console.log(chalk.cyan(`[Sync] ${who} Tarea creada: ${filename}`));
        }
      }
      break;
      
    case 'task:moved':
      if (filename && fromColumn && toColumn) {
        const fromPath = path.join(kanbanPath, fromColumn, filename);
        const toPath = path.join(kanbanPath, toColumn, filename);
        if (fs.existsSync(fromPath)) {
          fs.mkdirSync(path.dirname(toPath), { recursive: true });
          fs.renameSync(fromPath, toPath);
          console.log(chalk.cyan(`[Sync] ${who} Tarea movida: ${fromColumn} → ${toColumn}`));
        } else if (fs.existsSync(toPath)) {
          console.log(chalk.gray(`[Sync] ${who} Tarea ya estaba en ${toColumn}`));
        }
      }
      break;
      
    case 'task:deleted':
      if (filename && column) {
        const filePath = path.join(kanbanPath, column, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(chalk.cyan(`[Sync] ${who} Tarea eliminada: ${filename}`));
        }
      }
      break;
  }
}

function broadcastChange(type, data) {
  if (!isConnected || !ws) return;
  
  const peer = getPeerInfo();
  const msg = { type, ...data, peerId: peer.id, peerName: peer.name, timestamp: Date.now() };
  
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

function requestSync() {
  if (!isConnected || !ws) {
    console.log(chalk.yellow(`[Sync] No conectado al relay`));
    return;
  }
  
  const peer = getPeerInfo();
  ws.send(JSON.stringify({
    type: 'sync:request',
    peerId: peer.id,
    peerName: peer.name
  }));
  
  console.log(chalk.cyan(`[Sync] Solicitando sincronización a otros peers...`));
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
  const peer = getPeerInfo();
  return {
    enabled: syncEnabled,
    connected: isConnected,
    relayUrl: RELAY_URL,
    peerId: peer.id,
    peerName: peer.name
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
  getStatus,
  requestSync
};
