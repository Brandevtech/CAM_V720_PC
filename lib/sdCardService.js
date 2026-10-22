/**
 * SD Card Service for V720 / A9 Naxclow Camera
 * Manages microSD card interactions via Naxclow Protocol:
 * - Card detection & status (Code 218 / 410)
 * - Recording dates index (Code 400)
 * - Hourly recordings catalogue XML & minute bitmask parser (Code 402)
 * - Video media metadata (Code 404)
 * - Video stream / download (Code 406)
 * - MicroSD format (Code 207)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

// Ensure recordings folder exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

/**
 * Parses the camera's catalogue XML response into a list of recordings.
 * Uses 64-bit BigInt to decode each hour's 60-minute bitmask (`minBin`).
 */
export function parseCatalogueXml(xmlStr) {
  if (!xmlStr || typeof xmlStr !== 'string') return { date: null, recordings: [] };

  const dateMatch = xmlStr.match(/date=["'](\d+)["']/);
  const date = dateMatch ? dateMatch[1] : null;

  const recordings = [];
  const optionRegex = /<option\s+[^>]*hours=["'](\d+)["'][^>]*minBin=["'](\d+)["'][^>]*\/?>/g;
  let match;

  while ((match = optionRegex.exec(xmlStr)) !== null) {
    const hour = parseInt(match[1], 10);
    const minBinStr = match[2];
    try {
      const minBin = BigInt(minBinStr);
      for (let i = 0n; i < 60n; i++) {
        if ((minBin & (1n << i)) !== 0n) {
          const minute = Number(i);
          const timeFormatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const id = `${date || 'unknown'}-${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}`;
          recordings.push({
            id,
            date,
            hour,
            minute,
            time: timeFormatted,
            fileName: `${date || ''}${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}.avi`
          });
        }
      }
    } catch (e) {
      console.warn('[SD Parser Error minBin]', minBinStr, e.message);
    }
  }

  // Fallback for reversed attribute order (minBin before hours)
  if (recordings.length === 0) {
    const reverseRegex = /<option\s+[^>]*minBin=["'](\d+)["'][^>]*hours=["'](\d+)["'][^>]*\/?>/g;
    while ((match = reverseRegex.exec(xmlStr)) !== null) {
      const minBinStr = match[1];
      const hour = parseInt(match[2], 10);
      try {
        const minBin = BigInt(minBinStr);
        for (let i = 0n; i < 60n; i++) {
          if ((minBin & (1n << i)) !== 0n) {
            const minute = Number(i);
            const timeFormatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            const id = `${date || 'unknown'}-${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}`;
            recordings.push({
              id,
              date,
              hour,
              minute,
              time: timeFormatted,
              fileName: `${date || ''}${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}.avi`
            });
          }
        }
      } catch (e) {}
    }
  }

  // Sort recordings chronologically
  recordings.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

  return { date, recordings };
}

/**
 * Builds a valid standard MJPEG AVI file from an array of JPEG buffers
 */
export function createMjpegAvi(jpegBuffers, width = 640, height = 480, fps = 15) {
  if (!jpegBuffers || jpegBuffers.length === 0) return Buffer.alloc(0);

  const microsecPerFrame = Math.round(1000000 / fps);
  const numFrames = jpegBuffers.length;

  let moviDataSize = 0;
  const frameHeaders = [];
  for (let i = 0; i < numFrames; i++) {
    const rawLen = jpegBuffers[i].length;
    const pad = (rawLen % 2 !== 0) ? 1 : 0;
    frameHeaders.push({ len: rawLen, pad });
    moviDataSize += 8 + rawLen + pad;
  }

  const avihSize = 56;
  const strhSize = 56;
  const strfSize = 40;
  const strlListSize = 4 + (8 + strhSize) + (8 + strfSize);
  const hdrlListSize = 4 + (8 + avihSize) + (8 + strlListSize);
  const idx1Size = 16 * numFrames;
  const riffSize = 4 + (8 + hdrlListSize) + (8 + 4 + moviDataSize) + (8 + idx1Size);

  const buf = Buffer.alloc(8 + riffSize);
  let offset = 0;

  // RIFF AVI
  buf.write('RIFF', offset); offset += 4;
  buf.writeUInt32LE(riffSize, offset); offset += 4;
  buf.write('AVI ', offset); offset += 4;

  // LIST hdrl
  buf.write('LIST', offset); offset += 4;
  buf.writeUInt32LE(hdrlListSize, offset); offset += 4;
  buf.write('hdrl', offset); offset += 4;

  // avih
  buf.write('avih', offset); offset += 4;
  buf.writeUInt32LE(avihSize, offset); offset += 4;
  buf.writeUInt32LE(microsecPerFrame, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0x10, offset); offset += 4; // AVIF_HASINDEX
  buf.writeUInt32LE(numFrames, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(1, offset); offset += 4;
  buf.writeUInt32LE(1024 * 1024, offset); offset += 4;
  buf.writeUInt32LE(width, offset); offset += 4;
  buf.writeUInt32LE(height, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;

  // LIST strl
  buf.write('LIST', offset); offset += 4;
  buf.writeUInt32LE(strlListSize, offset); offset += 4;
  buf.write('strl', offset); offset += 4;

  // strh
  buf.write('strh', offset); offset += 4;
  buf.writeUInt32LE(strhSize, offset); offset += 4;
  buf.write('vids', offset); offset += 4;
  buf.write('MJPG', offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(1, offset); offset += 4;
  buf.writeUInt32LE(fps, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(numFrames, offset); offset += 4;
  buf.writeUInt32LE(1024 * 1024, offset); offset += 4;
  buf.writeInt32LE(-1, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt16LE(width, offset); offset += 2;
  buf.writeUInt16LE(height, offset); offset += 2;

  // strf
  buf.write('strf', offset); offset += 4;
  buf.writeUInt32LE(strfSize, offset); offset += 4;
  buf.writeUInt32LE(strfSize, offset); offset += 4;
  buf.writeInt32LE(width, offset); offset += 4;
  buf.writeInt32LE(height, offset); offset += 4;
  buf.writeUInt16LE(1, offset); offset += 2;
  buf.writeUInt16LE(24, offset); offset += 2;
  buf.write('MJPG', offset); offset += 4;
  buf.writeUInt32LE(width * height * 3, offset); offset += 4;
  buf.writeInt32LE(0, offset); offset += 4;
  buf.writeInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;

  // LIST movi
  const moviOffset = offset;
  buf.write('LIST', offset); offset += 4;
  buf.writeUInt32LE(4 + moviDataSize, offset); offset += 4;
  buf.write('movi', offset); offset += 4;

  const idxEntries = [];
  for (let i = 0; i < numFrames; i++) {
    const frameBuf = jpegBuffers[i];
    const { len, pad } = frameHeaders[i];
    const chunkRelOffset = (offset - moviOffset - 8);

    buf.write('00dc', offset); offset += 4;
    buf.writeUInt32LE(len, offset); offset += 4;
    frameBuf.copy(buf, offset); offset += len;
    if (pad > 0) {
      buf[offset] = 0;
      offset += pad;
    }

    idxEntries.push({ chunkRelOffset, len });
  }

  // idx1
  buf.write('idx1', offset); offset += 4;
  buf.writeUInt32LE(idx1Size, offset); offset += 4;
  for (const entry of idxEntries) {
    buf.write('00dc', offset); offset += 4;
    buf.writeUInt32LE(0x10, offset); offset += 4;
    buf.writeUInt32LE(entry.chunkRelOffset, offset); offset += 4;
    buf.writeUInt32LE(entry.len, offset); offset += 4;
  }

  return buf;
}

/**
 * Returns the list of locally saved .avi video recordings and photos on PC
 */
export function getLocalSavedRecordings() {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];

  const files = fs.readdirSync(RECORDINGS_DIR);
  return files
    .filter(f => f.toLowerCase().endsWith('.avi') || f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'))
    .map(filename => {
      const fullPath = path.join(RECORDINGS_DIR, filename);
      const stat = fs.statSync(fullPath);
      const isVideo = filename.toLowerCase().endsWith('.avi');

      // Extrai a data e hora reais de gravação a partir do nome do arquivo
      // Formato padrão da câmera: YYYYMMDDHHmm.avi (ex: 202610212147.avi -> 21/10/2026, 21:47)
      // Formato DVR / Fotos: DVR_YYYYMMDD_HHmmss.avi ou FOTO_YYYYMMDD_HHmmss.jpg
      let parsedDate = null;
      let dateFormatted = '';

      const camMatch = filename.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
      const dvrMatch = filename.match(/(?:DVR|FOTO)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);

      if (camMatch) {
        const [, y, m, d, h, min] = camMatch;
        parsedDate = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(min, 10));
        dateFormatted = `${d}/${m}/${y}, ${h}:${min}`;
      } else if (dvrMatch) {
        const [, y, m, d, h, min, s] = dvrMatch;
        parsedDate = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(min, 10), parseInt(s, 10));
        dateFormatted = `${d}/${m}/${y}, ${h}:${min}:${s}`;
      } else {
        parsedDate = new Date(stat.mtimeMs);
        dateFormatted = parsedDate.toLocaleString('pt-BR');
      }

      return {
        filename,
        isVideo,
        size: stat.size,
        sizeFormatted: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
        createdAt: parsedDate ? parsedDate.getTime() : stat.mtimeMs,
        dateFormatted
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
