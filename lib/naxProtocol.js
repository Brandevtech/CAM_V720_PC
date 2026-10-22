/**
 * NaxProtocol Implementation
 * Reverse engineered from com.naxclow.v720 (classes6.dex & libnax-nano-rtsp.so)
 *
 * 16-Byte Header Format:
 * [0]     version (uint8)   - 0 (VERSION_DEFAULT) or 1 (VERSION_V1)
 * [1-2]   hType   (uint16 BE) - 0: JSON, 50: Picture, 51: Audio, 52: MediaFile, 100: Ping, 101: Pong
 * [3]     flag    (uint8)   - 0: Single, 250: Begin, 251: Slice, 252: End, 255: Error
 * [4-7]   mediaId (int32 BE)  - stream/media identifier
 * [8-11]  frameLen(int32 BE)  - total frame length across slices
 * [12-15] dataLen (int32 BE)  - payload length in current packet
 * [16..]  data    (bytes)   - payload
 */

export const CONSTANTS = {
  HEADER_LENGTH: 16,
  VERSION_DEFAULT: 0,
  VERSION_V1: 1,

  // Message Types (hType)
  HTYPE_JSON: 0,
  HTYPE_PICTURE: 50,
  HTYPE_AUDIO: 51,
  HTYPE_MEDIA_FILE: 52,
  HTYPE_PING: 100,
  HTYPE_PONG: 101,

  // Fragmentation Flags (flag)
  FLAG_SINGLE_PACKAGE: 0,
  FLAG_PACKAGE_BEGIN: 250,  // 0xFA
  FLAG_PACKAGE_SLICE: 251,  // 0xFB
  FLAG_PACKAGE_END: 252,    // 0xFC
  FLAG_PACKAGE_ERROR: 255,  // 0xFF

  // Error Codes
  ERROR_CODE_NO_ERR: 0,
  ERROR_CODE_DEV_BASE: 1000,
  ERROR_CODE_TOTAL_LEN: 1001,
  ERROR_CODE_PACKAGE: 1002,
  ERROR_CODE_UNKNOWN_HTYPE: 1003,
  ERROR_CODE_UNKNOWN_FLAG: 1004,
  ERROR_CODE_SYS_BASE: 10000,
  ERROR_CODE_FILE_NOT_EXIST: 10001,
  ERROR_CODE_WRITE_DATA: 10002,
  ERROR_CODE_FILE_LENGTH_CHECK: 10003
};

/**
 * Encodes a NaxProtocol packet
 */
export function encodePacket({
  version = CONSTANTS.VERSION_DEFAULT,
  hType = CONSTANTS.HTYPE_JSON,
  flag = CONSTANTS.FLAG_SINGLE_PACKAGE,
  mediaId = 0,
  frameLen = 0,
  data = Buffer.alloc(0)
}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const dataLen = payload.length;
  const totalFrameLen = frameLen || dataLen;

  const header = Buffer.alloc(CONSTANTS.HEADER_LENGTH);
  header.writeUInt8(version, 0);
  header.writeUInt16BE(hType, 1);
  header.writeUInt8(flag, 3);
  header.writeInt32BE(mediaId, 4);
  header.writeInt32BE(totalFrameLen, 8);
  header.writeInt32BE(dataLen, 12);

  return Buffer.concat([header, payload]);
}

/**
 * Decodes a NaxProtocol packet from a buffer
 */
export function decodePacket(buffer) {
  if (!buffer || buffer.length < CONSTANTS.HEADER_LENGTH) {
    return null;
  }

  const version = buffer.readUInt8(0);
  const hType = buffer.readUInt16BE(1);
  const flag = buffer.readUInt8(3);
  const mediaId = buffer.readInt32BE(4);
  const frameLen = buffer.readInt32BE(8);
  const dataLen = buffer.readInt32BE(12);

  if (buffer.length < CONSTANTS.HEADER_LENGTH + dataLen) {
    return null; // Incomplete packet
  }

  const payload = buffer.subarray(CONSTANTS.HEADER_LENGTH, CONSTANTS.HEADER_LENGTH + dataLen);

  let json = null;
  if (hType === CONSTANTS.HTYPE_JSON) {
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch (e) {
      json = { raw: payload.toString('utf8') };
    }
  }

  return {
    version,
    hType,
    flag,
    mediaId,
    frameLen,
    dataLen,
    payload,
    json,
    totalPacketSize: CONSTANTS.HEADER_LENGTH + dataLen
  };
}

/**
 * Creates JSON RPC command packet
 */
export function createJsonCommand(cmdObject, mediaId = 0) {
  const jsonStr = JSON.stringify(cmdObject);
  return encodePacket({
    hType: CONSTANTS.HTYPE_JSON,
    flag: CONSTANTS.FLAG_SINGLE_PACKAGE,
    mediaId,
    data: Buffer.from(jsonStr, 'utf8')
  });
}

/**
 * Creates Heartbeat Ping packet
 */
export function createPing(mediaId = 0) {
  return encodePacket({
    hType: CONSTANTS.HTYPE_PING,
    flag: CONSTANTS.FLAG_SINGLE_PACKAGE,
    mediaId
  });
}

/**
 * Stream reassembler for fragmented multi-packet frames
 */
export class PacketReassembler {
  constructor() {
    this.frames = new Map(); // mediaId -> { chunks: [], totalLen, receivedLen }
  }

  feed(packet) {
    if (packet.flag === CONSTANTS.FLAG_SINGLE_PACKAGE) {
      return {
        completed: true,
        hType: packet.hType,
        mediaId: packet.mediaId,
        data: packet.payload,
        json: packet.json
      };
    }

    let frame = this.frames.get(packet.mediaId);
    if (!frame || packet.flag === CONSTANTS.FLAG_PACKAGE_BEGIN) {
      frame = {
        hType: packet.hType,
        totalLen: packet.frameLen,
        chunks: [],
        receivedLen: 0
      };
      this.frames.set(packet.mediaId, frame);
    }

    frame.chunks.push(packet.payload);
    frame.receivedLen += packet.dataLen;

    if (packet.flag === CONSTANTS.FLAG_PACKAGE_END || frame.receivedLen >= frame.totalLen) {
      const fullBuffer = Buffer.concat(frame.chunks);
      this.frames.delete(packet.mediaId);

      let json = null;
      if (frame.hType === CONSTANTS.HTYPE_JSON) {
        try {
          json = JSON.parse(fullBuffer.toString('utf8'));
        } catch (e) {
          json = { raw: fullBuffer.toString('utf8') };
        }
      }

      return {
        completed: true,
        hType: frame.hType,
        mediaId: packet.mediaId,
        data: fullBuffer,
        json
      };
    }

    return { completed: false, mediaId: packet.mediaId, progress: frame.receivedLen / frame.totalLen };
  }
}
