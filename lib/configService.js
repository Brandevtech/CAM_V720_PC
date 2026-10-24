import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.resolve(__dirname, '../config.json');
const DEFAULT_RECORDINGS_DIR = path.resolve(__dirname, '../recordings');

let currentConfig = {
  recordingsDir: DEFAULT_RECORDINGS_DIR
};

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data && typeof data.recordingsDir === 'string' && data.recordingsDir.trim()) {
        currentConfig.recordingsDir = path.resolve(data.recordingsDir.trim());
      }
    }
  } catch (err) {
    console.warn('[ConfigService] Erro ao carregar config.json, usando defaults:', err.message);
  }

  // Garante que o diretório configurado exista
  ensureRecordingsDir(currentConfig.recordingsDir);
  return currentConfig;
}

export function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ConfigService] Falha ao salvar config.json:', err.message);
  }
}

export function ensureRecordingsDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    console.warn(`[ConfigService] Não foi possível criar diretório ${dirPath}:`, err.message);
  }
}

export function getRecordingsDir() {
  if (!currentConfig.recordingsDir) {
    currentConfig.recordingsDir = DEFAULT_RECORDINGS_DIR;
  }
  ensureRecordingsDir(currentConfig.recordingsDir);
  return currentConfig.recordingsDir;
}

export function setRecordingsDir(newPath) {
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    throw new Error('O caminho do diretório não pode ser vazio.');
  }

  const resolved = path.resolve(newPath.trim());
  ensureRecordingsDir(resolved);

  // Testa permissão de escrita criando e apagando arquivo temporário de teste
  const testFile = path.join(resolved, `.write_test_${Date.now()}`);
  try {
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (err) {
    throw new Error(`Sem permissão para gravar na pasta selecionada: ${err.message}`);
  }

  currentConfig.recordingsDir = resolved;
  saveConfig();
  console.log(`[ConfigService] 📁 Diretório de gravações alterado com sucesso para: ${resolved}`);
  return resolved;
}

// Inicializa no carregamento do módulo
loadConfig();
