# CAM_V720_PC

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-68a063?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Protocol-Reverse_Engineered-00e5ff?style=for-the-badge&logo=wireshark&logoColor=white" alt="Protocol" />
  <img src="https://img.shields.io/badge/Privacy-100%25_Offline_Local-00e676?style=for-the-badge" alt="Local Only" />
  <img src="https://img.shields.io/badge/License-MIT-ff9100?style=for-the-badge" alt="License" />
</p>

> **Central de Controle Local, Streaming Ao Vivo, DVR e Sincronização de MicroSD para Câmeras V720 / Mini Câmeras A9 (Chipset e Protocolo Naxclow).**
> Operação 100% local, autônoma e privada — sem nuvem chinesa, sem mensalidades e sem dependência de internet.

---

## 📹 Visão Geral

As mini-câmeras A9 e modelos compatíveis com o aplicativo móvel **V720** (fabricante **Naxclow**) são amplamente populares pelo seu custo acessível, mas possuem severas limitações no ecossistema original: dependência de servidores P2P estrangeiros, instabilidade e ausência de um cliente para computador.

O **CAM_V720_PC** foi desenvolvido através de engenharia reversa profunda do protocolo binário TCP/UDP e do APK oficial (`com.naxclow.v720`), entregando um painel web completo e moderno rodando localmente no seu computador.

```mermaid
flowchart LR
    CAM["📷 Câmera A9 / V720<br>(Modo AP: 192.168.169.1:6123)"]
    SRV["🖥️ Servidor Local Node.js<br>(v720-pc / Express + WS)"]
    WEB["🌐 Interface Web & Player<br>(http://localhost:3000)"]

    CAM <-->|"TCP Socket Direto (MJPEG / JSON / AVI)"| SRV
    SRV <-->|"WebSocket + REST API"| WEB
```

---

## ✨ Recursos Principais

* **🔴 Streaming MJPEG em Tempo Real:** Transmissão de vídeo 640x480 @ 10-15 FPS via WebSocket de baixíssima latência direto em elemento `<canvas>`.
* **🕒 Calibração de Relógio em Tempo Real:** Sincronização automática do relógio interno da câmera com compensação do fuso horário civil de Brasília (UTC-3). Botão dedicado no cabeçalho do painel para calibração instantânea sob demanda.
* **📼 Player Unificado de Gravações:** Reprodução dos vídeos salvos diretamente na janela principal de transmissão, com alternador `📼 REPRODUÇÃO`, barra de progresso (timeline), controle Play/Pause e download imediato.
* **📥 Sincronização Inteligente do MicroSD:**
  * Catálogo de gravações com decodificação de datas e bitmasks de 64 bits para minutos gravados (`Code 400` e `402`).
  * Download direto dos arquivos `.avi` via protocolo binário (`Code 406`).
  * **Histórico Persistente (`synced_history.json`):** Previne que vídeos já transferidos sejam baixados repetidamente ao sincronizar, mesmo que o usuário apague os arquivos do computador para liberar espaço em disco.
  * **Limpeza e Formatação Automática (`Code 207`):** Ao concluir a leitura e constatar que 100% das gravações do cartão estão seguras no PC, formata o MicroSD automaticamente para deixar o cartão limpo e pronto para novos ciclos.
  * Temporizador em tempo real e contador de arquivos gerenciados.
* **🌙 Controle de Hardware e Sensores:**
  * Chaveamento de visão noturna (LEDs infravermelhos IR).
  * Inversão/Espelhamento horizontal de imagem (*Mirror/Flip*).
  * Ajuste de sensibilidade de detecção de movimento (Gravação no MicroSD).
* **📸 DVR e Captura Instantânea:** Captura de fotos em alta resolução direto do fluxo de vídeo e gravação local.
* **🗑️ Gerenciamento de Armazenamento:** Exclusão individual ou em lote de gravações salvas no PC sem diálogos bloqueantes.

---

## ⚠️ Regras de Funcionamento e Restrições Técnicas Críticas

O hardware da câmera A9 é extremamente enxuto (CPU mononúcleo de ~200 MHz, 8 a 16 MB de RAM e apenas 1 canal TCP aberto). Para garantir a estabilidade do sistema, as seguintes diretrizes são **obrigatórias e invioláveis**:

