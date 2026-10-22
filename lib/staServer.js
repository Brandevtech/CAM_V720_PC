/**
 * STA Mode Server for V720 / A9 Naxclow Camera
 * Listens on TCP 6123, UDP 6123, and MQTT 1883 when camera connects over home Wi-Fi.
 * Implements Naxclow MQTT negotiation, NAT handshake, retransmission, and JPEG stream.
 */
import net from 'net';
import dgram from 'dgram';
import { Aedes } from 'aedes';
import { EventEmitter } from 'events';

const CMD = {
  P2P_UDP_CMD_JSON: 0,
  P2P_UDP_CMD_JPEG: 1,
  P2P_UDP_CMD_HEARTBEAT: 100,
  P2P_UDP_CMD_PING: 101,
  P2P_UDP_CMD_RETRANSMISSION_CONFIRM: 605,

  CODE_2S_REGISTER_REQ: 100,
  CODE_S2_REGISTER_RSP: 101,
  CODE_S2D_NAT_REQ: 11,
  CODE_D2S_NAT_RSP: 12,
  CODE_C2S_UDP_REQ: 20,
  CODE_S2C_UDP_RSP: 21,
  CODE_C2D_PROBE_REQ: 50,
  CODE_D2C_PROBE_RSP: 51,
  CODE_S2_DEVICE_STATUS: 53,
  CODE_CMD_FORWARD: 301,
  CODE_RETRANSMISSION: 298,
  CODE_FORWARD_DEV_BASE_INFO: 4,
  CODE_FORWARD_OPEN_A_OPEN_V: 3,
  CODE_FORWARD_CLOSE_A_CLOSE_V: 0,
  CODE_FORWARD_DEV_IR_LED: 202,
  CODE_FORWARD_DEV_VIDEO_FLIP: 216,
  CODE_FORWARD_DEV_REBOOT: 299,

  PROTOCOL_MSG_FLAG_HEAD: 250,
  PROTOCOL_MSG_FLAG_BODY: 251,
  PROTOCOL_MSG_FLAG_END: 252,
  PROTOCOL_MSG_FLAG_FINISH: 255
};

