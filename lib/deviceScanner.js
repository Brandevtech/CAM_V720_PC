/**
 * DeviceScanner Module
 * Scans local network for V720 / Naxclow cameras in AP Mode or LAN Mode
 */

import net from 'net';
import os from 'os';
import dgram from 'dgram';

const DEFAULT_AP_IP = '192.168.169.1';
const COMMON_PORTS = [554, 80, 8080, 8000, 3578];

/**
 * Checks if a specific TCP host and port is open
 */
function probePort(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let isOpened = false;

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      isOpened = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Gets local IPv4 subnets
 */
function getLocalSubnets() {
  const interfaces = os.networkInterfaces();
  const subnets = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        subnets.push({
          interface: name,
          ip: iface.address,
          subnetPrefix: `${parts[0]}.${parts[1]}.${parts[2]}`
        });
      }
    }
  }
  return subnets;
}

/**
 * Scans for V720 Camera
 */
export async function scanForDevices(customSubnet = null) {
  const foundDevices = [];

  // 1. Check AP mode IP (192.168.169.1)
  const isApActive = await probePort(DEFAULT_AP_IP, 554, 1000) || await probePort(DEFAULT_AP_IP, 80, 1000);
  if (isApActive) {
    foundDevices.push({
      ip: DEFAULT_AP_IP,
      mode: 'AP Mode (Direct)',
      ports: { rtsp: 554, http: 80 },
      rtspUrl: `rtsp://${DEFAULT_AP_IP}:554/live/ch0`,
      description: 'V720 Camera in Direct Access Point Mode'
    });
  }

  // 2. Scan local subnet if requested or automatic
  const subnets = customSubnet ? [{ subnetPrefix: customSubnet }] : getLocalSubnets();
  
  for (const sub of subnets) {
    // Probe common IP ranges or specific camera candidates (like .1, .100, .101, etc.)
    const candidates = [DEFAULT_AP_IP];
    for (let i = 2; i <= 254; i++) {
      candidates.push(`${sub.subnetPrefix}.${i}`);
    }

    // Limit concurrency to avoid socket exhaustion
    const chunkSize = 25;
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async ip => {
        if (ip === sub.ip) return; // skip own host IP
        const hasRtsp = await probePort(ip, 554, 400);
        if (hasRtsp) {
          foundDevices.push({
            ip,
            mode: 'LAN Mode (Wi-Fi)',
            ports: { rtsp: 554 },
            rtspUrl: `rtsp://${ip}:554/live/ch0`,
            description: `Network Camera at ${ip}`
          });
        }
      }));
      // If we already found a device in AP mode, don't stall the user
      if (foundDevices.length > 0 && foundDevices[0].ip === DEFAULT_AP_IP) break;
    }
  }

  return foundDevices;
}

/**
 * Sends a UDP broadcast probe to trigger response from V720 cameras
 */
export function sendUdpDiscovery(port = 10000, timeout = 2500) {
  return new Promise(resolve => {
    const server = dgram.createSocket('udp4');
    const responses = [];

    server.on('error', err => {
      server.close();
      resolve(responses);
    });

    server.on('message', (msg, rinfo) => {
      responses.push({
        ip: rinfo.address,
        port: rinfo.port,
        rawHex: msg.toString('hex'),
        text: msg.toString('utf8').replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
      });
    });

    server.bind(() => {
      server.setBroadcast(true);
      // Discovery packet
      const probe = Buffer.from('{"cmd":"discover","type":"v720"}');
      server.send(probe, 0, probe.length, port, '255.255.255.255', () => {
        setTimeout(() => {
          try { server.close(); } catch (e) {}
          resolve(responses);
        }, timeout);
      });
    });
  });
}
