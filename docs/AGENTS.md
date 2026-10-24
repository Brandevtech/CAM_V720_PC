# Diretrizes Obrigatórias do Projeto - Câmera V720 / A9

Este arquivo define as regras arquiteturais e restrições técnicas permanentes para qualquer agente que atue neste workspace.

---

## 1. Modo de Operação Obrigatório: Modo AP Direto (TCP 192.168.169.1:6123)

* **A câmera DEVE operar estritamente em Modo AP Direto** (`192.168.169.1:6123`), conectada via dongle Wi-Fi do PC ao SSID `Nax_5c0006004882`.
* O painel web de controle e DVR local roda em `http://localhost:3000` via servidor [`v720-pc`](s:/DEVELOPER/ANDROID/v720-pc).
* Neste modo, o streaming MJPEG (640x480 @ 10 FPS), os comandos PTZ/IR/Flip e a leitura/download do cartão MicroSD (Códigos 218, 400, 402, 406) funcionam nativamente via socket TCP local sem nenhuma dependência de internet.

---

## 2. Regra Inviolável: NUNCA Mais Tentar Configurar Modo STA (Roteador Residencial)

**É expressamente proibido propor ou tentar migrar a câmera para o Modo STA (cliente do roteador).** Esta decisão foi consolidada após extensos testes de engenharia reversa:

1. **Zero Portas TCP em STA:** Varredura completa de portas (1 a 15000) no IP residencial (`192.168.15.10`) confirmou `Open ports: []`. A câmera fecha a porta TCP 6123 e rejeita qualquer conexão de entrada direta (`ECONNREFUSED`).
2. **Dependência Inflexível da Nuvem Chinesa:** No modo STA, o vídeo exige autenticação dinâmica e túnel WebRTC/ICE da Alibaba Cloud (`v720.p2p.naxclow.com` / `120.76.54.172`). A sinalização UDP local não se sustenta sem os servidores centrais.
3. **Inviabilidade de Intercepção DNS:** Fazer o roteador residencial (Vivo Fibra) apontar o DNS primário para o PC gera lentidão/timeouts na navegação de toda a casa quando o PC desliga e sofre bypass para a China se houver DNS secundário (`8.8.8.8`).
4. **Sem Filtro MAC:** O roteador da Vivo não possui filtro MAC manual na interface Web.
5. **Inutilidade de Hotspot no PC:** Usar o PC como hotspot para a câmera em STA mantém as portas TCP fechadas do mesmo modo.

---

## 3. Comportamento do Firmware A9 em Quedas de Energia e Procedimento Padrão

* **Máquina de Estados dos LEDs:**
  * **Piscando rápido:** Modo AP ativo (emitindo rede `Nax_...`).
  * **Piscando lentamente:** Modo STA em loop infinito de busca de SSID.
  * **Fixo aceso:** Conectado à rede.
* **Ausência de Fallback:** O firmware da A9 **NÃO** possui temporizador de contingência. Se houver qualquer rede salva na flash (mesmo fictícia), ela dá boot como cliente STA e fica em busca eterna (LED lento), sem nunca voltar para AP sozinha.
* **Procedimento Operacional Padrão pós-Queda de Energia:**
  1. O usuário pressiona o botão físico **RESET / MODE** na câmera por 5 a 8 segundos (até o LED piscar rápido).
  2. O dongle Wi-Fi do PC conecta automaticamente à rede `Nax_5c0006004882`.
  3. O backend `v720-pc` reconecta ao socket `192.168.169.1:6123` e o vídeo é restabelecido em `http://localhost:3000`.
* **Solução Definitiva sem Reset:** Uso de bateria intermediária (Mini-UPS 5V ou Power Bank USB com pass-through) para evitar que a câmera sofra corte de energia.

---

## 4. Prioridade do Vídeo Ao Vivo e Sincronização Sob Demanda do MicroSD

