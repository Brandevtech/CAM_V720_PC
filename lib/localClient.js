/**
 * Local Direct TCP Client for V720 / A9 Naxclow Camera
 * Reverse engineered from a9-v720 and Naxclow firmware protocol.
 * Connects directly to the camera (e.g. 192.168.169.1:6123 in AP mode)
 * without requiring any cloud server, authentication, or internet connection.
 * Includes complete MicroSD card management & video playback/download.
 */
import net from 'net';
import { EventEmitter } from 'events';
import { parseCatalogueXml } from './sdCardService.js';

export const LOCAL_CONSTANTS = {
  P2P_UDP_CMD_JSON: 0,
  P2P_UDP_CMD_JPEG: 1,
  P2P_UDP_CMD_RGB: 2,
  P2P_UDP_CMD_AAC: 3,
  P2P_UDP_CMD_G711: 4,
  P2P_UDP_CMD_RAW: 5,
  P2P_UDP_CMD_PCM: 6,
  P2P_UDP_CMD_AVI: 7,
  P2P_UDP_CMD_XML: 8,
  P2P_UDP_CMD_HEARTBEAT: 100,
  P2P_UDP_CMD_PING: 101,
  P2P_UDP_CMD_PONG: 102,
  P2P_UDP_CMD_DIRECT_MOTION: 114,
  P2P_UDP_CMD_LIVE_MOTION: 115,

  CODE_AP_CONNECT: 501,
  CODE_AP_COMMAND: 502,
  CODE_FORWARD_DEV_BASE_INFO: 4,
  CODE_FORWARD_OPEN_A_OPEN_V: 3,
  CODE_FORWARD_CLOSE_A_OPEN_V: 2,
  CODE_FORWARD_CLOSE_A_CLOSE_V: 0,
  CODE_FORWARD_DEV_MOVE_ALERT: 205,
  CODE_FORWARD_DEV_MOVE_GRADE: 206,
  CODE_FORWARD_DEV_MOVE_MODE: 203,
  CODE_FORWARD_DEV_IR_LED: 202,
  CODE_FORWARD_DEV_VIDEO_FLIP: 216,
  CODE_FORWARD_DEV_REBOOT: 299,

  // MicroSD Card Protocol Commands
  CODE_FORWARD_DEV_SDCARD_RECORD: 209,
  CODE_FORWARD_DEV_SDCARD_STATUS: 218,
  CODE_FORWARD_DEV_SDCARD_FORMAT: 207,
  CODE_SDCARD_REQ_DATE_LIST: 400,
  CODE_SDCARD_RSP_DATE_LIST: 401,
  CODE_SDCARD_REQ_CONFIG: 402,
  CODE_SDCARD_RSP_CONFIG: 403,
  CODE_SDCARD_REQ_MEDIA_INFO: 404,
  CODE_SDCARD_RSP_MEDIA_INFO: 405,
  CODE_SDCARD_REQ_START_STREAM: 406,
  CODE_SDCARD_RSP_START_STREAM: 407,
  CODE_SDCARD_REQ_STOP_STREAM: 408,
  CODE_SDCARD_RSP_STOP_STREAM: 409,
  CODE_SDCARD_REQ_STATUS: 410,
  CODE_SDCARD_RSP_MEDIA_STREAM_END: 411,
  CODE_SDCARD_REQ_MEDIA_DELETE: 412,
  CODE_SDCARD_RSP_MEDIA_DELETE: 413,

  DEFAULT_FORWARD_ID: '00000000',
  DEFAULT_DEV_TARGET: 'deadbeef',
  DEFAULT_DEVICE_TOKEN: 'This is TEST token'
};

export class LocalCameraClient extends EventEmitter {
  constructor(host = '192.168.169.1', port = 6123, options = {}) {
    super();
    this.host = host;
    this.port = port;
    this.options = options;

    this.socket = null;
    this.isConnected = false;
    this.isStreaming = false;
    this.isDownloading = false;
    this.heartbeatTimer = null;

    this.rxBuffer = Buffer.alloc(0);
    this.jpegBuffer = [];
    this.isJpegSync = false;

    this.onFrame = options.onFrame || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onError = options.onError || (() => {});
    this.onMotion = options.onMotion || (() => {});
  }

