import dgram from 'dgram';

export function startDnsServer({ targetIp = '192.168.15.5', upstreamDns = '8.8.8.8', upstreamPort = 53 } = {}) {
  const server = dgram.createSocket('udp4');

  function parseDomain(msg) {
    let offset = 12;
    const parts = [];
    while (offset < msg.length) {
      const len = msg[offset++];
      if (len === 0) break;
      if (len > 63 || offset + len > msg.length) return null;
      parts.push(msg.toString('ascii', offset, offset + len));
      offset += len;
    }
    return { domain: parts.join('.').toLowerCase(), endOffset: offset + 4 };
  }

  function createAResponse(msg, targetIpStr) {
    const parsed = parseDomain(msg);
    if (!parsed) return null;

    // Header (12 bytes)
    const res = Buffer.alloc(parsed.endOffset + 16);
    msg.copy(res, 0, 0, parsed.endOffset); // Copy header + question

    // Flags: 0x8180 (Standard query response, No error, Recursion desired + available)
    res.writeUInt16BE(0x8180, 2);
    // QDCOUNT: 1
    res.writeUInt16BE(1, 4);
    // ANCOUNT: 1
    res.writeUInt16BE(1, 6);
    // NSCOUNT: 0
    res.writeUInt16BE(0, 8);
    // ARCOUNT: 0
    res.writeUInt16BE(0, 10);

    // Answer RR
    let off = parsed.endOffset;
    // Name pointer to QNAME (0xc00c)
    res.writeUInt16BE(0xc00c, off); off += 2;
    // Type A (1)
    res.writeUInt16BE(1, off); off += 2;
    // Class IN (1)
    res.writeUInt16BE(1, off); off += 2;
    // TTL: 60s
    res.writeUInt32BE(60, off); off += 4;
    // RDLENGTH: 4
    res.writeUInt16BE(4, off); off += 2;
    // RDATA: IPv4
    const ipParts = targetIpStr.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
      res[off++] = ipParts[i];
    }
    return res;
  }

  server.on('message', (msg, rinfo) => {
    try {
      const parsed = parseDomain(msg);
      if (rinfo.address === '192.168.15.10' || parsed?.domain.includes('naxclow') || parsed?.domain.includes('v720')) {
        console.log(`[DNS Query] ${rinfo.address} perguntou por: ${parsed?.domain}`);
      }
      if (parsed && (parsed.domain.includes('naxclow.com') || parsed.domain.includes('v720') || rinfo.address === '192.168.15.10')) {
        console.log(`[DNS] 🎯 Interceptado: ${parsed.domain} -> ${targetIp} (cliente: ${rinfo.address})`);
        const response = createAResponse(msg, targetIp);
        if (response) {
          server.send(response, rinfo.port, rinfo.address);
          return;
        }
      }

      // Forward everything else to upstream DNS
      const client = dgram.createSocket('udp4');
      client.send(msg, upstreamPort, upstreamDns, (err) => {
        if (err) client.close();
      });
      client.on('message', (reply) => {
        server.send(reply, rinfo.port, rinfo.address);
        client.close();
      });
      client.on('error', () => {
        client.close();
      });
    } catch (e) {
      // Ignore malformed packets
    }
  });

  server.on('error', (err) => {
    console.error('[DNS Error]', err.message);
  });

  server.bind(53, '0.0.0.0', () => {
    console.log(`[DNS Server] Ativo na porta 53 (Redirecionando *.naxclow.com -> ${targetIp}, Upstream: ${upstreamDns})`);
  });

  return server;
}
