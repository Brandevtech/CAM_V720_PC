/**
 * V720 PC Studio - Painel Simplificado de Página Única
 * - Imagem ao vivo MJPEG direta via WebSocket (Modo AP 192.168.169.1:6123)
 * - Sensibilidade do sensor por detecção de movimento no MicroSD
 * - Cópia e sincronização de vídeos em segundo plano para o PC
 * - Formatação do cartão MicroSD
 */

// Estado da Câmera
let cameraState = {
  ip: '192.168.169.1',
  port: 6123,
  connected: false,
  irLed: false,
  flip: false
};

// Canvas da Câmera Ao Vivo
const canvas = document.getElementById('cameraCanvas');
const ctx = canvas.getContext('2d');
let currentImage = null;
let lastFrameTime = 0;
let currentSyncState = { status: 'idle', currentFile: null, transferredBytes: 0 };

function initCanvasRenderer() {
  function render() {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const liveTimestamp = document.getElementById('liveTimestamp');
    const livePill = document.getElementById('livePill');
    if (liveTimestamp) liveTimestamp.innerText = timeStr;

    ctx.save();
    if (cameraState.flip) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    // Se o player de gravação estiver ativo, desenha o vídeo na janela principal
    if (player.isActive) {
      if (livePill) {
        livePill.innerHTML = '<span class="rec-dot" style="background:#ff9100; box-shadow:0 0 8px #ff9100;"></span> REPRODUÇÃO';
      }
      if (liveTimestamp) {
        liveTimestamp.innerText = player.currentFilename || 'Gravação';
      }

      const img = player.currentImage;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#0b0f19';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#00e5ff';
        ctx.font = 'bold 16px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`CARREGANDO GRAVAÇÃO: ${player.currentFilename || ''}`, canvas.width / 2, canvas.height / 2);
        ctx.textAlign = 'left';
      }
    } else if (currentSyncState.status === 'downloading') {
      const mb = currentSyncState.transferredBytes 
        ? (currentSyncState.transferredBytes / (1024 * 1024)).toFixed(1) + ' MB'
        : 'Iniciando...';

      ctx.fillStyle = '#0b0f19';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#00e5ff';
      ctx.font = 'bold 20px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📥 TRANSFERINDO DO CARTÃO SD', canvas.width / 2, canvas.height / 2 - 32);

      ctx.font = 'bold 15px "JetBrains Mono", monospace';
      ctx.fillStyle = '#f0f4fc';
      ctx.fillText(currentSyncState.currentFile || 'Copiando arquivo...', canvas.width / 2, canvas.height / 2 + 2);

      ctx.font = '14px "JetBrains Mono", monospace';
      ctx.fillStyle = '#00e676';
      ctx.fillText(`Progresso: ${mb} recebidos`, canvas.width / 2, canvas.height / 2 + 32);

      ctx.font = '12px "Outfit", sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillText('Vídeo ao vivo pausado para dedicar 100% da conexão TCP à cópia.', canvas.width / 2, canvas.height / 2 + 62);

      if (currentSyncState.lastCorruptedRemoved > 0) {
        ctx.font = 'bold 12px "JetBrains Mono", monospace';
        ctx.fillStyle = '#ff5252';
        ctx.fillText(`🧹 ${currentSyncState.lastCorruptedRemoved} fragmento(s) corrompido(s) removido(s)`, canvas.width / 2, canvas.height / 2 + 84);
      }
      ctx.textAlign = 'left';

      if (livePill) {
        livePill.innerHTML = '<span class="rec-dot" style="background:#00e5ff; box-shadow:0 0 8px #00e5ff;"></span> TRANSFERINDO';
      }
    } else {
      if (livePill && livePill.innerText !== 'AO VIVO') {
        livePill.innerHTML = '<span class="rec-dot"></span> AO VIVO';
      }

      if (currentImage && (Date.now() - lastFrameTime < 8000)) {
        ctx.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
      } else {
        // Estado de espera (câmera desconectada ou reconectando)
        ctx.fillStyle = '#0b0f19';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#00e5ff';
        ctx.font = 'bold 18px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('AGUARDANDO TRANSMISSÃO DA CÂMERA', canvas.width / 2, canvas.height / 2 - 10);
        ctx.font = '13px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillText(`Conectado ao Wi-Fi Nax_... (192.168.169.1:6123)`, canvas.width / 2, canvas.height / 2 + 18);
        ctx.textAlign = 'left';
      }
    }

    ctx.restore();
    requestAnimationFrame(render);
  }
  render();
}