  createPacket(cmd, payload = Buffer.alloc(0), msgFlag = 0, dealFlag = 0, forwardId = LOCAL_CONSTANTS.DEFAULT_FORWARD_ID, pkgId = 0) {
    const pBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const buf = Buffer.alloc(20 + pBuf.length);

    buf.writeUInt32LE(pBuf.length, 0);
    buf.writeUInt16LE(cmd, 4);
    buf.writeUInt8(msgFlag, 6);
    buf.writeUInt8(dealFlag, 7);
    buf.write(forwardId.padEnd(8, '\0').substring(0, 8), 8, 8, 'ascii');
    buf.writeUInt32LE(pkgId, 16);

    if (pBuf.length > 0) {
      pBuf.copy(buf, 20);
    }
    return buf;
  }

  createJsonPacket(jsonObj) {
    const jsonStr = JSON.stringify(jsonObj);
    return this.createPacket(LOCAL_CONSTANTS.P2P_UDP_CMD_JSON, Buffer.from(jsonStr, 'ascii'));
  }

  createApCommand(contentObj) {
    return this.createJsonPacket({
      code: LOCAL_CONSTANTS.CODE_AP_COMMAND,
      content: contentObj
    });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.onStatus({ status: 'connecting', message: `Conectando via TCP a ${this.host}:${this.port}...` });

      this.socket = new net.Socket();
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true, 1000);
      this.socket.setTimeout(15000);

      this.socket.on('connect', async () => {
        console.log(`[LocalClient] Conectado a ${this.host}:${this.port}`);
        this.isConnected = true;
        this.onStatus({ status: 'connected', message: `Conectado ao socket local ${this.host}:${this.port}` });

        try {
          await this.performHandshake();
          this.startHeartbeat();
          resolve(true);
        } catch (err) {
          this.onError(err);
          reject(err);
        }
      });

      this.socket.on('data', (chunk) => {
        this.handleIncomingData(chunk);
      });

      this.socket.on('timeout', () => {
        console.warn('[LocalClient] Socket timeout');
        this.onStatus({ status: 'timeout', message: 'Tempo limite esgotado no socket local.' });
      });

      this.socket.on('error', (err) => {
        console.error('[LocalClient] Erro no socket:', err.message);
        this.onError(err);
        if (!this.isConnected) reject(err);
      });

      this.socket.on('close', () => {
        console.log('[LocalClient] Conexão fechada.');
        this.cleanup();
        this.onStatus({ status: 'closed', message: 'Conexão local finalizada.' });
      });