### 1. Modo de Operação Exclusivo: Modo AP Direto (`192.168.169.1:6123`)
* A câmera **DEVE** operar sempre conectada diretamente ao dongle/placa Wi-Fi do computador através do SSID emitido pela câmera (ex.: `Nax_5c0006004882`).
* **Por que o Modo STA (Conexão ao Roteador de Casa) é Proibido?**
  1. **Zero Portas Abertas em STA:** Varreduras completas confirmam que, ao conectar-se a um roteador residencial, a câmera fecha a porta TCP 6123 e rejeita qualquer conexão de entrada local (`ECONNREFUSED`).
  2. **Dependência Inflexível da Nuvem Chinesa:** No modo cliente de roteador, o vídeo exige autenticação dinâmica e túnel WebRTC/ICE da Alibaba Cloud (`v720.p2p.naxclow.com` / `120.76.54.172`).
  3. **Inviabilidade de Interceptação DNS:** Forçar redirecionamento DNS no roteador residencial causa lentidão e falhas em todos os dispositivos da casa se o PC estiver desligado.

### 2. Drenagem de Hardware de Vídeo (1.200ms) no Download do Cartão SD
* Ao pausar a transmissão ao vivo (`CLOSE_V`) para iniciar o download de um vídeo do cartão, o sensor óptico e a DMA levam até **1.200ms** para descarregar os quadros JPEG pendentes.
* Se a requisição de download (`Code 406`) for enviada antes de 1.200ms, ocorre uma **colisão de barramento interno de DMA** entre a captura e o leitor SPI do MicroSD: a câmera transmite apenas o primeiro bloco (7.168 bytes do cabeçalho RIFF) e trava.
* **Solução:** O sistema aguarda obrigatoriamente $\ge 1.200\text{ ms}$ e zera os buffers antes de iniciar o streaming do arquivo.

### 3. Ciclo PING / PONG Mandatório (`cmd 101` $\rightarrow$ `cmd 102`)
* Durante a transferência contínua de blocos AVI (`cmd 7`), a câmera emite periodicamente pacotes de checagem `cmd 101` (`P2P_UDP_CMD_PING`).
* O cliente deve responder imediatamente com `cmd 102` (`PONG`). Sem essa resposta, a câmera interrompe o envio dos blocos subsequentes.

### 4. Timeouts da Flash SPI e Encerramento Confiável (`Code 411`)
* A leitura de setores do cartão MicroSD pela câmera pode demorar entre 1 a 3 segundos entre clusters. O timeout de inatividade é configurado para 8 a 10 segundos.
* O encerramento legítimo da transferência é notificado pela própria câmera através do pacote JSON `code: 411`, contendo o tamanho real final transferido.

### 5. Comportamento em Quedas de Energia
* O firmware da A9 **não possui temporizador de contingência**. Caso falte energia, se houver rede salva na memória flash ela tenta conectar em loop infinito como cliente (LED piscando lento) sem emitir o sinal AP.
* **Procedimento Pós-Queda de Energia:**
  1. Pressionar o botão físico **RESET / MODE** na câmera por 5 a 8 segundos (até o LED piscar rápido).
  2. O PC reconecta automaticamente ao Wi-Fi `Nax_...`.
  3. O backend `CAM_V720_PC` retoma a conexão instantaneamente.
* **Recomendação Definitiva:** Alimentar a câmera via Power Bank USB com função pass-through ou Mini-UPS 5V para evitar desligamentos.

### 6. Relógio Interno (RTC) e Gerenciamento do MicroSD
* **Sem Bateria de RTC Dedicada:** A câmera A9 não possui chip de relógio em tempo real com bateria de backup. Ao ser reiniciada ou desligada, o contador zera ou resgata a data antiga da memória Flash.
* **Calibração de Fuso Horário Local:** O firmware processa timestamps com `gmtime()` bruto. O `v720-pc` calcula e compensa automaticamente o deslocamento do fuso horário de Brasília (UTC-3), garantindo que as gravações recebam o nome com a data e o minuto civil corretos.
* **Inviabilidade do Code 412 (Exclusão Individual):** Em Modo AP Direto, o firmware ignora instruções de exclusão individual (`Code 412`). O sistema utiliza um histórico persistente (`synced_history.json`) para impedir downloads repetidos e formata o MicroSD via comando mestre (`Code 207`) após constatar que 100% dos vídeos estão salvos com integridade no computador.

