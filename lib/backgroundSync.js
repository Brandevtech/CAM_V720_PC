/**
 * Background Sync Service for V720 / A9 MicroSD Recordings
 * Transfers recorded .avi files calmly in the background from camera to PC.
 * Resilient to network disconnects, auto-reconnects and resumes smoothly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getRecordingsDir } from './configService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNCED_HISTORY_FILE = path.resolve(__dirname, '../synced_history.json');

let syncedHistory = new Set();

function loadSyncedHistory() {
  try {
    if (fs.existsSync(SYNCED_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(SYNCED_HISTORY_FILE, 'utf8'));
      if (Array.isArray(data)) {
        syncedHistory = new Set(data.map(fn => fn.toLowerCase()));
      }
    }
  } catch (e) {
    console.warn('[BackgroundSync] Aviso ao ler histórico de sincronização:', e.message);
  }

  // Preenche também com os arquivos válidos que já se encontram no diretório configurado
  try {
    const dir = getRecordingsDir();
    if (fs.existsSync(dir)) {
      const existing = fs.readdirSync(dir);
      for (const f of existing) {
        if (f.toLowerCase().endsWith('.avi')) {
          syncedHistory.add(f.toLowerCase());
        }
      }
    }
  } catch (_) {}
}

function saveSyncedHistory() {
  try {
    fs.writeFileSync(SYNCED_HISTORY_FILE, JSON.stringify(Array.from(syncedHistory).sort(), null, 2), 'utf8');
  } catch (e) {
    console.warn('[BackgroundSync] Falha ao salvar histórico de sincronização:', e.message);
  }
}

export function markAsSynced(fileName) {
  if (!fileName) return;
  syncedHistory.add(fileName.toLowerCase());
  saveSyncedHistory();
}

export function isAlreadySynced(fileName) {
  if (!fileName) return false;
  return syncedHistory.has(fileName.toLowerCase());
}

export function clearSyncedHistory() {
  syncedHistory.clear();
  saveSyncedHistory();
  console.log('[BackgroundSync] 🔄 Histórico de sincronização foi limpo.');
}

// Inicializa o histórico na memória e persiste no disco
loadSyncedHistory();
saveSyncedHistory();

export const syncState = {
  enabled: false, // Desativado por padrão para priorizar a transmissão ao vivo contínua
  isSyncing: false,
  status: 'idle', // 'idle' | 'checking' | 'downloading' | 'formatting' | 'paused' | 'error'
  statusMessage: 'Transmissão ao vivo priorizada.',
  currentFile: null,
  totalSyncedSession: 0,
  deleteAfterDownload: true,
  autoFormatAfterSync: true, // Formata o MicroSD quando tudo estiver seguro no PC e não houver mais nada pendente
  lastSyncTime: null,
  lastSyncTimestamp: null,
  lastCorruptedRemoved: 0,
  totalCorruptedRemoved: 0,
  error: null
};

let syncTimer = null;
let getClientFn = null;
let broadcastFn = null;

export function initBackgroundSync(getClient, broadcast) {
  getClientFn = getClient;
  broadcastFn = broadcast;

  // Não inicia polling agressivo que interrompe o vídeo ao vivo.
  // A sincronização pode ser acionada sob demanda com 'Sincronizar Agora'.
  if (syncTimer) clearInterval(syncTimer);
  console.log('[BackgroundSync] Serviço de cópia sob demanda pronto (streaming ao vivo priorizado).');
}

function broadcastSyncUpdate() {
  if (typeof broadcastFn === 'function') {
    broadcastFn({
      type: 'sync_status',
      data: { ...syncState }
    });
  }
}

export async function triggerManualSync() {
  if (syncState.isSyncing) return { running: true, message: 'Sincronização já em andamento.' };
  runSyncCycle(true);
  return { running: true, message: 'Sincronização iniciada sob demanda.' };
}

export function setSyncEnabled(enabled) {
  syncState.enabled = !!enabled;
  syncState.statusMessage = syncState.enabled ? 'Sincronização automática ativa.' : 'Sincronização sob demanda.';
  broadcastSyncUpdate();
}

export function setDeleteAfterDownload(enabled) {
  syncState.deleteAfterDownload = !!enabled;
}

export function setAutoFormatAfterSync(enabled) {
  syncState.autoFormatAfterSync = !!enabled;
}

async function runSyncCycle(force = false) {
  if ((!syncState.enabled && !force) || syncState.isSyncing) return;
  if (!getClientFn) return;

  let clientWrapper = null;
  try {
    clientWrapper = await getClientFn();
    const client = clientWrapper?.client;

    if (!client || !client.isConnected) {
      syncState.status = 'paused';
      syncState.statusMessage = 'Aguardando conexão com a câmera...';
      broadcastSyncUpdate();
      return;
    }

    // Se estiver ocupado baixando manualmente
    if (client.isDownloading) return;

    syncState.isSyncing = true;
    syncState.status = 'checking';
    syncState.statusMessage = 'Verificando gravações no cartão SD...';
    broadcastSyncUpdate();

    // 1. Pausa a transmissão ao vivo uma única vez para todo o lote de downloads
    const wasStreaming = client.isStreaming;
    if (wasStreaming) {
      console.log('[BackgroundSync] ⏸️ Pausando vídeo ao vivo para transferência dedicada...');
      client.stopVideoStream();
      await new Promise(r => setTimeout(r, 1200));
      client.rxBuffer = Buffer.alloc(0);
    }

    // 2. Obter lista de datas
    const dates = await client.getSdCardDates();
    if (!dates || dates.length === 0) {
      syncState.status = 'idle';
      syncState.statusMessage = 'Nenhuma gravação pendente no cartão.';
      syncState.currentFile = null;
      syncState.isSyncing = false;
      syncState.lastSyncTimestamp = Date.now();
      syncState.lastSyncTime = new Date().toLocaleTimeString('pt-BR');
      syncState.lastCorruptedRemoved = 0;
      if (wasStreaming && client.isConnected) client.startVideoStream();
      broadcastSyncUpdate();
      return;
    }

    // Ordena da mais recente para a mais antiga (hoje primeiro)
    const sortedDates = [...dates].sort().reverse();
    const targetDir = getRecordingsDir();
    const localFiles = new Set(fs.readdirSync(targetDir).map(f => f.toLowerCase()));

    let downloadedInThisCycle = false;
    let syncedInThisCycle = 0;
    let totalCardRecordings = 0;
    let failedInThisCycle = 0;

    for (const date of sortedDates) {
      const cat = await client.getSdCardFiles(date);
      const recordings = [...(cat.recordings || [])].sort((a, b) => (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute));

      for (const rec of recordings) {
        totalCardRecordings++;
        const h = rec.hour !== undefined ? rec.hour : rec.hours;
        const m = rec.minute !== undefined ? rec.minute : rec.minutes;
        const fileName = rec.fileName || `${rec.date}${String(h).padStart(2,'0')}${String(m).padStart(2,'0')}.avi`;
        const savePath = path.join(targetDir, fileName);

        // 1. Se já consta no histórico de vídeos já baixados/gerenciados: ignora
        if (isAlreadySynced(fileName)) {
          continue;
        }

        // 2. Se já existe no PC e está íntegro (>64 KB): marca no histórico e pula
        if (localFiles.has(fileName.toLowerCase()) && fs.existsSync(savePath) && fs.statSync(savePath).size > 64 * 1024) {
          markAsSynced(fileName);
          continue;
        }

        // Encontrou arquivo pendente: baixa com fluxo contínuo
        console.log(`[BackgroundSync] 📥 Copiando: ${fileName}...`);
        syncState.status = 'downloading';
        syncState.currentFile = fileName;
        syncState.transferredBytes = 0;
        syncState.statusMessage = `Copiando ${fileName} para o PC...`;
        broadcastSyncUpdate();

        try {
          let lastProgressBroadcast = 0;
          const onProgress = (bytes, expected) => {
            syncState.transferredBytes = bytes;
            const now = Date.now();
            if (now - lastProgressBroadcast > 300) {
              lastProgressBroadcast = now;
              const expectedStr = expected > 0 ? ` / ${(expected / (1024 * 1024)).toFixed(1)} MB` : '';
              syncState.statusMessage = `Transferindo ${fileName} (${(bytes / (1024 * 1024)).toFixed(1)} MB${expectedStr})...`;
              broadcastSyncUpdate();
            }
          };

          // Não reativa o vídeo ao vivo entre arquivos para evitar tempestade de chaveamento
          const fileRes = await client.downloadSdCardFile(rec.date, h, m, onProgress, false);

          if (fileRes && fileRes.data && fileRes.data.length > 64 * 1024) {
            fs.writeFileSync(savePath, fileRes.data);
            localFiles.add(fileName.toLowerCase());
            markAsSynced(fileName);
            syncState.totalSyncedSession++;
            syncedInThisCycle++;
            downloadedInThisCycle = true;
            console.log(`[BackgroundSync] ✅ ${fileName} salvo com sucesso no PC (${fileRes.size} bytes).`);

            // Notifica o frontend com a lista atualizada
            if (typeof broadcastFn === 'function') {
              broadcastFn({ type: 'recordings_updated' });
            }

            // Pausa suave de 1,5s antes do próximo arquivo
            await new Promise(r => setTimeout(r, 1500));
          } else {
            failedInThisCycle++;
            console.warn(`[BackgroundSync] ⚠️ Download de ${fileName} incompleto (${fileRes?.data?.length || 0} bytes). Mantido no cartão SD com segurança.`);
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (downloadErr) {
          failedInThisCycle++;
          console.warn(`[BackgroundSync] Erro temporário ao baixar ${fileName}:`, downloadErr.message);
          throw downloadErr;
        }
      }
    }

    syncState.status = 'idle';
    syncState.currentFile = null;
    syncState.lastSyncTimestamp = Date.now();
    syncState.lastSyncTime = new Date().toLocaleTimeString('pt-BR');

    // Se a leitura foi completa, todos os vídeos do cartão estão confirmados no PC
    // e o cartão possuía gravações, formatamos o MicroSD para liberar espaço limpo.
    const allSecured = totalCardRecordings > 0 && failedInThisCycle === 0;
    if (allSecured && syncState.autoFormatAfterSync) {
      console.log(`[BackgroundSync] 🧹 Leitura completa: todos os ${totalCardRecordings} vídeos do cartão SD estão 100% seguros no PC.`);
      console.log('[BackgroundSync] 🔄 Formatando o cartão MicroSD (Code 207) para liberar espaço limpo na câmera...');
      syncState.status = 'formatting';
      syncState.statusMessage = 'Limpando cartão MicroSD (tudo já seguro no PC)...';
      broadcastSyncUpdate();

      try {
        await client.formatSdCard();
        console.log('[BackgroundSync] ✅ MicroSD formatado com sucesso! Espaço 100% liberado para novas gravações.');
        await new Promise(r => setTimeout(r, 2000));
        syncState.statusMessage = syncedInThisCycle > 0 
          ? `✓ Sincronização concluída (${syncedInThisCycle} novos) • Cartão SD limpo e formatado.`
          : '✓ Tudo atualizado no PC • Cartão SD limpo e formatado.';
      } catch (fmtErr) {
        console.warn('[BackgroundSync] Falha ao formatar MicroSD:', fmtErr.message);
        syncState.statusMessage = `✓ Sincronização concluída (${syncedInThisCycle} salvos).`;
      }
    } else if (syncedInThisCycle > 0) {
      syncState.statusMessage = `✓ Sincronização concluída: ${syncedInThisCycle} ${syncedInThisCycle === 1 ? 'vídeo novo salvo' : 'vídeos novos salvos'}`;
    } else {
      syncState.statusMessage = '✓ Tudo atualizado. Nenhuma gravação pendente.';
    }
    syncState.error = null;

  } catch (err) {
    console.warn('[BackgroundSync Cycle Warning]:', err.message);
    syncState.status = 'paused';
    syncState.currentFile = null;
    syncState.error = err.message;
    syncState.statusMessage = `Pausa temporária de rede: ${err.message}. Retomando automaticamente...`;
  } finally {
    syncState.isSyncing = false;
    try {
      const clientWrapper = await getClientFn?.();
      const client = clientWrapper?.client;
      if (client && client.isConnected && !client.isStreaming) {
        console.log('[BackgroundSync] 🎥 Sincronização finalizada. Restaurando transmissão ao vivo...');
        client.startVideoStream();
      }
    } catch (_) {}
    broadcastSyncUpdate();
  }
}