// WebSocket para Streaming e Sincronização
let ws = null;
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    updateStatusBadge(true);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'frame' || msg.type === 'cloud_frame') {
        const img = new Image();
        img.onload = () => {
          currentImage = img;
          lastFrameTime = Date.now();
        };
        const src = typeof msg.data === 'string' && msg.data.startsWith('data:') 
          ? msg.data 
          : `data:image/jpeg;base64,${msg.data}`;
        img.src = src;
        updateStatusBadge(true);
      } else if (msg.type === 'status' || msg.type === 'local_status') {
        const state = msg.cameraState || msg.data;
        if (state) {
          cameraState.connected = state.connected !== false;
          cameraState.irLed = !!state.irLed;
          cameraState.flip = !!state.flip;
          if (state.motionGrade) {
            const sel = document.getElementById('selectMotionSensitivity');
            if (sel) sel.value = String(state.motionGrade);
          }
          updateStatusBadge(cameraState.connected);
        }
      } else if (msg.type === 'sync_status') {
        updateSyncUI(msg.data);
      } else if (msg.type === 'recordings_updated') {
        loadSavedRecordings();
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    updateStatusBadge(false);
    setTimeout(initWebSocket, 3000);
  };

  ws.onerror = () => {
    updateStatusBadge(false);
  };
}

function updateStatusBadge(isOnline) {
  const badge = document.getElementById('cameraStatusBadge');
  const txt = document.getElementById('cameraStatusText');
  if (!badge || !txt) return;

  if (isOnline) {
    badge.style.borderColor = 'rgba(0, 230, 118, 0.4)';
    badge.querySelector('.status-dot').style.backgroundColor = '#00e676';
    badge.querySelector('.status-dot').style.boxShadow = '0 0 8px #00e676';
    txt.innerText = 'Câmera Conectada (192.168.169.1)';
  } else {
    badge.style.borderColor = 'rgba(255, 23, 68, 0.4)';
    badge.querySelector('.status-dot').style.backgroundColor = '#ff1744';
    badge.querySelector('.status-dot').style.boxShadow = '0 0 8px #ff1744';
    txt.innerText = 'Aguardando Câmera (Desconectada)';
  }
}

// Controles da Câmera
function setupEvents() {
  // 1. Escolha de Sensibilidade de Movimento para gravação no MicroSD
  const selSensitivity = document.getElementById('selectMotionSensitivity');
  selSensitivity?.addEventListener('change', async () => {
    const grade = parseInt(selSensitivity.value, 10);
    const feedback = document.getElementById('sdFeedbackMsg');
    try {
      if (feedback) {
        feedback.innerText = 'Gravando sensibilidade na câmera...';
        feedback.style.display = 'block';
        feedback.style.color = '#00e5ff';
      }
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'motion_sensitivity', grade })
      });
      if (feedback) {
        feedback.innerText = `✓ Sensibilidade Nível ${grade} ativada no cartão MicroSD`;
        feedback.style.color = '#00e676';
        setTimeout(() => { feedback.style.display = 'none'; }, 4000);
      }
    } catch (err) {
      if (feedback) {
        feedback.innerText = `Erro ao alterar sensibilidade: ${err.message}`;
        feedback.style.color = '#ff1744';
      }
    }
  });

  // 7. Botão Sincronizar Agora
  document.getElementById('btnSyncNow')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSyncNow');
    btn.disabled = true;
    btn.innerText = 'Verificando...';
    try {
      await fetch('/api/sync/trigger', { method: 'POST' });
    } catch (e) {}
    setTimeout(() => {
      btn.disabled = false;
      btn.innerText = 'Sincronizar Agora';
    }, 2000);
  });

  // 9. Selecionar Todos os Vídeos
  document.getElementById('chkSelectAllFiles')?.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.file-chk');
    checkboxes.forEach(chk => { chk.checked = e.target.checked; });
    updateSelectionState();
  });

  // 10. Excluir Vídeos Selecionados (sem confirmação)
  document.getElementById('btnDeleteSelected')?.addEventListener('click', () => {
    window.deleteSelectedVideos();
  });
}