---

## 🚀 Instalação e Execução

### Pré-requisitos
* **Node.js** 18.0.0 ou superior (recomendado Node.js 20+ LTS).
* **Adaptador Wi-Fi** no computador (dongle USB ou placa interna) conectado à rede gerada pela câmera (`Nax_...`).

### Passo a Passo

1. **Clonar o Repositório:**
   ```bash
   git clone https://github.com/Brandevtech/CAM_V720_PC.git
   cd CAM_V720_PC
   ```

2. **Instalar Dependências:**
   ```bash
   npm install
   ```

3. **Iniciar a Aplicação:**
   * **No Windows (Atalho rápido):** Duplo clique no executável [`run.bat`](run.bat).
   * **Via Terminal:**
     ```bash
     npm start
     ```
   * **Em Modo Desenvolvimento (com recarregamento automático):**
     ```bash
     npm run dev
     ```

4. **Acessar a Interface:**
   Abra no seu navegador de preferência:
   ```
   http://localhost:3000
   ```

---

## 📂 Estrutura do Projeto

```text
CAM_V720_PC/
├── lib/
│   ├── localClient.js       # Driver mestre TCP (192.168.169.1:6123), parsing e controle de streaming
│   ├── backgroundSync.js    # Serviço de download sob demanda e integridade de arquivos do SD
│   ├── sdCardService.js     # Parser de catálogo XML, bitmasks de minutos e gerador de arquivos AVI
│   ├── naxProtocol.js       # Estruturas de pacotes binários do protocolo proprietário Naxclow
│   └── naxCrypto.js         # Criptografia AES-256-CBC para autenticação reversa
├── public/
│   ├── index.html           # Interface web unificada de alta performance
│   ├── app.js               # Lógica de renderização Canvas, WebSocket, player e sincronização
│   └── style.css            # Estilização moderna escura com temas e microinterações
├── docs/
│   ├── AGENTS.md            # Diretrizes arquiteturais permanentes e regras invioláveis do hardware
│   └── PLANO_ENGENHARIA_REVERSA_STA.md # Histórico completo dos experimentos de engenharia reversa
├── server.js                # Servidor Express, endpoints REST e WebSocket Server
├── run.bat                  # Script de inicialização facilitada para Windows
├── package.json             # Metadados e dependências do projeto
└── README.md                # Este documento
```

---

## 📡 Referência Rápida de Comandos e Protocolo

| Código / Comando | Ação | Descrição Técnica |
| :---: | :---: | :--- |
| `Code 501` | Handshake | Conexão inicial e sincronização do timestamp com offset de fuso horário |
| `Code 4` | Base Info / RTC | Calibração do relógio interno do firmware da câmera (`unixTimer`) |
| `Code 502 (modo 2)` | `OPEN_V` | Inicia streaming local de vídeo MJPEG via socket TCP |
| `Code 502 (modo 0)` | `CLOSE_V` | Pausa streaming de vídeo para descarregar o sensor óptico |
| `Code 400` | Datas do SD | Lista datas com gravações presentes no cartão MicroSD |
| `Code 402` | Catálogo SD | Retorna XML com as horas e mapa de bits de minutos gravados |
| `Code 404 / 405` | Media Info | Consulta metadados e tamanho exato em bytes de um `.avi` na flash |
| `Code 406` | Start Stream | Inicia transferência sequencial de blocos do arquivo de vídeo |
| `Code 411` | Stream End | Pacote JSON emitido pela câmera confirmando término íntegro do arquivo |
| `Code 412` | Media Delete | Comando teórico de exclusão (ignorado pelo SoC A9 em Modo AP Direto) |
| `Code 207` | SD Format | Comando mestre de formatação FAT do MicroSD para limpeza total |
| `cmd 101` / `102` | PING / PONG | Handshake periódico de integridade durante a transmissão de vídeo do SD |

---

## 📄 Licença

Distribuído sob a licença **MIT**. Consulte o arquivo de licença para mais detalhes.

---

<p align="center">
  Desenvolvido com engenharia reversa para devolver o controle e a privacidade aos usuários.
</p>
