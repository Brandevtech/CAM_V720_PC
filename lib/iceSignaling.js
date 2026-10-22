import { EventEmitter } from 'events';

export class IceSignalingService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // conId -> { ws, sdp, target, token }
  }

  handleConnection(ws, req) {
    const url = req.url || '';
    const match = url.match(/\/v720\/rtc\/ice\/([^/?]+)/);
    const conId = match ? match[1] : 'default';

    console.log(`[ICE Signaling] 🟢 Nova sessão WebRTC conectada: conId=${conId} (remoto: ${req.socket.remoteAddress})`);

    const session = {
      conId,
      ws,
      remoteIp: req.socket.remoteAddress,
      connectedAt: Date.now(),
      remoteSdp: null,
      localSdp: null
    };

    this.sessions.set(conId, session);

    ws.on('message', (raw) => {
      try {
        const text = raw.toString('utf8');
        console.log(`[ICE Signaling Recv ${conId}]:`, text.substring(0, 300));
        const data = JSON.parse(text);

        if (data.code === 'wsDevicesConnect') {
          console.log(`[ICE Signaling] Handshake wsDevicesConnect recebido para target=${data.target}`);
          session.target = data.target;
          session.token = data.token;
          ws.send(JSON.stringify({
            code: 'wsDevicesConnect',
            status: 200,
            message: 'success',
            target: data.target
          }));
          this.emit('device_connect', { conId, target: data.target, token: data.token });
        } else if (data.code === 'wsDevicesSdp') {
          console.log(`[ICE Signaling] 📥 SDP Recebido (tamanho: ${data.sdp?.length || 0} bytes)`);
          session.remoteSdp = data.sdp;
          ws.send(JSON.stringify({
            code: 'wsDevicesSdp',
            status: 200,
            message: 'success'
          }));
          this.emit('sdp_offer', { conId, sdp: data.sdp, target: data.target });
        } else if (data.code === 'wsDevicesSdpSend') {
          console.log(`[ICE Signaling] 📤 Confirmação wsDevicesSdpSend recebida`);
          ws.send(JSON.stringify({
            code: 'wsDevicesSdpSend',
            status: 200,
            message: 'success'
          }));
        }
      } catch (err) {
        console.warn(`[ICE Signaling Parse Error ${conId}]`, err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[ICE Signaling] 🔴 Sessão WebRTC desconectada: conId=${conId}`);
      this.sessions.delete(conId);
    });

    ws.on('error', (err) => {
      console.warn(`[ICE Signaling Error ${conId}]`, err.message);
    });
  }

  sendSdpAnswer(conId, answerSdp) {
    const session = this.sessions.get(conId);
    if (!session || !session.ws) return false;

    console.log(`[ICE Signaling] 🚀 Enviando SDP Answer para sessão ${conId}`);
    session.ws.send(JSON.stringify({
      code: 'wsDevicesSdp',
      status: 200,
      sdp: answerSdp,
      target: session.target
    }));
    return true;
  }
}