// Formatação de tempo decorrido desde a última sincronização
function formatElapsedTime(timestamp) {
  if (!timestamp) return 'nenhuma recente';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 5) return 'agora mesmo';
  if (diffSec < 60) return `há ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHour = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `há ${diffHour}h ${remMin}m`;
}

function updateSyncElapsedLabel() {
  const el = document.getElementById('syncElapsedTime');
  if (!el) return;
  if (!currentSyncState?.lastSyncTimestamp) {
    el.innerText = 'Última sincronização: nenhuma recente';
    return;
  }
  const timeFormatted = currentSyncState.lastSyncTime || new Date(currentSyncState.lastSyncTimestamp).toLocaleTimeString('pt-BR');
  el.innerText = `Última sincronização: ${formatElapsedTime(currentSyncState.lastSyncTimestamp)} (${timeFormatted})`;
}

// Atualização de UI de Sincronização em Segundo Plano
function updateSyncUI(syncData) {
  if (!syncData) return;
  currentSyncState = syncData;
  const badge = document.getElementById('syncStatusBadge');
  const detail = document.getElementById('syncDetailMsg');
  const corruptedBadge = document.getElementById('syncCorruptedBadge');

  // Atualiza badge com a contagem de arquivos corrompidos removidos
  if (corruptedBadge) {
    const corruptedCount = syncData.lastCorruptedRemoved !== undefined 
      ? syncData.lastCorruptedRemoved 
      : (syncData.totalCorruptedRemoved || 0);

    if (corruptedCount > 0) {
      corruptedBadge.style.display = 'inline-block';
      corruptedBadge.style.background = 'rgba(255, 82, 82, 0.15)';
      corruptedBadge.style.color = '#ff5252';
      corruptedBadge.style.borderColor = 'rgba(255, 82, 82, 0.3)';
      corruptedBadge.innerText = `🧹 ${corruptedCount} ${corruptedCount === 1 ? 'corrompido removido' : 'corrompidos removidos'}`;
    } else if (syncData.lastSyncTimestamp) {
      corruptedBadge.style.display = 'inline-block';
      corruptedBadge.style.background = 'rgba(0, 230, 118, 0.1)';
      corruptedBadge.style.color = '#00e676';
      corruptedBadge.style.borderColor = 'rgba(0, 230, 118, 0.2)';
      corruptedBadge.innerText = `✓ 0 corrompidos`;
    } else {
      corruptedBadge.style.display = 'none';
    }
  }

  updateSyncElapsedLabel();

  if (syncData.status === 'downloading') {
    const mb = syncData.transferredBytes ? (syncData.transferredBytes / (1024 * 1024)).toFixed(1) : '0.0';
    if (badge) {
      badge.style.color = '#00e5ff';
      badge.innerText = `⏳ Copiando ${syncData.currentFile || 'vídeo'} (${mb} MB)...`;
    }
    if (detail) detail.innerText = `Transferindo do cartão MicroSD para o computador via TCP dedicado...`;
  } else if (syncData.status === 'checking') {
    if (badge) {
      badge.style.color = '#00e5ff';
      badge.innerText = '🔍 Verificando cartão MicroSD...';
    }
    if (detail) detail.innerText = 'Buscando novas gravações no cartão...';
  } else if (syncData.status === 'paused') {
    if (badge) {
      badge.style.color = '#ff9100';
      badge.innerText = 'Aguardando câmera...';
    }
    if (detail) detail.innerText = syncData.statusMessage || 'A conexão será retomada automaticamente.';
  } else {
    if (badge) {
      badge.style.color = '#00e676';
      badge.innerText = syncData.statusMessage || '✓ Vídeo ao vivo contínuo';
    }
    if (detail) detail.innerText = `Clique em "Sincronizar Agora" para descarregar novos vídeos do cartão.`;
  }
}

// Lista de Gravações Salvas no PC
async function loadSavedRecordings() {
  const container = document.getElementById('localFilesList');
  const countBadge = document.getElementById('localFilesCount');
  const chkAll = document.getElementById('chkSelectAllFiles');
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');
  if (!container) return;

  try {
    const res = await fetch('/api/sd/local-recordings');
    const data = await res.json();
    const files = Array.isArray(data) ? data : (data.files || []);

    if (countBadge) countBadge.innerText = `${files.length} vídeos`;
    if (chkAll) chkAll.checked = false;
    if (btnDeleteSelected) btnDeleteSelected.style.display = 'none';

    if (!files || files.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 30px 10px; color: var(--text-muted); font-size: 0.85rem;">
          Nenhum vídeo salvo no computador ainda.<br>
          <span style="font-size: 0.78rem;">Os vídeos gravados no cartão pela câmera são copiados automaticamente para cá em segundo plano.</span>
        </div>
      `;
      return;
    }

    container.innerHTML = files.map(file => {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      return `
        <div class="file-item-clean" data-filename="${file.filename}">
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="checkbox" class="file-chk" value="${file.filename}" style="accent-color: #00e5ff; cursor: pointer; width: 16px; height: 16px;">
            <div>
              <div style="font-size: 0.82rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: #f0f4fc;">
                🎥 ${file.filename}
              </div>
              <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">
                ${file.dateFormatted || 'Gravação'} • ${sizeMb} MB
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn btn-primary btn-sm" onclick="playSavedVideo('${file.filename}')" style="padding: 4px 8px; font-size: 0.75rem;">
              ▶ Assistir
            </button>
            <a href="/api/sd/play/${encodeURIComponent(file.filename)}" download class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 0.75rem;">
              💾 Baixar
            </a>
            <button class="btn btn-danger btn-sm" onclick="deleteLocalVideo('${file.filename}')" style="padding: 4px 8px; font-size: 0.75rem;" title="Excluir vídeo do PC">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Listener para checkboxes individuais
    const checkboxes = container.querySelectorAll('.file-chk');
    checkboxes.forEach(chk => {
      chk.addEventListener('change', updateSelectionState);
    });

  } catch (err) {
    container.innerHTML = `<div style="color: #ff1744; font-size: 0.8rem; padding: 10px;">Erro ao carregar gravações: ${err.message}</div>`;
  }
}

function updateSelectionState() {
  const checkboxes = document.querySelectorAll('.file-chk');
  const checked = document.querySelectorAll('.file-chk:checked');
  const btnDeleteSelected = document.getElementById('btnDeleteSelected');
  const countText = document.getElementById('selectedCountText');
  const chkAll = document.getElementById('chkSelectAllFiles');

  if (countText) countText.innerText = checked.length;
  if (btnDeleteSelected) {
    btnDeleteSelected.style.display = checked.length > 0 ? 'inline-flex' : 'none';
  }
  if (chkAll) {
    chkAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
  }
}

// Excluir vídeo individual do PC sem confirmação
window.deleteLocalVideo = async function(filename) {
  try {
    const res = await fetch(`/api/sd/local/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      if (player.currentFilename === filename) {
        stopAndClosePlayer();
      }
      loadSavedRecordings();
    }
  } catch (err) {
    console.error('Erro ao excluir vídeo:', err);
  }
};

