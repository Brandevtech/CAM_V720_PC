# Plano de Engenharia Reversa - Câmera V720 / A9 (Modo Roteador STA vs. Modo AP)
**Data de Atualização:** 22/10/2026  
**Status do Projeto:** DECISÃO ARQUITETURAL DEFINITIVA: Operação fixada em **Modo AP Direto (TCP 192.168.169.1:6123)**. Modo STA oficialmente descartado para transmissão local de vídeo devido a limitações intransponíveis do firmware e dependência da nuvem chinesa.

---

## 1. Contexto e Topologia da Rede
* **Câmera:** A9 / V720 (SoC BK7252 / Anyka)
  * **MAC Address:** `5c:ff:60:01:27:71`
  * **Device UID:** `5c0006004882`
  * **IP Residencial (STA):** `192.168.15.10` (quando conectada ao roteador)
  * **IP Modo AP Direto:** `192.168.169.1:6123`
  * **SSID Modo AP:** `Nax_5c0006004882`
* **PC Servidor Local (Antigravity Studio):**
  * **IP na LAN:** `192.168.15.5`
  * **Porta Web/API:** `3000` (Painel: `http://localhost:3000`)
  * **Porta DNS Interceptor:** `53/UDP`
  * **Porta Proxy HTTP Interceptor:** `80/TCP` (Apache XAMPP com ProxyPass para Node:3000)
  * **Porta Broker MQTT:** `1883/TCP` (Interceptando `v720.p2p.naxclow.com`)
  * **Portas UDP/TCP P2P:** `6123`, `53221`, `41234`

---

## 2. O Que Foi Descoberto e Validado no Modo STA

### A. Diagnóstico de Portas da Câmera em Modo STA
* Realizamos varredura de portas TCP (`fast_port_scan.mjs`) de **1 a 15000** em `192.168.15.10`.
* **Resultado:** `Open ports: []` (**Zero portas de escuta abertas**).
* **Conclusão:** Diferente do Modo AP direto (`192.168.169.1:6123`), no modo roteador STA a câmera **NUNCA atua como servidor TCP**. Qualquer tentativa de conexão TCP de entrada resulta em `ECONNREFUSED`. O backend foi devidamente protegido contra essas conexões indevidas.

### B. Intercepção DNS e HTTP Sem Nuvem
* O servidor DNS local em `lib/dnsServer.js` intercepta com sucesso todas as consultas de `*.naxclow.com` vindas da câmera (`192.168.15.10`) e aponta para o PC (`192.168.15.5`).
* O Apache recebe e redireciona com sucesso:
  * `POST /app/api/ApiSysDevices/a9bindingAppDevice`
  * `POST /app/api/ApiSysDevices/getDevInfo` (capturando `random=FSFTER` e token de sessão dinâmico).

### C. Comunicação Bidirecional MQTT (Porta 1883) - 100% Operacional
* A câmera conecta imediatamente no nosso broker local (`aedes`) na porta 1883.
* A câmera subscreve a: `Naxclow/P2P/Users/Device/sub/5c0006004882`.
* **Comandos remotos validados em tempo real via MQTT:**
  * **Controle do Infravermelho (Code 202)**: Resposta em 48ms com status atualizado em `Naxclow/P2P/Users/Device/Info` (`"IrLed": 1`).
  * **Varredura Wi-Fi em Tempo Real (Code 211)**: A câmera escaneou o espectro 2.4 GHz e respondeu com 19 redes vizinhas em Base64 (`"scanWifiBase64"`: `Mozzy Mozbourne`, `Felipe 5G`, `Bolacha _IoT`, etc.).
  * **Status e Telemetria (Code 53 / Info)**: Token dinâmico e telemetria completa reportados a cada comando.

---

## 3. Descobertas da Engenharia Reversa do APK (`classes5.dex` e `classes6.dex`)

