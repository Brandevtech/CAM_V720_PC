/**
 * CloudClient Module
 * Communicates with the official V720 / Naxclow Cloud Infrastructure, Authentication & WebRTC Gateway.
 * Fully reconstructed from com.naxclow.v720 APK analysis (classes5.dex & classes6.dex).
 */
import WebSocket from 'ws';
import https from 'https';
import http from 'http';

export const CLOUD_CONFIG = {
  API_BASE: 'https://v720.naxclow.com',
  ICE_WEBSOCKET: 'ws://icev720.naxclow.com/v720/rtc/ice/',
  STUN_SERVER: 'stun:icev720.naxclow.com:3578',
  TURN_SERVER: 'turn:icev720.naxclow.com:3578',
  TURN_USER: 'b2228c1fb40d65a8',
  TURN_PASS: '4a7318ecb2228c1fb40d65a843e0ca9a',
  LIVE_WS: 'wss://h5v720app.naxclowyun.com/p2p/live',
  RECORDINGS_BASE: 'http://mp4.naxclow.com.cn',
  PUSH_SERVER: 'https://naxpush.naxclow.com:2118'
};

/**
 * Helper to perform HTTPS/HTTP requests
 */
function apiRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Gets WebRTC ICE configuration with real authenticated credentials from APK
 */
export function getIceConfiguration() {
  return {
    iceServers: [
      { urls: CLOUD_CONFIG.STUN_SERVER },
      {
        urls: CLOUD_CONFIG.TURN_SERVER,
        username: CLOUD_CONFIG.TURN_USER,
        credential: CLOUD_CONFIG.TURN_PASS
      },
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
}

/**
 * 1. Login with phone + password to V720 Naxclow cloud
 */
export async function loginCloudUser(phone, pwd) {
  const url = `${CLOUD_CONFIG.API_BASE}/app/api/ApiAppUser/login?phone=${encodeURIComponent(phone)}&pwd=${encodeURIComponent(pwd)}&app=v720`;
  const res = await apiRequest(url, {
    method: 'POST',
    headers: { 'User-Agent': 'okhttp/3.14.9' }
  });
  return res.data;
}

/**
 * 2. Register new user or guest account
 */
export async function registerCloudUser(phone, pwd = 'v720') {
  const url = `${CLOUD_CONFIG.API_BASE}/app/api/ApiAppUser/register?phone=${encodeURIComponent(phone)}&pwd=${encodeURIComponent(pwd)}&app=v720`;
  const res = await apiRequest(url, {
    method: 'POST',
    headers: { 'User-Agent': 'okhttp/3.14.9' }
  });
  return res.data;
}

/**
 * 3. Fetch device list bound to user account
 */
export async function fetchUserDevices(token) {
  const url = `${CLOUD_CONFIG.API_BASE}/app/api/ApiSysDevices/getDevicesListByType?type=0`;
  const res = await apiRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'User-Agent': 'okhttp/3.14.9'
    }
  });
  return res.data;
}

/**
 * 4. Get specific device details by code
 */
export async function getDeviceByCode(devicesCode, token) {
  const url = `${CLOUD_CONFIG.API_BASE}/app/api/ApiSysDevices/getDeviceByCode?devicesCode=${encodeURIComponent(devicesCode)}`;
  const res = await apiRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'User-Agent': 'okhttp/3.14.9'
    }
  });
  return res.data;
}

/**
 * 4.1 Get A9 / 5c WebRTC Video Session Conf (conId, token, host, port)
 */
export async function getA9VideoConf(devicesCode, token) {
  const url = `${CLOUD_CONFIG.API_BASE}/app/api/ApiServer/getA9VideoConf?devicesCode=${encodeURIComponent(devicesCode)}`;
  const res = await apiRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'User-Agent': 'okhttp/3.14.9'
    }
  });
  return res.data;
}

/**
 * 5. Check if camera is online via management port
 */
export async function checkDeviceOnline(host, managePort, devicesCode, token) {
  const url = `http://${host}:${managePort}/api/isOnline?id=${encodeURIComponent(devicesCode)}`;
  const res = await apiRequest(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'User-Agent': 'okhttp/3.14.9'
    }
  });
  return res.data;
}

/**
 * 6. WebRTC Signaling Session Manager (ws://icev720.naxclow.com/v720/rtc/ice/<conId>)
 */
export class WebRtcSignalingSession {
  constructor(conId, deviceToken, options = {}) {
    this.conId = conId;
    this.deviceToken = deviceToken;
    this.ws = null;
    this.target = null;
    this.status = 'idle';
    this.onOffer = options.onOffer || (() => {});
    this.onConnected = options.onConnected || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || (() => {});
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${CLOUD_CONFIG.ICE_WEBSOCKET}${encodeURIComponent(this.conId)}`;
      console.log(`[WebRtcSignaling] Connecting to ${url}...`);
      this.status = 'connecting';
      this.onStatus({ status: 'connecting', url });

      try {
        this.ws = new WebSocket(url, {
          headers: {
            'User-Agent': 'okhttp/3.14.9'
          }
        });
      } catch (err) {
        this.status = 'error';
        this.onError(err);
        return reject(err);
      }

      this.ws.on('open', () => {
        console.log(`[WebRtcSignaling] Connected to signaling server!`);
        this.status = 'connected';
        this.onStatus({ status: 'connected' });
        resolve({ success: true });
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString('utf8'));
          console.log(`[WebRtcSignaling] Received message:`, msg);
          this.handleMessage(msg);
        } catch (e) {
          console.error(`[WebRtcSignaling] Parse error:`, e.message);
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[WebRtcSignaling] Error:`, err.message);
        this.status = 'error';
        this.onError(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WebRtcSignaling] Closed (${code}):`, reason.toString());
        this.status = 'closed';
        this.onStatus({ status: 'closed', code, reason: reason.toString() });
      });
    });
  }

  handleMessage(msg) {
    const code = msg.code || msg.status;
    if (code === 3010) {
      // Server prompts for authentication
      console.log(`[WebRtcSignaling] Handshake requested (3010). Sending auth token...`);
      this.ws.send(JSON.stringify({
        code: 101,
        token: this.deviceToken
      }));
      this.onStatus({ status: 'authenticated_pending' });
    } else if (code === 3101) {
      // Remote Offer SDP received
      this.target = msg.target;
      const rawSdp = msg.sdp || '';
      let decodedSdp = rawSdp;
      try {
        decodedSdp = decodeURIComponent(rawSdp);
      } catch {}
      console.log(`[WebRtcSignaling] Remote Offer SDP received (len: ${decodedSdp.length}) for target: ${this.target}`);
      this.onStatus({ status: 'offer_received', target: this.target });
      this.onOffer({ target: this.target, sdp: decodedSdp });
    } else if (code === 3102) {
      // Confirmation from server that Answer was received
      console.log(`[WebRtcSignaling] Server accepted answer SDP (3102). Peer connection ready!`);
      this.status = 'ready';
      this.onStatus({ status: 'ready' });
      this.onConnected({ target: this.target });
    }
  }

  sendAnswerSdp(answerSdp) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    console.log(`[WebRtcSignaling] Sending Answer SDP for target ${this.target}...`);
    this.ws.send(JSON.stringify({
      code: 102,
      target: this.target,
      sdp: answerSdp
    }));
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = 'idle';
  }
}