// Excluir múltiplos vídeos selecionados sem confirmação
window.deleteSelectedVideos = async function() {
  const checked = document.querySelectorAll('.file-chk:checked');
  const filenames = Array.from(checked).map(c => c.value);
  if (filenames.length === 0) return;

  try {
    const res = await fetch('/api/sd/local-batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames })
    });
    const data = await res.json();
    if (data.success) {
      if (filenames.includes(player.currentFilename)) {
        stopAndClosePlayer();
      }
      loadSavedRecordings();
    }
  } catch (err) {
    console.error('Erro ao excluir vídeos selecionados:', err);
  }
};

// Player Unificado na Janela Principal de Vídeo (cameraCanvas)
const player = {
  isActive: false,
  frames: [],
  currentIndex: 0,
  currentImage: null,
  currentFilename: '',
  isPlaying: false,
  timer: null,
  fps: 15,
  loadedImages: []
};

function initPlayer() {
  document.getElementById('btnPlayerPlayPause')?.addEventListener('click', () => {
    if (player.isPlaying) pausePlayer();
    else startPlayer();
  });

  document.getElementById('playerTimeline')?.addEventListener('input', (e) => {
    pausePlayer();
    renderPlayerFrame(parseInt(e.target.value, 10));
  });

  document.getElementById('btnClosePlayer')?.addEventListener('click', () => {
    stopAndClosePlayer();
  });
}