### A. Estrutura do Cabeçalho de Pacotes P2P Naxclow (20 Bytes)
Desmontado diretamente de `Lcom/naxclow/rtc/net/NaxclowServerChannel$2;->encode`:
1. `len`: 4 bytes Little Endian (tamanho do payload).
2. `cmd`: 2 bytes Little Endian (`0` = JSON, `1` = Fragmento JPEG, `100` = Heartbeat).
3. `msgFlag`: 1 byte (`250` = Head, `251` = Body, `252` = End, `255` = Finish).
4. `dealFlag`: 1 byte.
5. `forwardId`: 8 bytes ASCII (`00000000` ou ID de encaminhamento).
6. `pkgId`: 4 bytes Little Endian (número sequencial do pacote).
7. `payload`: Dados JSON ou bytes JPEG brutos.

### B. Protocolo de Sinalização Local (Code 30 vs Code 10/11)
Desmontado de `Lcom/naxclow/rtc/net/NaxclowServerChannel`:
* **Code 10 / 11 (`CODE_S2D_NAT_REQ`)**: Usado para travessia WAN quando o dispositivo está remoto.
* **Code 30 (`CODE_S2D_LAN_REQ`)**: Usado quando o app e a câmera estão na mesma LAN.
* **Code 36**: Confirmação do Probe LAN.
* **Probe UDP Code 50 (`OooOo0` offset `0x176580`)**: Exige 4 chaves: `{ code: 50, cliToken, devTarget, cliId, devToken }`.
* **Gargalo de Vídeo no STA**: A câmera exige autenticação e chaves dinâmicas da infraestrutura WebRTC/ICE da Alibaba Cloud (`120.76.54.172`). Sem o servidor de sinalização proprietário da Naxclow na China, o fluxo UDP não se mantém estável localmente.

---

## 4. Por que a Estratégia de Roteador STA foi Abandonada Definitivamente

Em 22/10/2026, foi consolidado o entendimento dos seguintes impedimentos estruturais:

1. **Inviabilidade do DNS no Roteador Residencial:**
   * Para desviar a câmera para o PC (`192.168.15.5`), o roteador da casa (Vivo Fibra) precisaria ter o PC como DNS Primário no DHCP.
   * **Efeito Colateral Grave:** Quando o PC for desligado ou entrar em suspensão, **todos os celulares, Smart TVs e computadores da casa sofrem atrasos severos (lag de timeout DNS)** antes de chavear para o secundário.
   * **Desvio para a Nuvem:** Se for configurado um DNS Secundário (`8.8.8.8`), o chip da câmera frequentemente consulta o secundário em paralelo ou round-robin, recebendo o IP chinês da Alibaba Cloud e ignorando o interceptor local do PC.
2. **Inexistência de Filtro MAC na Interface Web da Vivo:**
   * O modem/roteador da Vivo (MitraStar/Askey) desabilita o filtro MAC manual na interface Web (empurrando para o app móvel, que apenas pausa internet e não barra a associação Wi-Fi na camada 2).
3. **Inutilidade de Hotspot no PC para Modo STA:**
   * Fazer o dongle do PC agir como Hotspot e conectar a câmera nele não altera a personalidade do firmware: em modo STA a câmera continua com as portas TCP fechadas e exigindo a nuvem chinesa.

---

## 5. Engenharia Reversa do Firmware A9 em Quedas de Energia (Power Cycle)

Testes empíricos realizados em 22/10/2026 comprovaram a máquina de estados do rádio da A9:

### A. Estados do LED da Câmera
* **LED Piscando Rápido:** Modo AP ativo. O rádio emite o SSID `Nax_5c0006004882` na sub-rede `192.168.169.x`.
* **LED Piscando Lentamente:** Modo Cliente (STA). O firmware está em loop contínuo de varredura tentando associar-se a um SSID salvo na NVRAM/SPI Flash.
* **LED Fixo Aceso:** Conectado a um Ponto de Acesso.

### B. Inexistência de Fallback Automático para AP
* Se a câmera tiver **qualquer SSID salvo na memória flash** (seja o roteador real ou um SSID fictício como `OFFLINE_DUMMY_AP` via Code 204):
  * Ao sofrer corte de energia e religar, o bootloader inicializa **sempre como Cliente (STA)**.
  * O chip entra em busca infinita da rede (LED piscando lento).
  * **O firmware NÃO possui temporizador de contingência** para voltar ao Modo AP por conta própria se a rede não for encontrada.