* **Canal Único TCP:** A câmera A9 possui apenas um socket TCP aberto (`192.168.169.1:6123`) com largura de banda de ~1 Mbps e processador modesto (~200MHz, 8-16MB RAM).
* **Proibido Polling Automático Contínuo:** É proibido rodar loops automatizados contínuos de download de arquivos do SD enquanto o vídeo ao vivo está ativo.
  * O chaveamento repetido entre `CLOSE_V` e `START_STREAM` interrompe o streaming ao vivo e força o encoder da câmera a abortar e reiniciar a gravação contínua no cartão físico (gerando clipes corrompidos/picados de 4 segundos).
* **Modo Operacional Correto:** O vídeo ao vivo opera contínuo com prioridade primária. A sincronização de vídeos do cartão MicroSD para o PC ocorre **sob demanda** (ao clicar em "Sincronizar Agora").
* **Validação de Integridade e Histórico Persistente:** Arquivos baixados menores que 64 KB ou truncados jamais devem ser gravados como válidos. O firmware da câmera A9 em Modo AP Direto ignora comandos de exclusão individual (`Code 412`), mantendo gravação circular contínua por hardware (sobrescrevendo os blocos mais antigos automaticamente quando o cartão enche). Para evitar que vídeos já copiados para o PC ou excluídos pelo usuário sejam rebaixados a cada sincronização, o sistema utiliza um histórico persistente em `synced_history.json`. Formatação completa do cartão físico é realizada via `Code 207`.

---

## 5. Protocolo de Download do Cartão SD e Cuidados Críticos de Hardware

Extensos testes de engenharia reversa consolidaram as seguintes regras vitais para a transferência de arquivos `.avi` do cartão SD:

1. **Drenagem Obrigatória de Hardware (1.200ms) pós-`CLOSE_V`:**
   * Ao pausar o vídeo ao vivo (`CLOSE_V`), o sensor óptico e a DMA de captura levam até 1.200ms para descarregar os quadros JPEG pendentes.
   * Se o `Code 406` (`START_STREAM`) for enviado antes de 1.200ms, ocorre **conflito interno de DMA** entre a captura e o leitor SPI da flash. A câmera envia apenas o cabeçalho RIFF (1 bloco de 7.168 bytes) e trava a transmissão.
   * **Regra:** Sempre aguardar $\ge$ 1.200ms após `CLOSE_V` e zerar o `rxBuffer` antes de enviar o `Code 406`.
2. **Ciclo PING/PONG Obrigatório (`cmd 101` $\rightarrow$ `102`):**
   * Durante o streaming do arquivo AVI (`cmd 7`), a câmera envia pacotes periódicos de checagem `cmd 101` (`P2P_UDP_CMD_PING`).
   * O cliente DEVE responder imediatamente com `cmd 102` (`P2P_UDP_CMD_PONG`). Sem essa resposta, a câmera bloqueia o envio dos blocos subsequentes.
3. **Timeouts da Flash e Encerramento via `Code 411`:**
   * As buscas de clusters FAT na flash SPI podem levar de 1 a 3 segundos entre blocos. O timeout ocioso do cliente deve ser de pelo menos **8.000ms a 10.000ms**.
   * O encerramento normal da transferência deve aguardar o pacote JSON `code: 411` emitido pela câmera (que informa o `fileSize` total transferido).
4. **Metadados e Timestamp Real:**
   * A câmera grava arquivos com nome no padrão `YYYYMMDDHHmm.avi` (ex: `202610221846.avi`).
   * Metadados e tamanho exato na flash podem ser pré-consultados via `Code 404` (`MEDIA_INFO`), respondido com `Code 405`.
   * A data e hora exibidas na interface e ordenadas no histórico devem sempre ser derivadas do nome do arquivo (`YYYYMMDDHHmm`), nunca do `mtime` de criação no disco do PC.
5. **Player Unificado:**
   * A reprodução de vídeos baixados utiliza a mesma janela de transmissão principal (`#cameraCanvas`), com a tag `📼 REPRODUÇÃO` e a barra de controles dedicada posicionada logo abaixo da tela.
