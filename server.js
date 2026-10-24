import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import fs from 'fs';
import { LocalCameraClient } from './lib/localClient.js';
import { StaCameraServer } from './lib/staServer.js';
import { startDnsServer } from './lib/dnsServer.js';
import { startStunServer } from './lib/stunServer.js';
import { IceSignalingService } from './lib/iceSignaling.js';
import { getLocalSavedRecordings, createMjpegAvi } from './lib/sdCardService.js';
import { getRecordingsDir, setRecordingsDir } from './lib/configService.js';
import { initBackgroundSync, syncState, triggerManualSync, setSyncEnabled, setDeleteAfterDownload, setAutoFormatAfterSync, markAsSynced, clearSyncedHistory } from './lib/backgroundSync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFile = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
function formatLog(prefix, args) {
  const t = new Date().toISOString();
  return `[${t}] ${prefix} ` + args.map(a => (typeof a === 'object' && a !== null) ? JSON.stringify(a) : a).join(' ') + '\n';
}
console.log = (...args) => {
  origLog(...args);
  logFile.write(formatLog('INFO', args));
};
console.error = (...args) => {
  origErr(...args);
  logFile.write(formatLog('ERROR', args));
};
console.warn = (...args) => {
  origWarn(...args);
  logFile.write(formatLog('WARN', args));
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const LOCAL_PC_IP = '192.168.15.5';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para rastrear todas as requisições HTTP da câmera
app.use((req, res, next) => {
  if (req.url.startsWith('/app/api')) {
    console.log(`[Camera STA HTTP] 📡 ${req.method} ${req.url}`);
    if (req.query && Object.keys(req.query).length > 0) console.log('  Query params:', req.query);
    if (req.body && Object.keys(req.body).length > 0) console.log('  Body:', req.body);
  }
  next();
});

// Global State
let activeCamera = {
  ip: '192.168.169.1',
  port: 6123,
  connected: true,
  mode: 'ap', // Modo AP Direto (câmera emitindo Wi-Fi)
  deviceCode: '5c0006004882',
  irLed: false,
  flip: false,
  motionGrade: 3,
  sdMoveMode: true
};

let activeLocalClient = null;

// Inicializa o Servidor STA (Modo Wi-Fi Residencial)
const staServer = new StaCameraServer({
  localIp: LOCAL_PC_IP,
  port: 6123
});

staServer.on('frame', (dataUrl) => {
  activeCamera.connected = true;
  activeCamera.mode = 'sta';
  const msg = JSON.stringify({ type: 'cloud_frame', data: dataUrl, timestamp: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
});

staServer.on('status', (status) => {
  console.log('[STA Status]', status);
  if (status.status === 'camera_connected' || status.status === 'mqtt_connected' || status.status === 'streaming_started') {
    activeCamera.connected = true;
    activeCamera.mode = 'sta';
    if (status.address) activeCamera.ip = status.address;
  } else if (status.status === 'camera_disconnected') {
    activeCamera.connected = false;
  }
  const msg = JSON.stringify({ type: 'local_status', data: status, cameraState: activeCamera });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
});

staServer.start();

// Inicializa o Servidor DNS Interceptor (porta 53)
try {
  startDnsServer({
    targetIp: LOCAL_PC_IP,
    upstreamDns: '8.8.8.8'
  });
} catch (e) {
  console.warn('[DNS Server Warning]', e.message);
}

// Inicializa o Servidor STUN (porta UDP 3578 para icev720.naxclow.com)
try {
  startStunServer(3578);
} catch (e) {
  console.warn('[STUN Server Warning]', e.message);
}

// Serviço de Sinalização WebRTC / NanoRTSP
const iceSignaling = new IceSignalingService();

// --- ROTAS DE INTERCEPTAÇÃO DA CÂMERA (HTTP PORT 80 -> PROXIED TO 3000 VIA APACHE) ---
app.all('/app/api/ApiSysDevicesBatch/registerDevices*', (req, res) => {
  console.log('[Camera STA HTTP] 📡 registerDevices interceptado!');
  res.json({ code: 200, message: "OK", data: "0800c00128F8" });
});

app.all('/app/api/ApiSysDevicesBatch/confirm*', (req, res) => {
  console.log('[Camera STA HTTP] 📡 confirm interceptado!');
  res.json({ code: 200, message: "OK", data: null });
});

app.all('/app/api/ApiSysDevices/a9bindingAppDevice*', (req, res) => {
  console.log('[Camera STA HTTP] 📡 a9bindingAppDevice interceptado!');
  res.json({ code: 200, message: "OK", data: null });
});

app.all('/app/api/ApiSysDevices/getDevInfo*', (req, res) => {
  const uid = req.query.devicesCode || req.body?.devicesCode || "5c0006004882";
  const token = req.query.token || req.body?.token;
  if (token && staServer) {
    staServer.devToken = token;
    staServer.cliToken = token;
  }
  if (req.ip) {
    const rawIp = req.ip.replace(/^.*:/, '');
    if (rawIp.startsWith('192.168.15.')) {
      activeCamera.ip = rawIp;
      activeCamera.mode = 'sta';
      activeCamera.connected = true;
      if (staServer) staServer.cameraIp = rawIp;
    }
  }
  console.log(`[Camera STA HTTP] 📡 getDevInfo interceptado para UID=${uid}, token=${token}!`);
  res.json({
    code: 200,
    message: "操作成功",
    data: {
      userInfo_userId: "f76d3e3fd0ff19c98fc0941f5dd4f112",
      ota_url: null,
      ota_version: null,
      ntpTimer: Math.floor(Date.now() / 1000),
      userInfo_state: 1,
      timeZone: -3,
      cloudStorage: 0
    }
  });
});

app.all('/app/api/ApiSysDevices/getDeviceByCode*', (req, res) => {
  const uid = req.query.devicesCode || req.body?.devicesCode || "5c0006004882";
  console.log(`[Camera STA HTTP] 📡 getDeviceByCode interceptado para UID=${uid}!`);
  res.json({
    code: 200,
    message: "操作成功",
    data: {
      id: uid,
      devicesCode: uid,
      devicesState: "1",
      devicesIp: LOCAL_PC_IP,
      devicesType: "monitor2",
      devicesManageId: "1d40561cf968ed2f2e382d9c0af071c9",
      deleteFlag: 0,
      createTime: Date.now(),
      devicesName: "monitor2"
    }
  });
});

app.all(['/app/api/ApiServer/getA9ConfCheck*', '/app/api/ApiServer/getA9VideoConf*'], (req, res) => {
  const uid = req.query.devicesCode || req.body?.devicesCode || "5c0006004882";
  const token = staServer?.devToken || "26b363964f";
  console.log(`[Camera STA HTTP] 🎯 getA9ConfCheck/getA9VideoConf interceptado! UID=${uid}, Apontando para ${LOCAL_PC_IP}:6123`);
  res.json({
    code: 200,
    message: "操作成功",
    data: {
      tcpPort: 6123,
      managePort: 6123,
      uid: uid,
      target: uid,
      isBind: "1",
      domain: "v720.naxclow.com",
      updateUrl: null,
      host: LOCAL_PC_IP,
      currTime: `${Math.floor(Date.now() / 1000)}`,
      pwd: "310eed6d",
      tarPwd: "310eed6d",
      token: token,
      version: null
    }
  });
});

app.all('/app/api/*', (req, res) => {
  console.log(`[Camera STA HTTP Fallback] 📡 Rota genérica respondida: ${req.method} ${req.url}`);
  res.json({ code: 200, message: "OK", data: null });
});

// --- API ROUTES PARA O FRONTEND WEB ---

let autoReconnectEnabled = true;
let apReconnectTimer = null;
function scheduleApReconnect() {
  if (!autoReconnectEnabled || activeCamera.mode !== 'ap') return;
  if (apReconnectTimer) return;
  apReconnectTimer = setTimeout(() => {
    apReconnectTimer = null;
    if (autoReconnectEnabled && activeCamera.mode === 'ap' && (!activeLocalClient || !activeLocalClient.isConnected)) {
      console.log('[Local API Auto-Reconnect] Tentando reconexão com a câmera AP...');
      ensureLocalClientConnected('192.168.169.1', 6123).catch(err => {
        console.warn('[Local API Auto-Reconnect]', err.message);
      });
    }
  }, 2500);
}

let localConnectingPromise = null;

async function ensureLocalClientConnected(host = null, port = null) {
  const targetHost = host || activeCamera.ip || '192.168.169.1';
  const targetPort = parseInt(port || activeCamera.port || 6123, 10);

  // Se for IP fora do range AP (192.168.169.x), não tenta conexão TCP de entrada direta
  if (targetHost !== '192.168.169.1' && !targetHost.startsWith('192.168.169.')) {
    return null;
  }

  if (activeLocalClient && activeLocalClient.isConnected) {
    return activeLocalClient;
  }

  if (localConnectingPromise) {
    return localConnectingPromise;
  }

  localConnectingPromise = (async () => {
    if (activeLocalClient) {
      try { activeLocalClient.disconnect(); } catch (_) {}
      activeLocalClient = null;
    }

    console.log(`[Local API] Conectando cliente principal à câmera em ${targetHost}:${targetPort}...`);
    activeCamera.ip = targetHost;
    activeCamera.port = targetPort;
    activeCamera.mode = 'ap';

    const client = new LocalCameraClient(targetHost, targetPort, {
      onFrame: (dataUrl) => {
        activeCamera.connected = true;
        if (!client._frameCount) client._frameCount = 0;
        client._frameCount++;
        if (client._frameCount % 30 === 1) {
          console.log(`[Local API] 🎥 Frame #${client._frameCount} recebido da câmera AP! (${dataUrl.length} bytes)`);
        }
        const msg = JSON.stringify({ type: 'frame', data: dataUrl, timestamp: Date.now() });
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
      },
      onStatus: (status) => {
        console.log(`[LocalClient Status]`, status);
        if (status.status === 'closed') {
          activeCamera.connected = false;
          activeLocalClient = null;
          scheduleApReconnect();
        }
        const msg = JSON.stringify({ type: 'local_status', data: status, cameraState: activeCamera });
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
      },
      onError: (err) => {
        console.warn(`[LocalClient Error]`, err.message);
        activeCamera.connected = false;
        scheduleApReconnect();
        const msg = JSON.stringify({ type: 'local_error', error: err.message, cameraState: activeCamera });
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
      },
      onMotion: (event) => {
        console.log(`[Local API] 🚨 ALERTA DE MOVIMENTO DETECTADO!`, event);
        const msg = JSON.stringify({
          type: 'motion_alert',
          timestamp: Date.now(),
          data: event
        });
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
      }
    });

    try {
      await client.connect();
      activeLocalClient = client;
      activeCamera.connected = true;
      // Garante modo normal (sem infravermelho) e gravação obrigatória no MicroSD
      try {
        activeLocalClient.setIrLed(false);
        activeLocalClient.setMoveAlert(true, activeCamera.motionGrade || 3);
      } catch (_) {}
      console.log(`[Local API] ✓ Conectado com sucesso a ${targetHost}:${targetPort}`);
      return activeLocalClient;
    } catch (err) {
      activeCamera.connected = false;
      throw err;
    } finally {
      localConnectingPromise = null;
    }
  })();

  return localConnectingPromise;
}

// 1. Conexão Manual (Modo AP direto - 192.168.169.1:6123)
app.post('/api/local/connect', async (req, res) => {
  autoReconnectEnabled = true;
  const { host = '192.168.169.1', port = 6123 } = req.body;

  // Se o IP for o IP residencial da câmera (modo STA), aciona o fluxo STA (MQTT + UDP hole punch)
  if (host !== '192.168.169.1' && !host.startsWith('192.168.169.')) {
    console.log(`[Local API] IP ${host} é da rede Wi-Fi residencial (STA). Disparando ativação de NAT e streaming...`);
    activeCamera.ip = host;
    activeCamera.mode = 'sta';
    activeCamera.connected = true;
    if (staServer) {
      staServer.cameraIp = host;
      staServer.sendMqttNatRequest();
      staServer.sendUdpHolePunch(host);
      staServer.sendMqttCommand({ code: 3 });
    }
    return res.json({
      success: true,
      message: `Modo Wi-Fi Residencial (STA): Solicitado fluxo de vídeo da câmera em ${host}.`,
      host,
      port,
      mode: 'sta'
    });
  }

  try {
    await ensureLocalClientConnected(host, port);
    res.json({ success: true, message: `Conectado localmente a ${host}:${port}`, host, port });
  } catch (err) {
    activeCamera.connected = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Desconectar
app.post('/api/local/disconnect', (req, res) => {
  autoReconnectEnabled = false;
  if (apReconnectTimer) {
    clearTimeout(apReconnectTimer);
    apReconnectTimer = null;
  }
  if (activeLocalClient) {
    activeLocalClient.disconnect();
    activeLocalClient = null;
  }
  activeCamera.connected = false;
  res.json({ success: true, message: 'Desconectado da câmera local.' });
});

// 3. Controles da Câmera (IR LED, Flip, Reboot, Stream, Motion)
app.post('/api/command', (req, res) => {
  const { action, enabled, grade } = req.body;
  console.log(`[API Command] '${action}'`);

  if (action === 'ir_led') {
    activeCamera.irLed = !activeCamera.irLed;
    if (activeLocalClient) activeLocalClient.setIrLed(activeCamera.irLed);
    if (staServer) staServer.setIrLed(activeCamera.irLed);
  } else if (action === 'flip') {
    activeCamera.flip = !activeCamera.flip;
    if (activeLocalClient) activeLocalClient.setFlip(activeCamera.flip);
    if (staServer) staServer.setFlip(activeCamera.flip);
  } else if (action === 'reboot') {
    if (activeLocalClient) activeLocalClient.reboot();
    if (staServer) staServer.reboot();
  } else if (action === 'switch_ap') {
    if (staServer) staServer.switchToAp();
  } else if (action === 'start_stream') {
    if (activeLocalClient) activeLocalClient.startVideoStream();
  } else if (action === 'stop_stream') {
    if (activeLocalClient) activeLocalClient.stopVideoStream();
  } else if (action === 'motion_sensitivity') {
    const sensitivity = parseInt(grade, 10) || 3;
    activeCamera.motionGrade = sensitivity;
    console.log(`[API Command] Alterando sensibilidade de movimento para nível ${sensitivity}`);
    if (activeLocalClient) activeLocalClient.setMoveAlert(activeCamera.sdMoveMode !== false, sensitivity);
    if (staServer) staServer.setMoveAlert(activeCamera.sdMoveMode !== false, sensitivity);
  } else if (action === 'sync_time') {
    console.log('[API Command] Sincronização manual do relógio da câmera com o horário local do PC');
    if (activeLocalClient) {
      const timeInfo = activeLocalClient.syncTime();
      return res.json({
        success: true,
        action,
        timeInfo,
        cameraState: activeCamera
      });
    }
  } else if (action === 'motion_record_sd') {
    const isEnabled = enabled !== false;
    activeCamera.sdMoveMode = isEnabled;
    console.log(`[API Command] Gravação no SD por movimento: ${isEnabled ? 'HABILITADA' : 'DESABILITADA'}`);
    if (activeLocalClient) activeLocalClient.setMoveAlert(isEnabled, activeCamera.motionGrade || 3);
    if (staServer) staServer.setMoveAlert(isEnabled, activeCamera.motionGrade || 3);
  } else if (action === 'motion_alert') {
    const isEnabled = enabled !== false;
    activeCamera.sdMoveMode = isEnabled;
    if (grade) activeCamera.motionGrade = parseInt(grade, 10);
    if (activeLocalClient) activeLocalClient.setMoveAlert(isEnabled, activeCamera.motionGrade || 3);
    if (staServer) staServer.setMoveAlert(isEnabled, activeCamera.motionGrade || 3);
  }

  res.json({
    success: true,
    action,
    cameraState: activeCamera
  });
});

// 4. Status
app.get('/api/status', (req, res) => {
  res.json({
    activeCamera,
    isLocalClientActive: activeLocalClient ? activeLocalClient.isConnected : false,
    isStaActive: activeCamera.connected,
    frameCount: activeLocalClient?._frameCount || 0,
    rxLen: activeLocalClient?.rxBuffer?.length || 0,
    rxPreview: activeLocalClient?.rxBuffer ? activeLocalClient.rxBuffer.slice(0, 20).toString('hex') : null,
    rxCmd: activeLocalClient?.rxBuffer && activeLocalClient.rxBuffer.length >= 6 ? activeLocalClient.rxBuffer.readUInt16LE(4) : null,
    rxExpectedLen: activeLocalClient?.rxBuffer && activeLocalClient.rxBuffer.length >= 4 ? activeLocalClient.rxBuffer.readUInt32LE(0) : null
  });
});

// Helper para obter cliente ativo conectado
async function getOrInitClient() {
  if (activeCamera.mode === 'sta' || (activeCamera.ip && !activeCamera.ip.startsWith('192.168.169.'))) {
    return { client: null, isTemp: false };
  }
  const client = await ensureLocalClientConnected();
  return { client, isTemp: false };
}

// --- ROTAS DO CARTÃO MICROSD ---

// 1. Status do Cartão MicroSD (Code 218 / 410)
app.get('/api/sd/status', async (req, res) => {
  if (activeCamera.mode === 'sta') {
    activeCamera.connected = true;
    activeCamera.mode = 'sta';
    if (staServer?.cameraIp) activeCamera.ip = staServer.cameraIp;
    const info = staServer?.cameraInfo || {};
    return res.json({
      success: true,
      mounted: true,
      sdCapacity: info.sdCapacity !== undefined ? info.sdCapacity : 3,
      sdCardReco: info.sdCardReco !== undefined ? info.sdCardReco : 1,
      sdMoveMode: info.sdMoveMode !== undefined ? info.sdMoveMode : 1,
      moveGrade: info.moveGrade !== undefined ? info.moveGrade : 3,
      totalMb: 4000,
      freeMb: (info.sdCapacity || 3) * 1000,
      mode: 'sta',
      deviceCode: staServer?.devTarget || activeCamera.deviceCode || '5c0006004882',
      wifiName: info.wifiName || 'Mozzy Mozbourne'
    });
  }
  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    if (!clientWrapper.client) {
      return res.json({ success: true, mounted: true, totalMb: 4000, freeMb: 3500, mode: 'sta' });
    }
    const status = await clientWrapper.client.getSdCardStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    console.warn('[SD API Status Error]', err.message);
    res.json({ success: false, mounted: false, error: err.message });
  } finally {
    if (clientWrapper?.isTemp && clientWrapper.client) {
      clientWrapper.client.disconnect();
    }
  }
});

// 2. Lista de datas com gravações disponíveis (Code 400)
app.get('/api/sd/test_query', (req, res) => {
  const devId = activeCamera.deviceCode || '5c0006004882';
  if (staServer) {
    console.log('[SD TEST] Disparando comandos SD via MQTT...');
    staServer.sendMqttCommand({ code: 400, devTarget: devId });
    staServer.sendMqttCommand({ code: 218, devTarget: devId });
    staServer.sendMqttCommand({ code: 410, devTarget: devId });
    staServer.sendMqttCommand({ code: 36, devTarget: devId });
    staServer.sendMqttCommand({ code: 4, unixTimer: Math.floor(Date.now() / 1000) });
  }
  res.json({ success: true, message: 'Comandos SD enviados via MQTT' });
});

app.get('/api/sd/dates', async (req, res) => {
  if (activeCamera.mode === 'sta') {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}${mm}${dd}`;
    return res.json({ success: true, dates: [todayStr], mode: 'sta' });
  }
  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    if (!clientWrapper.client) return res.json({ success: true, dates: [], mode: 'sta' });
    const rawDates = await clientWrapper.client.getSdCardDates();
    const dates = Array.isArray(rawDates) ? [...rawDates].sort().reverse() : [];
    res.json({ success: true, dates });
  } catch (err) {
    console.warn('[SD API Dates Error]', err.message);
    res.status(500).json({ success: false, error: err.message, dates: [] });
  } finally {
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// 3. Catálogo de vídeos gravados em uma data específica (Code 402 + XML)
app.get('/api/sd/files', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ success: false, error: 'Parâmetro date obrigatório (ex: 20241016)' });

  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    if (!clientWrapper.client) {
      return res.json({ success: true, recordings: [], mode: 'sta' });
    }
    const result = await clientWrapper.client.getSdCardFiles(date);
    res.json({ success: true, ...result });
  } catch (err) {
    console.warn('[SD API Files Error]', err.message);
    res.status(500).json({ success: false, error: err.message, recordings: [] });
  } finally {
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// 4. Informações de um vídeo gravado específico (Code 404)
app.get('/api/sd/info', async (req, res) => {
  const { date, hour, minute } = req.query;
  if (!date || hour === undefined || minute === undefined) {
    return res.status(400).json({ success: false, error: 'Parâmetros date, hour e minute são obrigatórios' });
  }

  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    const info = await clientWrapper.client.getSdCardFileInfo(date, hour, minute);
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// 5. Download de arquivo de vídeo gravado (.avi) diretamente da câmera (Code 406)
app.get('/api/sd/download', async (req, res) => {
  const { date, hour, minute } = req.query;
  if (!date || hour === undefined || minute === undefined) {
    return res.status(400).json({ success: false, error: 'Parâmetros date, hour e minute são obrigatórios' });
  }

  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    console.log(`[SD API Download] Iniciando download do vídeo ${date} ${hour}:${minute}...`);

    const result = await clientWrapper.client.downloadSdCardFile(date, hour, minute);
    const savePath = path.join(getRecordingsDir(), result.fileName);
    fs.writeFileSync(savePath, result.data);
    console.log(`[SD API Download] Salvo com sucesso em: ${savePath} (${result.size} bytes)`);

    res.setHeader('Content-Type', 'video/x-msvideo');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('Content-Length', result.size);
    res.send(result.data);
  } catch (err) {
    console.error('[SD API Download Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// --- ROTAS DE SINCRONIZAÇÃO EM SEGUNDO PLANO (BACKGROUND SYNC) ---
app.get('/api/sync/status', (req, res) => {
  res.json({ success: true, ...syncState });
});

app.post('/api/sync/trigger', async (req, res) => {
  const result = await triggerManualSync();
  res.json({ success: true, ...result });
});

app.post('/api/sync/config', (req, res) => {
  const { enabled, deleteAfterDownload, autoFormatAfterSync } = req.body;
  if (enabled !== undefined) setSyncEnabled(enabled);
  if (deleteAfterDownload !== undefined) setDeleteAfterDownload(deleteAfterDownload);
  if (autoFormatAfterSync !== undefined) setAutoFormatAfterSync(autoFormatAfterSync);
  res.json({ success: true, ...syncState });
});

// 5.5 Sincronização inteligente: Baixa vídeos novos para o PC e remove do cartão após certificar
app.post('/api/sd/sync', async (req, res) => {
  if (activeCamera.mode === 'sta') {
    console.log('[SD STA Sync] Sincronização disparada para o cartão MicroSD da câmera STA...');
    if (staServer) {
      staServer.queryInfo();
      staServer.setMoveAlert(true, activeCamera.motionGrade || 3);
    }
    const files = getLocalSavedRecordings();
    const info = staServer?.cameraInfo || {};
    return res.json({ 
      success: true, 
      syncedCount: files.length, 
      deletedCount: 0, 
      sdCapacity: info.sdCapacity,
      sdCardReco: info.sdCardReco,
      sdMoveMode: info.sdMoveMode,
      moveGrade: info.moveGrade,
      message: `Modo Wi-Fi Local (STA) ativo: A câmera está gravando no cartão MicroSD por detecção de movimento (Sensibilidade Máxima Nível ${info.moveGrade || 3}). ${files.length} vídeos sincronizados no PC.`, 
      files 
    });
  }
  let clientWrapper = null;
  let wasStreaming = false;
  try {
    clientWrapper = await getOrInitClient();

    if (!clientWrapper.client) {
      const files = getLocalSavedRecordings();
      return res.json({ 
        success: true, 
        syncedCount: 0, 
        deletedCount: 0, 
        message: 'Modo Wi-Fi Local (STA) ativo: gravação é realizada diretamente no cartão MicroSD da câmera.', 
        files 
      });
    }

    // Pausa a transmissão ao vivo temporariamente para ter 100% da banda no catálogo e downloads
    wasStreaming = clientWrapper.client.isStreaming;
    if (wasStreaming) {
      clientWrapper.client.stopVideoStream();
      await new Promise(r => setTimeout(r, 200));
    }

    const dates = await clientWrapper.client.getSdCardDates();
    if (!dates || dates.length === 0) {
      const files = getLocalSavedRecordings();
      return res.json({ success: true, syncedCount: 0, deletedCount: 0, message: 'Nenhuma gravação encontrada no cartão.', files });
    }

    // Datas ordenadas da mais recente para a mais antiga (hoje no topo)
    const sortedDates = [...dates].sort().reverse();

    const synced = [];
    const deleted = [];
    const errors = [];
    const MAX_FILES_PER_SYNC = 25;

    for (const date of sortedDates) {
      if (synced.length >= MAX_FILES_PER_SYNC) break;

      try {
        const cat = await clientWrapper.client.getSdCardFiles(date);
        // Ordena gravações da mais recente para a mais antiga
        const cameraRecordings = [...(cat.recordings || [])].sort((a, b) => (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute));

        for (const rec of cameraRecordings) {
          if (synced.length >= MAX_FILES_PER_SYNC) break;

          const fileName = rec.fileName || `${rec.date}${String(rec.hour).padStart(2,'0')}${String(rec.minute).padStart(2,'0')}.avi`;
          const currentTargetDir = getRecordingsDir();
          const savePath = path.join(currentTargetDir, fileName);

          // 1. Se já está no PC com tamanho válido (> 64 KB), apenas apaga da câmera se ainda estiver no cartão
          if (fs.existsSync(savePath) && fs.statSync(savePath).size > 64 * 1024) {
            console.log(`[SD Sync] Arquivo ${fileName} já existe no PC com integridade. Apagando da câmera para liberar espaço...`);
            try {
              await clientWrapper.client.deleteSdCardFile(rec.date, rec.hour, rec.minute);
              deleted.push(fileName);
            } catch (delErr) {
              console.warn(`[SD Sync Delete Error] ${fileName}:`, delErr.message);
            }
            continue;
          }

          // 2. Se não está no PC, faz o download
          console.log(`[SD Sync] Baixando novo vídeo da câmera: ${fileName}...`);
          try {
            const fileRes = await clientWrapper.client.downloadSdCardFile(rec.date, rec.hour, rec.minute);
            if (fileRes && fileRes.data && fileRes.data.length > 64 * 1024) {
              fs.writeFileSync(savePath, fileRes.data);
              synced.push(fileName);
              console.log(`[SD Sync] Salvo no PC com sucesso: ${fileName} (${fileRes.size} bytes)`);

              // 3. Certifica que foi salvo no disco antes de deletar da câmera
              if (fs.existsSync(savePath) && fs.statSync(savePath).size >= fileRes.data.length) {
                console.log(`[SD Sync] Verificado no PC. Removendo do cartão da câmera: ${fileName}...`);
                try {
                  await clientWrapper.client.deleteSdCardFile(rec.date, rec.hour, rec.minute);
                  deleted.push(fileName);
                  console.log(`[SD Sync] Removido com sucesso do cartão: ${fileName}`);
                } catch (delErr) {
                  console.warn(`[SD Sync Delete Warning] Não foi possível apagar ${fileName} da câmera:`, delErr.message);
                }
              }
            } else {
              throw new Error('Arquivo recebido com tamanho inválido ou vazio.');
            }
          } catch (fileErr) {
            console.error(`[SD Sync File Error] Falha ao sincronizar ${fileName}:`, fileErr.message);
            errors.push({ file: fileName, error: fileErr.message });
          }
        }
      } catch (catErr) {
        console.warn(`[SD Sync Cat Error] Falha ao processar catálogo de ${date}:`, catErr.message);
      }
    }

    const updatedLocalFiles = getLocalSavedRecordings();
    res.json({
      success: true,
      syncedCount: synced.length,
      deletedCount: deleted.length,
      synced,
      deleted,
      errors,
      files: updatedLocalFiles
    });
  } catch (err) {
    console.error('[SD Sync Error]', err.message);
    res.status(500).json({ success: false, error: err.message, files: getLocalSavedRecordings() });
  } finally {
    if (wasStreaming && clientWrapper?.client && clientWrapper.client.isConnected) {
      await new Promise(r => setTimeout(r, 150));
      clientWrapper.client.startVideoStream();
    }
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// Rotas de configuração de diretório de gravações locais
app.get('/api/config/recordings-dir', (req, res) => {
  res.json({ success: true, recordingsDir: getRecordingsDir() });
});

app.post('/api/config/recordings-dir', (req, res) => {
  const newPath = req.body?.recordingsDir || req.body?.path;
  try {
    const updatedDir = setRecordingsDir(newPath);
    res.json({ success: true, recordingsDir: updatedDir });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Excluir vídeo local individual do PC (mantém histórico persistente para não re-baixar do SD)
app.delete('/api/sd/local/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(getRecordingsDir(), filename);
  markAsSynced(filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Vídeo ${filename} excluído do PC.` });
  } else {
    res.status(404).json({ success: false, error: 'Arquivo não encontrado no PC.' });
  }
});

// Excluir lote de vídeos locais do PC (mantém histórico persistente)
app.post('/api/sd/local-batch-delete', (req, res) => {
  const { filenames = [] } = req.body;
  let deletedCount = 0;
  const currentDir = getRecordingsDir();
  for (const fn of filenames) {
    const filename = path.basename(fn);
    const filePath = path.join(currentDir, filename);
    markAsSynced(filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch (e) {}
    }
  }
  res.json({ success: true, deletedCount });
});

// Resetar histórico de sincronização caso o usuário queira forçar novo download de tudo
app.post('/api/sync/history/reset', (req, res) => {
  clearSyncedHistory();
  res.json({ success: true, message: 'Histórico de sincronização foi resetado.' });
});

// 6. Lista de gravações já baixadas e salvas localmente no PC
app.get('/api/sd/local-recordings', (req, res) => {
  try {
    const files = getLocalSavedRecordings();
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Streaming / reprodução de arquivo local baixado
app.get('/api/sd/play/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(getRecordingsDir(), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/x-msvideo',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/x-msvideo',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// 7.1 Extração de quadros JPEG para reprodução no player web (suporte universal sem codecs)
app.get('/api/sd/frames/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(getRecordingsDir(), filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
  }

  try {
    const buf = fs.readFileSync(filePath);

    // Suporte a fotos estáticas .jpg / .jpeg
    if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) {
      const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
      return res.json({
        success: true,
        filename,
        count: 1,
        fps: 1,
        frames: [dataUrl]
      });
    }

    const frames = [];
    let pos = 0;
    while (pos < buf.length) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]), pos);
      if (start === -1) break;
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) break;
      frames.push('data:image/jpeg;base64,' + buf.slice(start, end + 2).toString('base64'));
      pos = end + 2;
    }

    res.json({
      success: true,
      filename,
      count: frames.length,
      fps: 15,
      frames
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- DVR LOCAL DO PC (GRAVAÇÃO DIRETA NO COMPUTADOR) ---

// Salva clipe .avi gerado no PC
app.post('/api/dvr/save-video', express.json({ limit: '100mb' }), (req, res) => {
  try {
    const { filename, frames, fps = 15 } = req.body;
    if (!frames || frames.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum quadro para salvar' });
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = `DVR_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.avi`;
    const fname = filename || defaultName;

    const jpegBuffers = frames.map(f => {
      const base64Data = f.replace(/^data:image\/\w+;base64,/, '');
      return Buffer.from(base64Data, 'base64');
    });

    const aviBuf = createMjpegAvi(jpegBuffers, 640, 480, fps);
    const savePath = path.join(getRecordingsDir(), fname);
    fs.writeFileSync(savePath, aviBuf);
    console.log(`[DVR Local] 🎥 Vídeo salvo com sucesso no PC: ${fname} (${(aviBuf.length / (1024 * 1024)).toFixed(2)} MB, ${frames.length} quadros)`);

    res.json({
      success: true,
      filename: fname,
      framesCount: frames.length,
      size: aviBuf.length,
      files: getLocalSavedRecordings()
    });
  } catch (err) {
    console.error('[DVR Save Video Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Salva foto .jpg gerada no PC
app.post('/api/dvr/save-photo', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!data) {
      return res.status(400).json({ success: false, error: 'Nenhum dado de imagem enviado' });
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = `FOTO_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`;
    const fname = filename || defaultName;

    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    const imgBuf = Buffer.from(base64Data, 'base64');
    const savePath = path.join(getRecordingsDir(), fname);
    fs.writeFileSync(savePath, imgBuf);
    console.log(`[DVR Local] 📸 Foto salva com sucesso no PC: ${fname} (${(imgBuf.length / 1024).toFixed(1)} KB)`);

    res.json({
      success: true,
      filename: fname,
      size: imgBuf.length,
      files: getLocalSavedRecordings()
    });
  } catch (err) {
    console.error('[DVR Save Photo Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Formatação do Cartão MicroSD (Code 207)
app.post('/api/sd/format', async (req, res) => {
  let clientWrapper = null;
  try {
    clientWrapper = await getOrInitClient();
    if (!clientWrapper.client) {
      if (activeCamera.deviceCode) {
        publishMqttCommand(activeCamera.deviceCode, { code: 207 });
        return res.json({ success: true, message: 'Comando de formatação enviado à câmera via STA MQTT (Code 207)' });
      }
      return res.json({ success: true, message: 'Formatação solicitada' });
    }
    const result = await clientWrapper.client.formatSdCard();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (clientWrapper?.isTemp) {
      clientWrapper.client.disconnect();
    }
  }
});

// --- WEBSOCKET LIVE STREAMING BRIDGE & WEBRTC ICE SIGNALING ---
wss.on('connection', (ws, req) => {
  const url = req?.url || '';

  // 1. Rota de Sinalização WebRTC ICE (icev720.naxclow.com/v720/rtc/ice/*)
  if (url.startsWith('/v720/rtc/ice/')) {
    iceSignaling.handleConnection(ws, req);
    return;
  }

  // 2. Rota de controle e streaming do painel do navegador
  console.log('[WebSocket] Navegador conectado para streaming local');

  ws.send(JSON.stringify({
    type: 'status',
    data: activeCamera
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[WebSocket] Navegador desconectado');
  });
});

// As requisições HTTP da porta 80 (*.naxclow.com) são gerenciadas pelo Apache (XAMPP) e redirecionadas para a porta 3000

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` V720 PC STUDIO (Modo AP Direto + STA Wi-Fi • Sem Nuvem)`);
  console.log(` Painel Web: http://localhost:${PORT}`);
  console.log(` STA Server ativo em TCP/UDP porta 6123`);
  console.log(` DNS Interceptor ativo em UDP porta 53`);
  console.log(`=======================================================`);

  if (activeCamera.mode === 'ap') {
    console.log('[Startup] Inicializando conexão no Modo AP Direto (192.168.169.1:6123)...');
    ensureLocalClientConnected('192.168.169.1', 6123).catch(err => {
      console.warn('[Startup] Conexão AP inicial:', err.message);
    });
  }

  // Inicializa o sincronizador em segundo plano para o cartão SD
  initBackgroundSync(getOrInitClient, (msg) => {
    const jsonStr = JSON.stringify(msg);
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(jsonStr);
    });
  });
});