### C. Limitações do Botão Físico Reset / Mode
* Em muitos modelos A9 (SoC BK7252), uma pressão curta do botão Reset força apenas a reinicialização temporária em modo de pareamento AP para aquela sessão, sem formatar a partição de configuração NVRAM. No próximo cold boot (corte de energia), a câmera relê o último Wi-Fi salvo e volta a piscar lento.

---

## 6. Modo de Operação Escolhido: Modo AP Direto (Produção 100% Funcional)

A solução definitiva adotada para o projeto é manter a câmera operando exclusivamente em **Modo AP Direto**:

### Vantagens Comprovadas:
1. **Conexão TCP Nativa (`192.168.169.1:6123`):** Sem depender de nuvem, DNS ou roteadores.
2. **Streaming Estável:** MJPEG 640x480 @ ~10 FPS direto para o painel web `http://localhost:3000`.
3. **Cartão MicroSD Totalmente Acessível:**
   * Leitura de status (Code 218 / 410).
   * Catálogo de vídeos por data/minuto com máscara de 64 bits (Code 400 / 402).
   * Download direto de arquivos `.avi` via TCP (Code 406) para a pasta `v720-pc/recordings/`.
4. **DVR Local no PC:** Gravação automática por detecção de movimento e manual sob demanda.

---

## 7. Procedimento Operacional Padrão (POP) em Quedas de Energia

Quando a câmera sofrer corte de energia e reiniciar sem sinal de rede:

1. **Ação Física:** Pressione e segure o botão **MODE / RESET** na câmera por cerca de 5 a 8 segundos até o LED começar a **piscar rápido**.
2. **Reconexão Wi-Fi:** O dongle Wi-Fi do PC conectará automaticamente à rede `Nax_5c0006004882`.
3. **Painel Web:** Acesse `http://localhost:3000`. O servidor `v720-pc` restabelece a conexão TCP e retoma o vídeo e gravação instantaneamente.

### Recomendação de Hardware (Zero Manutenção):
Para eliminar 100% a necessidade de reset físico em quedas de energia:
* Alimentar a câmera A9 através de um **Power Bank USB com pass-through charging** ou um **Mini-UPS 5V** (custo ~R$ 40 a R$ 60).
* Como o consumo da câmera é inferior a 2 Watts, a bateria a mantém ligada continuamente durante quedas de luz, evitando o cold boot e mantendo o Modo AP ininterrupto.

---

## 8. Descobertas Recentes de Engenharia Reversa (Armazenamento, RTC e Sincronização)

### A. Ausência de RTC Físico e Compensação de Fuso Horário Local (UTC-3 Brasília)
* O microcontrolador da A9 não possui chip RTC com bateria independente. Ao sofrer corte de energia, o relógio volta para a última data/hora gravada na SPI Flash.
* Em Modo AP Direto, a câmera não possui acesso a servidores NTP públicos. Ela calibra o relógio exclusivamente a partir do campo `unixTimer` nos pacotes `Code 501` (`AP_CONNECT`) e `Code 4` (`BASE_INFO`).
* O firmware aplica `gmtime()` diretamente no `unixTimer`. Sem compensação, os vídeos ficavam com 3 horas de adiantamento. O `v720-pc` calcula `-now.getTimezoneOffset() * 60` (offset de Brasília) e calibra o relógio perfeitamente com a hora civil local.

### B. Inviabilidade de Exclusão Individual de Arquivos (Code 412)
* Varreduras de tráfego e testes unitários de injeção direta de pacotes revelaram que o comando `Code 412` é **completamente ignorado** pelo daemon TCP do firmware em modo AP.
* O firmware não emite o pacote de confirmação `Code 413` e mantém os clusters FAT intactos.
* O modelo nativo da A9 é **gravação circular contínua (loop recording)**: o chip sobrescreve os blocos mais antigos por hardware quando a partição enche.

### C. Histórico Persistente e Limpeza Mestre via Formatação (Code 207)
* Para evitar que o `BackgroundSync` baixe os mesmos arquivos em loop infinito (inclusive após o usuário apagá-los do disco do PC), foi introduzido o `synced_history.json`.
* Ao concluir a varredura completa sob demanda e certificar que 100% dos arquivos do cartão estão salvos no computador sem falhas, o sistema dispara o comando mestre de formatação FAT (`Code 207`), limpando o MicroSD e preparando-o para novas gravações.