      this.socket.connect(this.port, this.host);
    });
  }

  /**
   * Retorna o timestamp em segundos ajustado para o fuso horário local (ex: UTC-3 Brasília).
   * O firmware da câmera não possui suporte a fusos e usa gmtime() diretamente no unixTimer recebido.
   * Portanto, somamos o offset de fuso (idêntico ao app original V720 Naxclow).
   */
  getLocalUnixTime() {
    const now = new Date();
    // getTimezoneOffset() retorna minutos de diferença UTC - local (ex: +180 para Brasília)
    const offsetSeconds = -now.getTimezoneOffset() * 60;
    return Math.floor(now.getTime() / 1000) + offsetSeconds;
  }

  /**
   * Sincroniza o relógio interno da câmera com o horário local do PC.
   */
  syncTime() {
    const localUnix = this.getLocalUnixTime();
    const formatted = new Date().toLocaleString('pt-BR');
    console.log(`[LocalClient] 🕒 Sincronizando relógio interno da câmera: ${formatted} (unixTimer: ${localUnix})`);
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_BASE_INFO,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      unixTimer: localUnix
    }));
    return { success: true, localUnix, localTime: formatted };
  }

  async performHandshake() {
    // 1. Send P2P_UDP_CMD_LIVE_MOTION (cmd 115)
    console.log('[LocalClient] Enviando handshake LIVE_MOTION (cmd 115)...');
    this.sendPacket(this.createPacket(LOCAL_CONSTANTS.P2P_UDP_CMD_LIVE_MOTION));
    await new Promise(r => setTimeout(r, 150));

    // 2. Send CODE_AP_CONNECT (cmd 501) com timestamp local ajustado para fuso horário
    const localUnix = this.getLocalUnixTime();
    console.log(`[LocalClient] Enviando AP_CONNECT (cmd 501) com relógio sincronizado (${new Date().toLocaleString('pt-BR')}, unixTimer: ${localUnix})...`);
    const connectPayload = {
      code: LOCAL_CONSTANTS.CODE_AP_CONNECT,
      target: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      token: LOCAL_CONSTANTS.DEFAULT_DEVICE_TOKEN,
      unixTimer: localUnix
    };
    this.sendPacket(this.createJsonPacket(connectPayload));
    await new Promise(r => setTimeout(r, 150));

    // 3. Send CODE_FORWARD_DEV_BASE_INFO (code 4) para calibrar o relógio interno do firmware
    console.log('[LocalClient] Solicitando informações da câmera e calibrando relógio (BASE_INFO)...');
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_BASE_INFO,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      unixTimer: localUnix
    }));
    await new Promise(r => setTimeout(r, 200));

    // 4. Request Live Stream: CODE_FORWARD_CLOSE_A_OPEN_V (code 2 - vídeo dedicado e estável sem inundações de áudio)
    this.startVideoStream(LOCAL_CONSTANTS.CODE_FORWARD_CLOSE_A_OPEN_V);
  }

  startVideoStream(code = LOCAL_CONSTANTS.CODE_FORWARD_CLOSE_A_OPEN_V) {
    console.log(`[LocalClient] Solicitando transmissão de vídeo (OPEN_V modo ${code})...`);
    const openStreamPayload = {
      code,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
    };
    this.sendPacket(this.createApCommand(openStreamPayload));
    this.isStreaming = true;
    this.onStatus({ status: 'streaming', message: 'Transmissão local direta ativa! Recebendo MJPEG...' });
  }

  stopVideoStream() {
    console.log('[LocalClient] Pausando transmissão de vídeo (CLOSE_V)...');
    const closeStreamPayload = {
      code: LOCAL_CONSTANTS.CODE_FORWARD_CLOSE_A_CLOSE_V,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
    };
    this.sendPacket(this.createApCommand(closeStreamPayload));
    this.isStreaming = false;
    this.onStatus({ status: 'standby', message: 'Transmissão pausada.' });
  }

  setMoveAlert(enabled = true, grade = 3) {
    console.log(`[LocalClient] 🎯 Configurando alerta de movimento: ${enabled ? 'ATIVO' : 'DESLIGADO'}, sensibilidade: ${grade}`);
    // Código 209: Ativação mestre da gravação no cartão MicroSD
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_SDCARD_RECORD,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      sdCardReco: enabled ? 1 : 0
    }));
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_MOVE_ALERT,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      moveAlert: enabled ? 1 : 0
    }));
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_MOVE_GRADE,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      moveGrade: grade
    }));
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_MOVE_MODE,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      sdMoveMode: enabled ? 1 : 0
    }));
  }

  sendPacket(buf) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(buf);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (this.isConnected && this.socket && !this.socket.destroyed) {
        if (!this._lastHbSent || now - this._lastHbSent > 3500) {
          this._lastHbSent = now;
          this.sendPacket(this.createPacket(LOCAL_CONSTANTS.P2P_UDP_CMD_HEARTBEAT));
        }
      }
    }, 4000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  handleIncomingData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length >= 20) {
      const payloadLen = this.rxBuffer.readUInt32LE(0);
      const cmd = this.rxBuffer.readUInt16LE(4);

      // Proteção de sincronia: pacotes V720 nunca excedem 64KB
      if (payloadLen > 65536) {
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }

      const totalPacketLen = 20 + payloadLen;
      if (this.rxBuffer.length < totalPacketLen) {
        // Aguarda restante dos dados do pacote
        break;
      }

      const payload = this.rxBuffer.slice(20, totalPacketLen);
      this.rxBuffer = this.rxBuffer.slice(totalPacketLen);

      this.processPacket(cmd, payload);
    }
  }

  processPacket(cmd, payload) {
    if (cmd !== 1 && cmd !== 4) {
      console.log(`[LocalClient Packet] cmd=${cmd} len=${payload.length}`);
    } else if (cmd === 1) {
      if (!this._pkt1Count) this._pkt1Count = 0;
      this._pkt1Count++;
      if (this._pkt1Count % 10 === 1) console.log(`[LocalClient Packet] JPEG pkt #${this._pkt1Count} len=${payload.length}`);
    }
    if (this.isDownloading && (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_AVI || cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_RAW)) {
      this.emit('file_chunk', payload);
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_JPEG) {
      if (!this.isDownloading) {
        this.processJpegChunk(payload);
      }
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_AVI || cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_RAW) {
      this.emit('file_chunk', payload);
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_XML) {
      const xmlStr = payload.toString('ascii');
      console.log(`[LocalClient] 📜 Catálogo XML recebido (${xmlStr.length} bytes)`);
      this.emit('xml_response', xmlStr);
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_PING) {
      // Responde imediatamente ao PING da câmera com PONG
      this.sendPacket(this.createPacket(LOCAL_CONSTANTS.P2P_UDP_CMD_PONG));
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_HEARTBEAT) {
      // Responde ao heartbeat da câmera para manter o watchdog do firmware ativo
      const now = Date.now();
      if (!this._lastHbSent || now - this._lastHbSent > 2000) {
        this._lastHbSent = now;
        this.sendPacket(this.createPacket(LOCAL_CONSTANTS.P2P_UDP_CMD_HEARTBEAT));
      }
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_DIRECT_MOTION) {
      console.log(`[LocalClient] 🚨 Pacote DIRECT_MOTION (cmd 114) recebido da câmera!`);
      this.onMotion({ cmd, timestamp: Date.now(), source: 'direct_motion' });
    } else if (cmd === LOCAL_CONSTANTS.P2P_UDP_CMD_JSON) {
      try {
        const json = JSON.parse(payload.toString('ascii'));
        console.log('[LocalClient] JSON da câmera:', json);
        this.emit('json_response', json);
        if (json.code === 205 || json.moveAlert === 1 || json.alert || json.motion || json.code === 114 || json.content?.moveAlert === 1) {
          console.log('[LocalClient] 🚨 Alerta de movimento detectado nos dados da câmera!');
          this.onMotion({ cmd, payload: json, timestamp: Date.now(), source: 'camera_alert' });
        }
      } catch (e) {}
    }
  }

  processJpegChunk(data) {
    if (!this.isJpegSync) {
      const soi = data.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi !== -1) {
        const eoi = data.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
        if (eoi !== -1) {
          const fullJpeg = data.slice(soi, eoi + 2);
          this.jpegBuffer = [];
          this.isJpegSync = false;
          const dataUrl = 'data:image/jpeg;base64,' + fullJpeg.toString('base64');
          this.onFrame(dataUrl);

          // Verifica se há início de outro quadro nos dados restantes
          if (data.length > eoi + 2) {
            this.processJpegChunk(data.slice(eoi + 2));
          }
        } else {
          this.jpegBuffer = [data.slice(soi)];
          this.isJpegSync = true;
        }
      }
    } else {
      const eoi = data.indexOf(Buffer.from([0xff, 0xd9]));
      if (eoi !== -1) {
        this.jpegBuffer.push(data.slice(0, eoi + 2));
        const fullJpeg = Buffer.concat(this.jpegBuffer);
        this.jpegBuffer = [];
        this.isJpegSync = false;
        const dataUrl = 'data:image/jpeg;base64,' + fullJpeg.toString('base64');
        this.onFrame(dataUrl);

        // Verifica se há início de outro quadro nos dados restantes
        if (data.length > eoi + 2) {
          this.processJpegChunk(data.slice(eoi + 2));
        }
      } else {
        this.jpegBuffer.push(data);
        const currentSize = this.jpegBuffer.reduce((sum, b) => sum + b.length, 0);
        if (currentSize > 200000) {
          // Descarte por estouro de buffer (perda de fim de quadro)
          this.jpegBuffer = [];
          this.isJpegSync = false;
        }
      }
    }
  }

  // --- REQUEST-RESPONSE HELPERS ---
  async executeCommand(fn) {
    if (!this.commandQueue) this.commandQueue = Promise.resolve();
    let release;
    const next = new Promise(r => { release = r; });
    const currentQueue = this.commandQueue;
    this.commandQueue = currentQueue.then(() => next, () => next);
    try {
      // Nunca deixe uma rejeição anterior impedir a execução do próximo comando
      await currentQueue.catch(() => {});
      return await fn();
    } finally {
      release();
    }
  }

  async sendJsonCommand(jsonObj, predicate = null, timeoutMs = 8000) {
    return this.executeCommand(() => new Promise((resolve, reject) => {
      if (!this.isConnected || !this.socket) {
        return reject(new Error('Câmera não conectada'));
      }
      const timer = setTimeout(() => {
        this.off('json_response', handler);
        reject(new Error('Tempo limite esgotado aguardando resposta'));
      }, timeoutMs);

      const handler = (json) => {
        if (predicate && typeof predicate === 'function') {
          if (!predicate(json)) {
            // Ignora pacotes de outros comandos ou eventos espontâneos de movimento
            return;
          }
        }
        clearTimeout(timer);
        this.off('json_response', handler);
        resolve(json);
      };

      this.on('json_response', handler);
      this.sendPacket(this.createJsonPacket(jsonObj));
    }));
  }

  async sendApJsonCommand(contentObj, predicate = null, timeoutMs = 6000) {
    return this.sendJsonCommand({
      code: LOCAL_CONSTANTS.CODE_AP_COMMAND,
      content: contentObj
    }, predicate, timeoutMs);
  }

  // --- MICROSD CARD FEATURES ---

  /**
   * Verifica se o cartão MicroSD está inserido e ativo
   */
  async getSdCardStatus() {
    try {
      const res = await this.sendApJsonCommand({
        code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_SDCARD_STATUS,
        devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
      }, (json) => {
        return json.content?.sdDevStatus !== undefined || json.sdDevStatus !== undefined || json.code === LOCAL_CONSTANTS.CODE_AP_COMMAND;
      }, 5000);
      const statusVal = res?.content?.sdDevStatus ?? res?.sdDevStatus ?? (res?.status === 200 ? 1 : 0);
      return {
        mounted: statusVal > 0,
        status: statusVal,
        raw: res
      };
    } catch (e) {
      console.warn('[SD Status Error]', e.message);
      return { mounted: false, error: e.message };
    }
  }

  /**
   * Obtém a lista de datas com gravações no cartão SD (Code 400)
   */
  async getSdCardDates() {
    const res = await this.sendJsonCommand({
      code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_DATE_LIST,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
    }, (json) => {
      return Array.isArray(json.dates) || json.code === LOCAL_CONSTANTS.CODE_SDCARD_RSP_DATE_LIST || (json.status !== undefined && json.status !== 200);
    }, 8000);
    return res.dates || [];
  }

  /**
   * Obtém o catálogo de vídeos gravados para uma data (Code 402 + XML)
   */
  async getSdCardFiles(dateStr) {
    const dateNum = parseInt(dateStr, 10);
    return this.executeCommand(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('xml_response', xmlHandler);
        reject(new Error(`Tempo limite esgotado aguardando catálogo de gravações de ${dateStr}`));
      }, 10000);

      const xmlHandler = (xmlStr) => {
        clearTimeout(timer);
        const parsed = parseCatalogueXml(xmlStr);
        resolve(parsed);
      };

      this.once('xml_response', xmlHandler);

      this.sendPacket(this.createJsonPacket({
        code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_CONFIG,
        devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
        date: dateNum
      }));
    }));
  }

  /**
   * Obtém metadados de um arquivo específico (tamanho em bytes, Code 404)
   */
  async getSdCardFileInfo(date, hours, minute) {
    const res = await this.sendJsonCommand({
      code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_MEDIA_INFO,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      date: parseInt(date, 10),
      hours: parseInt(hours, 10),
      minute: parseInt(minute, 10)
    }, 6000);
    return res;
  }

  /**
   * Baixa o arquivo .avi completo da câmera (Code 406)
   */
  async downloadSdCardFile(date, hours, minute, onProgress = null, autoResumeStream = true) {
    const wasStreaming = this.isStreaming;
    if (wasStreaming) {
      this.stopVideoStream();
      // Aguarda 1200ms para garantir drenagem completa de quadros MJPEG em trânsito
      await new Promise(r => setTimeout(r, 1200));
    } else {
      await new Promise(r => setTimeout(r, 400));
    }
    // Descarta qualquer resíduo anterior no buffer TCP
    this.rxBuffer = Buffer.alloc(0);

    try {
      this.isDownloading = true;
      const fileName = `${date}${String(hours).padStart(2,'0')}${String(minute).padStart(2,'0')}.avi`;

      const chunks = [];
      let totalBytes = 0;

      const fileData = await new Promise((resolve, reject) => {
        let chunkTimer = null;

        const cleanup = () => {
          if (chunkTimer) clearTimeout(chunkTimer);
          this.off('file_chunk', chunkHandler);
          this.off('json_response', endJsonHandler);
        };

        const assembleAndResolve = () => {
          cleanup();
          let fullData = Buffer.concat(chunks);
          const riffIdx = fullData.indexOf('RIFF');
          if (riffIdx > 0) {
            console.log(`[LocalClient Download] Descartando ${riffIdx} bytes residuais anteriores ao cabeçalho RIFF`);
            fullData = fullData.slice(riffIdx);
          }
          console.log(`[LocalClient Download] Concluído (${fullData.length} bytes AVI recebidos)`);
          resolve(fullData);
        };

        const resetChunkTimeout = () => {
          if (chunkTimer) clearTimeout(chunkTimer);
          const timeoutMs = chunks.length > 0 ? 8000 : 10000;
          chunkTimer = setTimeout(() => {
            if (chunks.length > 0) {
              console.log('[LocalClient Download] Transmissão de pacotes finalizada pela câmera.');
              assembleAndResolve();
            } else {
              cleanup();
              reject(new Error('Nenhum dado recebido da câmera para este arquivo.'));
            }
          }, timeoutMs);
        };

        const chunkHandler = (chunk) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
          if (onProgress) {
            onProgress(totalBytes, 0);
          }
          resetChunkTimeout();
        };

        const endJsonHandler = (json) => {
          if (json.code === 411 || json.code === 409) {
            console.log('[LocalClient Download] Câmera notificou fim da transmissão:', json.code);
            assembleAndResolve();
          }
        };

        this.on('file_chunk', chunkHandler);
        this.on('json_response', endJsonHandler);
        resetChunkTimeout();

        // Envia requisição START_STREAM (código 406)
        this.sendPacket(this.createJsonPacket({
          code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_START_STREAM,
          devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
          date: parseInt(date, 10),
          hours: parseInt(hours, 10),
          minute: parseInt(minute, 10)
        }));
      });

      return { fileName, data: fileData, size: fileData.length };
    } finally {
      this.isDownloading = false;
      try {
        this.sendPacket(this.createJsonPacket({
          code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_STOP_STREAM,
          devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
        }));
      } catch (_) {}

      if (wasStreaming && autoResumeStream) {
        await new Promise(r => setTimeout(r, 400));
        this.startVideoStream();
      }
    }
  }

  /**
   * Exclui um arquivo gravado no cartão SD (Code 412)
   * A câmera A9/V720 processa a exclusão no disco FAT sem emitir pacote de confirmação.
   */
  async deleteSdCardFile(date, hours, minute) {
    return this.executeCommand(async () => {
      this.sendPacket(this.createJsonPacket({
        code: LOCAL_CONSTANTS.CODE_SDCARD_REQ_MEDIA_DELETE,
        devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
        date: parseInt(date, 10),
        hours: parseInt(hours, 10),
        minute: parseInt(minute, 10)
      }));
      await new Promise(r => setTimeout(r, 150));
      return { success: true };
    });
  }

  /**
   * Formata o cartão MicroSD (Code 207)
   */
  async formatSdCard() {
    console.log('[LocalClient] 🗑️ Enviando comando mestre de formatação do MicroSD (Code 207)...');
    this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_SDCARD_FORMAT,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
    }));
    await new Promise(r => setTimeout(r, 1500));
    return { success: true, message: 'Cartão formatado' };
  }

  // --- CAMERA HARDWARE CONTROLS ---
  setIrLed(enabled) {
    return this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_IR_LED,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      IrLed: enabled ? 1 : 0
    }));
  }

  setFlip(enabled) {
    return this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_VIDEO_FLIP,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET,
      mirrorFlip: enabled ? 4 : 0
    }));
  }

  reboot() {
    return this.sendPacket(this.createApCommand({
      code: LOCAL_CONSTANTS.CODE_FORWARD_DEV_REBOOT,
      devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
    }));
  }

  cleanup() {
    this.stopHeartbeat();
    this.isConnected = false;
    this.isStreaming = false;
    this.isDownloading = false;
    this.rxBuffer = Buffer.alloc(0);
    this.jpegBuffer = [];
    this.isJpegSync = false;
    if (this.socket) {
      try {
        if (typeof this.socket.resetAndDestroy === 'function') {
          this.socket.resetAndDestroy();
        } else {
          this.socket.destroy();
        }
      } catch (e) {}
      this.socket = null;
    }
  }

  disconnect() {
    if (this.socket) {
      try {
        this.sendPacket(this.createApCommand({
          code: LOCAL_CONSTANTS.CODE_FORWARD_CLOSE_A_CLOSE_V,
          devTarget: LOCAL_CONSTANTS.DEFAULT_DEV_TARGET
        }));
      } catch (e) {}
      this.cleanup();
    }
  }
}