export class StaCameraServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.localIp = options.localIp || '192.168.15.5';
    this.port = options.port || 6123;
    this.mqttPort = options.mqttPort || 1883;

    this.tcpServer = null;
    this.udpSocket = null;
    this.aedes = null;
    this.mqttServer = null;

    this.activeTcpClient = null;
    this.cameraUdpInfo = null; // { address, port }

    this.cliTarget = '00112233445566778899aabbccddeeff';
    this.cliToken = '55ABfb77';
    this.devTarget = '5c0006004882';
    this.devToken = null;

    this.frameChunks = [];
    this.receivedPkgIds = [];
    this.retransTimer = null;
    this.isStreaming = false;
    this.cameraInfo = {
      sdCapacity: 3,
      sdCardReco: 1,
      sdMoveMode: 1,
      moveGrade: 3
    };
  }

  createPacket(cmd, payload = Buffer.alloc(0), msgFlag = 0, dealFlag = 0, forwardId = '00000000', pkgId = 0) {
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

  createJsonPacket(jsonObj, msgFlag = 0) {
    const jsonStr = JSON.stringify(jsonObj);
    return this.createPacket(CMD.P2P_UDP_CMD_JSON, Buffer.from(jsonStr, 'ascii'), msgFlag);
  }

  parsePacket(buf) {
    if (!buf || buf.length < 20) return null;
    const len = buf.readUInt32LE(0);
    const cmd = buf.readUInt16LE(4);
    const msgFlag = buf.readUInt8(6);
    const dealFlag = buf.readUInt8(7);
    const forwardId = buf.toString('ascii', 8, 16);
    const pkgId = buf.readUInt32LE(16);
    const payload = buf.subarray(20, 20 + Math.min(len, buf.length - 20));

    return { len, cmd, msgFlag, dealFlag, forwardId, pkgId, payload };
  }

  async start() {
    this.startTcp();
    this.startUdp();
    await this.startMqtt();
  }

  async startMqtt() {
    this.aedes = await Aedes.createBroker();
    this.mqttServer = net.createServer((socket) => this.aedes.handle(socket));

    this.mqttServer.on('error', (err) => {
      console.warn('[STA MQTT Server Error]', err.message);
    });

    this.mqttServer.listen(this.mqttPort, '0.0.0.0', () => {
      console.log(`[STA Server] Broker MQTT ativo na porta ${this.mqttPort} (v720.p2p.naxclow.com)`);
    });

    this.aedes.on('client', (client) => {
      console.log(`[STA MQTT] Client Connected: ID=${client.id}, User=${client.req?.username}, Pass=${client.req?.password ? client.req.password.toString('utf8') : 'none'}`);
      if (client.id && (client.id.startsWith('5c') || client.id.length === 12)) {
        console.log(`[STA MQTT] 🟢 Câmera conectou no broker MQTT! Client ID: ${client.id}`);
        this.devTarget = client.id;
        const remoteIp = client.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : '192.168.15.10';
        this.cameraIp = remoteIp;
        this.emit('status', { status: 'mqtt_connected', deviceId: client.id, address: remoteIp });
        this.sendUdpHolePunch(remoteIp);
      }
    });

    this.aedes.on('subscribe', (subscriptions, client) => {
      const topicNames = subscriptions.map(s => s.topic);
      console.log(`[STA MQTT] 📡 Cliente (${client?.id}) subscreveu aos tópicos:`, topicNames);
      if (client?.id && (client.id.startsWith('5c') || client.id.length === 12)) {
        this.devTarget = client.id;
        setTimeout(() => {
          this.sendMqttNatRequest(client.id);
        }, 200);
      }
    });

    this.aedes.on('publish', (packet, client) => {
      if (!client) return;
      try {
        const topic = packet.topic;
        const str = packet.payload.toString('utf8');
        console.log(`[STA MQTT Info] 📥 ${topic}:`, str);
        if (topic.includes('Status') || topic.includes('Info')) {
          try {
            const data = JSON.parse(str);
            this.cameraInfo = { ...this.cameraInfo, ...data };
            if (data.token) {
              this.devToken = data.token;
              this.cliToken = data.token;
            }
            if (data.devicesCode) {
              this.devTarget = data.devicesCode;
            }
            this.emit('camera_info', this.cameraInfo);
          } catch (e) {}
          if (client.id && (client.id.startsWith('5c') || client.id.length === 12)) {
            this.sendMqttNatRequest(client.id);
          } else {
            this.sendMqttNatRequest(this.devTarget);
          }
          if (this.cameraIp) {
            this.sendUdpHolePunch(this.cameraIp);
          }
        }
      } catch (e) {}
    });
  }

  sendUdpHolePunch(targetIp = null) {
    const ip = targetIp || this.cameraIp || '192.168.15.10';
    if (!this.udpSockets || this.udpSockets.length === 0) return;

    const currentToken = this.devToken || this.cliToken || '02e9dab692';
    const devId = this.devTarget || '5c0006004882';

    // 1. Probe 50 com campos completos (desmontado diretamente do APK Lcom/naxclow/rtc/net/OooOo0 0x176580)
    const probe50Obj = {
      code: CMD.CODE_C2D_PROBE_REQ,
      cliToken: currentToken,
      devTarget: devId,
      cliId: this.cliTarget,
      devToken: currentToken
    };
    const probeReq50 = this.createJsonPacket(probe50Obj);
    const probeRaw50 = Buffer.from(JSON.stringify(probe50Obj));
    const probeRawSimple50 = Buffer.from(JSON.stringify({ code: CMD.CODE_C2D_PROBE_REQ }));

    // 2. Probe 20 (CODE_C2S_UDP_REQ)
    const probe20Obj = { code: CMD.CODE_C2S_UDP_REQ };
    const probeReq20 = this.createJsonPacket(probe20Obj);
    const probeRaw20 = Buffer.from(JSON.stringify(probe20Obj));

    // 3. Heartbeat / Ping (CMD 100 / 101)
    const pingPkt = this.createPacket(CMD.P2P_UDP_CMD_PING);
    const hbPkt = this.createPacket(CMD.P2P_UDP_CMD_HEARTBEAT);

    const targetPorts = [6123, 53221, 41234];

    console.log(`[STA UDP] ⚡ Enviando pacotes de perfuração UDP calibrados para ${ip} nas portas:`, targetPorts);
    for (const sock of this.udpSockets) {
      for (const tPort of targetPorts) {
        try {
          sock.send(probeReq50, tPort, ip);
          sock.send(probeRaw50, tPort, ip);
          sock.send(probeRawSimple50, tPort, ip);
          sock.send(probeReq20, tPort, ip);
          sock.send(probeRaw20, tPort, ip);
          sock.send(pingPkt, tPort, ip);
          sock.send(hbPkt, tPort, ip);
        } catch (_) {}
      }
    }
  }

  sendMqttNatRequest(clientId) {
    const devId = (clientId && (clientId.startsWith('5c') || clientId.length === 12)) ? clientId : (this.devTarget || '5c0006004882');
    const cameraIp = this.cameraIp || '192.168.15.10';
    const topics = [
      `Naxclow/P2P/Users/Device/sub/${devId}`,
      `Naxclow/P2P/Users/Device/sub/5c0006004882`
    ];

    const currentToken = this.devToken || this.cliToken || '02e9dab692';

    // 0. Sinalização WAN NAT Traversal nativa (Code 10 do APK reqConnect offset 0x173510)
    const wanCode10 = JSON.stringify({
      code: 10,
      cliIp: this.localIp,
      cliPort: this.port,
      cliNatIp: this.localIp,
      cliNatPort: this.port,
      devTarget: devId,
      devToken: currentToken
    });

    // 1. Sinalização LAN Direta (Code 30 do APK reqForwardId offset 0x17361c)
    const lanCode30 = JSON.stringify({
      code: 30,
      cliIp: this.localIp,
      cliPort: this.port,
      devIp: cameraIp,
      devPort: this.port,
      devTarget: devId,
      devToken: currentToken
    });

    // 2. Confirmação de Probe LAN (Code 36)
    const lanCode36 = JSON.stringify({
      code: 36,
      devTarget: devId
    });

    // 3. Fallback WAN NAT Traversal (Code 11)
    const wanCode11 = JSON.stringify({
      code: CMD.CODE_S2D_NAT_REQ,
      cliId: this.cliTarget,
      cliTarget: this.cliTarget,
      cliToken: currentToken,
      devTarget: devId,
      devToken: currentToken,
      cliIp: this.localIp,
      cliPort: this.port,
      cliNatIp: this.localIp,
      cliNatPort: this.port
    });

    for (const topic of new Set(topics)) {
      console.log(`[STA MQTT] 🚀 Enviando CODE 10, CODE 30 (LAN Direto) e CODE 36 para ${topic}`);
      // Envia formato direto e envelopado (target: devId)
      const envWan10 = JSON.stringify({ code: CMD.CODE_CMD_FORWARD, target: devId, content: JSON.parse(wanCode10) });
      const envLan30 = JSON.stringify({ code: CMD.CODE_CMD_FORWARD, target: devId, content: JSON.parse(lanCode30) });
      const envLan36 = JSON.stringify({ code: CMD.CODE_CMD_FORWARD, target: devId, content: JSON.parse(lanCode36) });
      const envWan11 = JSON.stringify({ code: CMD.CODE_CMD_FORWARD, target: devId, content: JSON.parse(wanCode11) });

      this.aedes.publish({ topic, payload: Buffer.from(envWan10, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(envLan30, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(envLan36, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(envWan11, 'utf8'), qos: 0, retain: false });

      this.aedes.publish({ topic, payload: Buffer.from(wanCode10, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(lanCode30, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(lanCode36, 'utf8'), qos: 0, retain: false });
      this.aedes.publish({ topic, payload: Buffer.from(wanCode11, 'utf8'), qos: 0, retain: false });
    }

    setTimeout(() => {
      for (const topic of new Set(topics)) {
        console.log(`[STA MQTT] 🎥 Enviando comandos de ativação de stream (Code 301 / 3 / 54) para ${topic}`);
        // 1. Device Status
        this.aedes.publish({ topic, payload: Buffer.from(JSON.stringify({ code: CMD.CODE_S2_DEVICE_STATUS, status: 1 })), qos: 0, retain: false });

        // 2. Retransmissão Code 298
        const retransPkt = JSON.stringify({
          code: CMD.CODE_CMD_FORWARD,
          target: devId,
          content: { code: CMD.CODE_RETRANSMISSION }
        });
        this.aedes.publish({ topic, payload: Buffer.from(retransPkt), qos: 0, retain: false });

        // 3. Informações de base Code 4
        const baseInfoPkt = JSON.stringify({
          code: CMD.CODE_CMD_FORWARD,
          target: devId,
          content: { unixTimer: Math.floor(Date.now() / 1000), code: CMD.CODE_FORWARD_DEV_BASE_INFO }
        });
        this.aedes.publish({ topic, payload: Buffer.from(baseInfoPkt), qos: 0, retain: false });

        // 4. Code 301 com content: { code: 3 } (Ativação de Vídeo)
        const forwardPkt = JSON.stringify({
          code: CMD.CODE_CMD_FORWARD,
          target: devId,
          content: { code: CMD.CODE_FORWARD_OPEN_A_OPEN_V }
        });
        this.aedes.publish({ topic, payload: Buffer.from(forwardPkt), qos: 0, retain: false });

        // 5. Direct Code 3
        const directPkt = JSON.stringify({ code: CMD.CODE_FORWARD_OPEN_A_OPEN_V, devTarget: devId });
        this.aedes.publish({ topic, payload: Buffer.from(directPkt), qos: 0, retain: false });

        // 6. Code 54 (Timestamp de Live)
        const live54 = JSON.stringify({ code: 54, timerStamp: `${Date.now()}` });
        this.aedes.publish({ topic, payload: Buffer.from(live54), qos: 0, retain: false });
      }
      if (this.cameraIp) {
        this.sendUdpHolePunch(this.cameraIp);
      }
    }, 300);
  }

  startTcp() {
    this.tcpServer = net.createServer((socket) => {
      console.log(`[STA TCP] Câmera conectada de ${socket.remoteAddress}:${socket.remotePort}`);
      this.activeTcpClient = socket;
      this.emit('status', { status: 'camera_connected', address: socket.remoteAddress });

      let rxBuf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);

        while (rxBuf.length >= 20) {
          const payloadLen = rxBuf.readUInt32LE(0);
          const totalPktLen = 20 + payloadLen;
          if (rxBuf.length < totalPktLen) break;

          const pktBuf = rxBuf.subarray(0, totalPktLen);
          rxBuf = rxBuf.subarray(totalPktLen);

          const pkt = this.parsePacket(pktBuf);
          if (pkt) this.handleTcpPacket(socket, pkt);
        }
      });

      socket.on('close', () => {
        console.log('[STA TCP] Câmera desconectou');
        if (this.activeTcpClient === socket) {
          this.activeTcpClient = null;
        }
        this.emit('status', { status: 'camera_disconnected' });
      });

      socket.on('error', (err) => {
        console.warn('[STA TCP Error]', err.message);
      });
    });

    this.tcpServer.listen(this.port, '0.0.0.0', () => {
      console.log(`[STA Server] Ouvindo conexões TCP da câmera na porta ${this.port}`);
    });
  }

  handleTcpPacket(socket, pkt) {
    if (pkt.cmd === CMD.P2P_UDP_CMD_JSON) {
      try {
        const json = JSON.parse(pkt.payload.toString('ascii'));
        console.log(`[STA TCP JSON] Recv:`, json);

        // 1. Initial Registration Request (Code 100)
        if (json.code === CMD.CODE_2S_REGISTER_REQ) {
          this.devTarget = json.uid;
          this.devToken = json.token;
          console.log(`[STA TCP] Dispositivo identificado: UID=${this.devTarget}, Token=${this.devToken}`);

          // Send Register OK (Code 101)
          const rsp101 = this.createJsonPacket({ code: CMD.CODE_S2_REGISTER_RSP, status: 200 }, CMD.PROTOCOL_MSG_FLAG_FINISH);
          socket.write(rsp101);

          // Send NAT Request (Code 11)
          const rsp11 = this.createJsonPacket({
            code: CMD.CODE_S2D_NAT_REQ,
            cliTarget: this.cliTarget,
            cliToken: this.cliToken,
            cliIp: this.localIp,
            cliPort: this.port,
            cliNatIp: this.localIp,
            cliNatPort: this.port
          });
          socket.write(rsp11);
        }

        // 2. Camera NAT Response (Code 12)
        if (json.code === CMD.CODE_D2S_NAT_RSP) {
          console.log(`[STA TCP] Câmera confirmou NAT (status ${json.status})`);
        }

        // 3. Forward responses (Code 301)
        if (json.code === CMD.CODE_CMD_FORWARD && json.content) {
          console.log(`[STA TCP Forward Content]:`, json.content);
        }
      } catch (e) {
        console.warn(`[STA TCP JSON Error]`, e.message);
      }
    } else if (pkt.cmd === CMD.P2P_UDP_CMD_HEARTBEAT) {
      socket.write(this.createPacket(CMD.P2P_UDP_CMD_HEARTBEAT));
    }
  }

  startUdp() {
    const udpPorts = [this.port, 53221, 41234];
    this.udpSockets = [];

    const onMessage = (sock, msg, rinfo) => {
      this.cameraUdpInfo = rinfo;
      console.log(`[STA UDP] 📦 Recebido pacote de ${rinfo.address}:${rinfo.port} (${msg.length} bytes) na porta local ${sock.address().port}`);

      let pkt = this.parsePacket(msg);
      let json = null;

      if (pkt && pkt.cmd === CMD.P2P_UDP_CMD_JSON) {
        try {
          json = JSON.parse(pkt.payload.toString('ascii'));
        } catch (e) {}
      } else if (msg.length > 0 && msg[0] === 0x7b) {
        try {
          json = JSON.parse(msg.toString('utf8'));
        } catch (e) {}
      }

      if (json) {
        console.log(`[STA UDP JSON] 📩 Recv:`, json);
        // UDP Probe Request (Code 20)
        if (json.code === CMD.CODE_C2S_UDP_REQ) {
          console.log(`[STA UDP] 🎯 Câmera solicitou UDP probe (code 20) de ${rinfo.address}:${rinfo.port}`);
          const rsp21Obj = {
            code: CMD.CODE_S2C_UDP_RSP,
            ip: this.localIp,
            port: sock.address().port
          };
          sock.send(this.createJsonPacket(rsp21Obj), rinfo.port, rinfo.address);
          sock.send(Buffer.from(JSON.stringify(rsp21Obj)), rinfo.port, rinfo.address);
        }

        // Camera Probe Response (Code 51)
        if (json.code === CMD.CODE_D2C_PROBE_RSP) {
          console.log(`[STA UDP] 🚀 Recebido probe response code 51. Ativando streaming de vídeo!`);
          const req50Obj = {
            code: CMD.CODE_C2D_PROBE_REQ,
            cliToken: this.cliToken || '02e9dab692',
            devTarget: this.devTarget || '5c0006004882',
            cliId: this.cliTarget,
            devToken: this.devToken || '02e9dab692'
          };
          sock.send(this.createJsonPacket(req50Obj), rinfo.port, rinfo.address);
          sock.send(Buffer.from(JSON.stringify(req50Obj)), rinfo.port, rinfo.address);

          const sendCommandPkt = (obj) => {
            const p = this.createJsonPacket(obj);
            const raw = Buffer.from(JSON.stringify(obj));
            if (this.activeTcpClient) {
              this.activeTcpClient.write(p);
            }
            sock.send(p, rinfo.port, rinfo.address);
            sock.send(raw, rinfo.port, rinfo.address);
            if (this.aedes) {
              const topic = `Naxclow/P2P/Users/Device/sub/${this.devTarget || '5c0006004882'}`;
              this.aedes.publish({ topic, payload: raw, qos: 0, retain: false });
            }
          };

          const devId = this.devTarget || '5c0006004882';
          sendCommandPkt({ code: CMD.CODE_S2_DEVICE_STATUS, status: 1 });
          sendCommandPkt({
            code: CMD.CODE_CMD_FORWARD,
            target: devId,
            content: { code: CMD.CODE_RETRANSMISSION }
          });
          sendCommandPkt({
            code: CMD.CODE_CMD_FORWARD,
            target: devId,
            content: { unixTimer: Math.floor(Date.now() / 1000), code: CMD.CODE_FORWARD_DEV_BASE_INFO }
          });
          sendCommandPkt({
            code: CMD.CODE_CMD_FORWARD,
            target: devId,
            content: { code: CMD.CODE_FORWARD_OPEN_A_OPEN_V }
          });

          this.isStreaming = true;
          this.startRetransmissionLoop();
          this.emit('status', { status: 'streaming_started' });
        }
      } else if (pkt && pkt.cmd === CMD.P2P_UDP_CMD_JPEG) {
        this.handleJpegChunk(pkt);
      } else if (pkt && pkt.cmd === CMD.P2P_UDP_CMD_HEARTBEAT) {
        sock.send(this.createPacket(CMD.P2P_UDP_CMD_HEARTBEAT), rinfo.port, rinfo.address);
      }
    };

    udpPorts.forEach((p) => {
      try {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => onMessage(sock, msg, rinfo));
        sock.on('error', (err) => console.warn(`[STA UDP Error port ${p}]`, err.message));
        sock.bind(p, '0.0.0.0', () => {
          console.log(`[STA Server] Ouvindo dados UDP da câmera na porta ${p}`);
        });
        this.udpSockets.push(sock);
        if (p === this.port) this.udpSocket = sock;
      } catch (err) {
        console.warn(`[STA UDP Bind Error port ${p}]`, err.message);
      }
    });
  }

  handleJpegChunk(pkt) {
    this.receivedPkgIds.push(pkt.pkgId);

    if (pkt.msgFlag === CMD.PROTOCOL_MSG_FLAG_HEAD) {
      this.frameChunks = [pkt.payload];
    } else if (pkt.msgFlag === CMD.PROTOCOL_MSG_FLAG_BODY) {
      this.frameChunks.push(pkt.payload);
    } else if (pkt.msgFlag === CMD.PROTOCOL_MSG_FLAG_END) {
      this.frameChunks.push(pkt.payload);

      const fullFrame = Buffer.concat(this.frameChunks);
      this.frameChunks = [];

      const soi = fullFrame.indexOf(Buffer.from([0xff, 0xd8]));
      const eoi = fullFrame.lastIndexOf(Buffer.from([0xff, 0xd9]));

      if (soi !== -1 && eoi !== -1 && eoi > soi) {
        const jpegBuf = fullFrame.subarray(soi, eoi + 2);
        const dataUrl = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
        this.emit('frame', dataUrl);
      }
    }
  }

  startRetransmissionLoop() {
    if (this.retransTimer) clearInterval(this.retransTimer);
    this.retransTimer = setInterval(() => {
      if (!this.isStreaming || !this.cameraUdpInfo || this.receivedPkgIds.length === 0) return;

      const count = Math.min(this.receivedPkgIds.length, 30);
      const pkgList = this.receivedPkgIds.splice(0, count);

      const payload = Buffer.alloc(count * 4);
      for (let i = 0; i < count; i++) {
        payload.writeUInt32LE(pkgList[i], i * 4);
      }

      const confirmPkt = this.createPacket(CMD.P2P_UDP_CMD_RETRANSMISSION_CONFIRM, payload);
      this.udpSocket.send(confirmPkt, this.cameraUdpInfo.port, this.cameraUdpInfo.address);
    }, 100);
  }

  sendMqttCommand(contentObj) {
    const devId = this.devTarget || '5c0006004882';
    const topic = `Naxclow/P2P/Users/Device/sub/${devId}`;
    if (!this.aedes) return false;
    console.log(`[STA MQTT] 📡 Publicando comando para ${topic}:`, contentObj);

    // Envia no formato envelopado (Code 301 com target: devId) e direto
    const forwardPayload = {
      code: CMD.CODE_CMD_FORWARD,
      target: devId,
      content: contentObj
    };
    this.aedes.publish({
      topic,
      payload: Buffer.from(JSON.stringify(forwardPayload)),
      qos: 0,
      retain: false
    });
    this.aedes.publish({
      topic,
      payload: Buffer.from(JSON.stringify(contentObj)),
      qos: 0,
      retain: false
    });
    return true;
  }

  setIrLed(enable) {
    this.sendMqttCommand({ code: CMD.CODE_FORWARD_DEV_IR_LED, IrLed: enable ? 1 : 0 });
    if (this.activeTcpClient) {
      const devId = this.devTarget || '5c0006004882';
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: CMD.CODE_FORWARD_DEV_IR_LED, IrLed: enable ? 1 : 0 }
      }));
    }
  }

  setFlip(enable) {
    this.sendMqttCommand({ code: CMD.CODE_FORWARD_DEV_VIDEO_FLIP, mirrorFlip: enable ? 1 : 0 });
    if (this.activeTcpClient) {
      const devId = this.devTarget || '5c0006004882';
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: CMD.CODE_FORWARD_DEV_VIDEO_FLIP, mirrorFlip: enable ? 1 : 0 }
      }));
    }
  }

  reboot() {
    this.sendMqttCommand({ code: CMD.CODE_FORWARD_DEV_REBOOT, reboot: 1 });
    if (this.activeTcpClient) {
      const devId = this.devTarget || '5c0006004882';
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: CMD.CODE_FORWARD_DEV_REBOOT, reboot: 1 }
      }));
    }
  }

  switchToAp() {
    console.log('[STA Server] 📡 Enviando comando para câmera alternar para Modo AP (code: 208)...');
    this.sendMqttCommand({ code: 208 });
    if (this.activeTcpClient) {
      const devId = this.devTarget || '5c0006004882';
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: 208 }
      }));
    }
  }

  setMoveAlert(enabled = true, grade = 3) {
    console.log(`[STA Server] 🎯 Configurando gravação por movimento no Cartão SD: ${enabled ? 'ATIVA' : 'DESLIGADA'}, sensibilidade: ${grade}`);
    this.sendMqttCommand({ code: 209, sdCardReco: enabled ? 1 : 0 });
    this.sendMqttCommand({ code: 205, moveAlert: enabled ? 1 : 0 });
    this.sendMqttCommand({ code: 206, moveGrade: grade });
    this.sendMqttCommand({ code: 203, sdMoveMode: enabled ? 1 : 0 });

    if (this.activeTcpClient) {
      const devId = this.devTarget || '5c0006004882';
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: 209, sdCardReco: enabled ? 1 : 0 }
      }));
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: 205, moveAlert: enabled ? 1 : 0 }
      }));
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: 206, moveGrade: grade }
      }));
      this.activeTcpClient.write(this.createJsonPacket({
        code: CMD.CODE_CMD_FORWARD,
        target: devId,
        content: { code: 203, sdMoveMode: enabled ? 1 : 0 }
      }));
    }
  }

  queryInfo() {
    console.log('[STA Server] 📡 Solicitando informações atualizadas de hardware da câmera (Code 201)...');
    return this.sendMqttCommand({ code: 201 });
  }

  stop() {
    this.isStreaming = false;
    if (this.retransTimer) clearInterval(this.retransTimer);
    if (this.tcpServer) this.tcpServer.close();
    if (this.udpSocket) this.udpSocket.close();
    if (this.mqttServer) this.mqttServer.close();
  }
}
