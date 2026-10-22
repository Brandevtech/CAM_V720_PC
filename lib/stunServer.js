import dgram from 'dgram';

/**
 * Lightweight RFC 5389 STUN Server for V720 WebRTC / NanoRTSP
 * Listens on port 3578 (icev720.naxclow.com:3578)
 */
export function startStunServer(port = 3578) {
  const socket = dgram.createSocket('udp4');
  const MAGIC_COOKIE = 0x2112A442;

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 20) return;

    const msgType = msg.readUInt16BE(0);
    const magic = msg.readUInt32BE(4);

    // Check if it's a STUN Binding Request (0x0001)
    if (msgType === 0x0001 && magic === MAGIC_COOKIE) {
      console.log(`[STUN Server] ⚡ Requisição Binding recebida de ${rinfo.address}:${rinfo.port}`);

      // Transaction ID (12 bytes at offset 8)
      const transactionId = msg.subarray(8, 20);

      // Build STUN Binding Success Response (0x0101)
      // Attribute: XOR-MAPPED-ADDRESS (0x0020), length 8
      const resp = Buffer.alloc(20 + 12);

      // Type: 0x0101
      resp.writeUInt16BE(0x0101, 0);
      // Length of attributes: 12 bytes (4 header + 8 data)
      resp.writeUInt16BE(12, 2);
      // Magic Cookie
      resp.writeUInt32BE(MAGIC_COOKIE, 4);
      // Transaction ID
      transactionId.copy(resp, 8);

      // XOR-MAPPED-ADDRESS Attribute (0x0020)
      let off = 20;
      resp.writeUInt16BE(0x0020, off); off += 2;
      resp.writeUInt16BE(8, off); off += 2;
      resp.writeUInt8(0, off); off += 1; // Reserved
      resp.writeUInt8(1, off); off += 1; // Family: IPv4 (0x01)

      // XOR Port: rinfo.port ^ (MAGIC_COOKIE >> 16)
      const xorPort = rinfo.port ^ (MAGIC_COOKIE >>> 16);
      resp.writeUInt16BE(xorPort, off); off += 2;

      // XOR IP: IP ^ MAGIC_COOKIE
      const ipParts = rinfo.address.split('.').map(Number);
      const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
      const xorIp = (ipNum ^ MAGIC_COOKIE) >>> 0;
      resp.writeUInt32BE(xorIp, off);

      socket.send(resp, rinfo.port, rinfo.address, (err) => {
        if (!err) {
          console.log(`[STUN Server] ✅ Resposta enviada para ${rinfo.address}:${rinfo.port} (Mapeado: ${rinfo.address}:${rinfo.port})`);
        }
      });
    }
  });

  socket.on('error', (err) => {
    console.warn('[STUN Server Error]', err.message);
  });

  socket.bind(port, '0.0.0.0', () => {
    console.log(`[STUN Server] Ativo na porta UDP ${port} (icev720.naxclow.com:${port})`);
  });

  return socket;
}