function stopAndClosePlayer() {
  pausePlayer();
  player.isActive = false;
  player.frames = [];
  player.currentImage = null;
  player.currentFilename = '';
  player.loadedImages = [];
  const bar = document.getElementById('playerControlBar');
  if (bar) bar.style.display = 'none';
}

function startPlayer() {
  if (player.frames.length === 0) return;
  player.isPlaying = true;
  const btn = document.getElementById('btnPlayerPlayPause');
  if (btn) btn.innerText = '⏸️ Pausar';

  if (player.timer) clearInterval(player.timer);
  player.timer = setInterval(() => {
    if (player.currentIndex >= player.frames.length - 1) {
      player.currentIndex = 0;
    } else {
      player.currentIndex++;
    }
    renderPlayerFrame(player.currentIndex, true);
  }, 1000 / player.fps);
}

function pausePlayer() {
  player.isPlaying = false;
  if (player.timer) {
    clearInterval(player.timer);
    player.timer = null;
  }
  const btn = document.getElementById('btnPlayerPlayPause');
  if (btn) btn.innerText = '▶️ Play';
}

function renderPlayerFrame(idx, updateTimeline = true) {
  if (!player.frames[idx]) return;
  player.currentIndex = idx;

  let img = player.loadedImages[idx];
  if (!img) {
    img = new Image();
    img.src = player.frames[idx];
    player.loadedImages[idx] = img;
  }
  player.currentImage = img;

  const timeline = document.getElementById('playerTimeline');
  if (timeline && updateTimeline) timeline.value = idx;

  const timeLabel = document.getElementById('playerTimeLabel');
  if (timeLabel) {
    const curSec = Math.floor(idx / player.fps);
    const totalSec = Math.floor(player.frames.length / player.fps);
    const format = (s) => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    timeLabel.innerText = `${format(curSec)} / ${format(totalSec)}`;
  }
}

window.playSavedVideo = async function(filename) {
  const bar = document.getElementById('playerControlBar');
  const title = document.getElementById('playerVideoTitle');
  const downloadLink = document.getElementById('playerDownloadBtn');
  const timeline = document.getElementById('playerTimeline');

  pausePlayer();
  player.isActive = true;
  player.currentFilename = filename;
  player.currentImage = null;

  if (bar) bar.style.display = 'flex';
  if (title) title.innerText = `Carregando ${filename}...`;
  if (downloadLink) downloadLink.href = `/api/sd/play/${encodeURIComponent(filename)}`;

  // Scroll suave para a janela de vídeo principal
  document.getElementById('videoWrapper')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const res = await fetch(`/api/sd/frames/${encodeURIComponent(filename)}`);
    const data = await res.json();

    if (!data.frames || data.frames.length === 0) {
      if (title) title.innerText = `Vídeo sem quadros válidos: ${filename}`;
      return;
    }

    if (title) title.innerText = filename;
    player.frames = data.frames;
    player.fps = data.fps || 15;
    player.currentIndex = 0;
    player.loadedImages = new Array(data.frames.length);

    if (timeline) {
      timeline.min = 0;
      timeline.max = data.frames.length - 1;
      timeline.value = 0;
    }

    renderPlayerFrame(0);
    startPlayer();
  } catch (err) {
    if (title) title.innerText = `Erro ao carregar vídeo: ${err.message}`;
  }
};

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  initCanvasRenderer();
  initPlayer();
  initWebSocket();
  setupEvents();
  loadSavedRecordings();

  // Consulta periódica do status de sincronização e arquivos
  setInterval(() => {
    fetch('/api/sync/status')
      .then(r => r.json())
      .then(d => { if (d.success) updateSyncUI(d); })
      .catch(() => {});
  }, 6000);

  // Atualiza dinamicamente o contador de tempo decorrido a cada segundo
  setInterval(updateSyncElapsedLabel, 1000);
});
