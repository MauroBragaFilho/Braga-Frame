# Braga Frame como módulo do Braga Digital Studio (BDS)

O Braga Frame continua sendo um programa próprio (roda sozinho, `npm start` ou o executável). Este documento explica como ele também pode ser:

- **A. embutido no BDS** como um módulo/tela (liga e desliga em Configurações → Módulos), dentro de um `<iframe>`;
- **B. aberto a partir do BDS como app separado**, já com um vídeo (`"Braga Frame.exe" "C:\Videos\jogo.mp4"`).

> **Estado: RETIRADO do BDS (25/10/2026, pedido do dono).** A integração "forma A" (módulo e tela no BDS) **não vai adiante**: o Braga Frame segue como **programa externo** e o BDS voltou ao que era (sem módulo, tela, canal `bf:invoke`, cópia `vendor/braga-frame` nem script de sincronização). O que está descrito abaixo é o histórico dessa integração e **não vale mais para o BDS**; o código do lado do Braga Frame que a servia (modo embutido, `src/host`, ponte) continua aqui, sem uso, e pode ser removido numa limpeza futura. A forma B (abrir o Braga Frame a partir do BDS como app separado) segue possível e não depende de nada disto.

## 1. Em uma página

| | A. Embutido | B. App separado |
|---|---|---|
| O que o usuário vê | uma tela "Braga Frame" no menu do BDS, ligada em Configurações → Módulos | uma janela do Braga Frame, aberta pelo BDS com o vídeo escolhido |
| Como funciona | o BDS cria o módulo no processo principal (`createBfModule`) e carrega `renderer/index.html` do Braga Frame num `iframe` (`?embedded=1`); as chamadas do iframe viram `postMessage` → página do BDS → **um canal IPC genérico** → `module.invoke` | o BDS dá `spawn` no executável com o caminho do vídeo; se o Braga Frame já está aberto, o processo novo só entrega o caminho a ele e encerra |
| Dados | `<dataDir do BDS>/braga-frame` (projetos, fila, preferências) | `userData` do próprio Braga Frame (`%APPDATA%\braga-frame` por padrão do Electron; confira com `app.getPath('userData')`) |
| Ferramentas (ffmpeg, yt-dlp, whisper) | as do BDS (`options.tools`), antes das que o Braga Frame acharia sozinho | as do Braga Frame (PATH, `CORTE_*`, instaladas por ele) |
| Custo no BDS | 1 definição de módulo, 1 item de menu, 1 canal + 1 evento no preload, 1 tela, 1 hook | uma função `spawn` e uma configuração (caminho do executável) |
| Quando usar | uso do dia a dia dentro do BDS, sem janela extra | para o trabalho pesado numa janela própria, ou enquanto o embutido não for adotado |

As duas formas **não se excluem**: o mesmo código do Braga Frame serve às duas.

## 2. O que existe no Braga Frame para isso

| Arquivo | Para quê |
|---|---|
| `src/host/index.js` | `createBfModule(options)`: monta o contexto e todos os handlers de `src/ipc`; `invoke`, `dispose`, `requestOpen`, `channels`. O app próprio (`main.js`) usa exatamente isto, então o caminho de módulo é exercitado em todo uso e teste |
| `src/host/bfEmbedHost.js` | lado da **página do hospedeiro**: cria o `iframe`, atende as mensagens dele e entrega os eventos. Feito para ser carregado direto da pasta do Braga Frame (não copie) |
| `renderer/bridge.js` | dentro do iframe: cria `window.bf` por `postMessage` quando não há preload. Em janela própria não faz nada |
| `src/host/cli.js`, `src/host/openRequests.js` | linha de comando (`"Braga Frame.exe" "<vídeo>"`) e fila de "abrir este vídeo" |
| `src/singleInstance.js` | segunda instância repassa os argumentos à primeira (`second-instance`) |
| `tests/host*.test.js`, `tests/e2e/embed.e2e.js`, `tests/e2e/fixtures/host-app/` | testes; o `host-app` é um mini hospedeiro que faz o papel do BDS |

## 3. API do módulo: `createBfModule(options)`

```js
const { createBfModule } = require('<pasta do Braga Frame>/src/host');
const bf = createBfModule({ app, dialog, shell, getWindow, userDataDir, send, tools, windowControls: false, log });
bf.register();                       // opcional: invoke() registra sozinho na primeira chamada
await bf.invoke('tools:status', {}); // { ok:true, ... } | { ok:false, code, message }
bf.dispose();                        // desliga tudo; para ligar de novo, crie outro com createBfModule
```

| Opção | Obrigatória | O que faz |
|---|---|---|
| `app`, `dialog`, `shell` | sim | os do Electron. O módulo usa `app.getPath('videos')` (sugestão de pasta de downloads), `app.isPackaged`, e registra/solta ouvintes de `before-quit` em `app` |
| `userDataDir` | sim | pasta **própria** do módulo (absoluta). Tudo o que o módulo grava vive aqui (projetos, `queue.json`, preferências, cache, ferramentas que ele mesmo instalar). Nada vai para `app.getPath('userData')` |
| `getWindow` | não | janela pai dos diálogos (escolher vídeo/pasta) e destino padrão dos eventos |
| `send(canal, payload)` | não | para onde vão os eventos (nomes **sem** prefixo). No BDS: `win.webContents.send('bf:event', { channel, payload })`. Sem ela, vão a `getWindow().webContents.send(prefixo + canal)` |
| `ipcMain` | não | se informado, cada canal também é registrado nele (com `channelPrefix`). **No BDS não use**: um canal genérico basta |
| `channelPrefix` | não | `''` (padrão, app próprio) ou `"bf:"`. Vale para os canais do `ipcMain` e para eventos enviados direto à janela. `invoke` aceita o nome simples (`tools:status`) e, havendo prefixo, o completo (`bf:tools:status`) |
| `tools` | não | `{ ffmpeg, ffprobe, ytdlp, whisper, twitchDownloader }`: caminho (texto) **ou função** que devolve o caminho. Valem **antes** de `CORTE_*`, PATH e das instaladas pelo Braga Frame. Só vale caminho absoluto de arquivo que existe; senão cai na resolução normal. O hospedeiro é o dono delas (ele pode trocá-las: a função é consultada a cada `app:refreshTools`). `whisper` pode ser o `whisper-cli` de **CPU ou de CUDA** (aceleração NVIDIA): o Braga Frame descobre pela pasta (`ggml-cuda.dll`) e escolhe placa ou processador sozinho; nesse caso não baixa o pacote CUDA próprio |
| `ai` | não | provedor de IA do hospedeiro para a análise de cortes por IA: `{ describe(), chat(params) }`. `describe()` devolve `{ id, label, model, hasKey, ready, reason?, serverHost?, isLocal? }` (ou `null` sem provedor) e `chat({ system, messages, maxTokens, temperature, jsonMode, signal, acceptProvider? })` **faz a requisição** (`acceptProvider(p)`, opcional, é a regra de uso do Braga Frame com o OpenRouter: recebe `{ id, label, model, serverHost, isLocal }` de cada provedor da cadeia e devolve `false` para ele nem ser tentado; um hospedeiro que a ignore deixa a trava "só gratuitos" só na conferência do provedor ativo) e devolve `{ text, usage?:{ promptTokens, completionTokens }, finishReason?, model? }`. O hospedeiro é o dono da chave: o Braga Frame **nunca a recebe nem a grava**, só vê qual provedor e modelo estão ativos (a configuração fica só leitura na aba Análise). Erros do hospedeiro com `status` (HTTP) e `retryAfter` ajudam o Braga Frame a decidir se repete. O aviso de privacidade antes do primeiro envio é do Braga Frame (por provedor). Sem a opção, o app usa a própria configuração (Gemini, Groq, OpenRouter ou Personalizado) |
| `windowControls` | não (padrão `false`) | registra `window:minimize/maximize/fullscreen/close/state`. **Só o app próprio** (janela sem moldura) usa `true`. Embutido, deixe desligado: senão o iframe fecharia a janela do BDS |
| `log` | não | função `(nivel, mensagem)` ou objeto tipo `console` |
| `version`, `env`, `toolCatalog`, `handlersDir` | não | versão mostrada em `app:info` (padrão: `package.json` do Braga Frame), ambiente consultado para achar ferramentas, e ganchos de teste |

**Retorno:** `{ meta: { id:'frame', title, description, version }, register(), invoke(canal, payload, event?), channels({ prefixed? }), requestOpen(caminhoOuPedido), send(canal, payload), dispose(), ctx, registered, disposed, channelPrefix, userDataDir }`.

**Garantias**

- `invoke` **nunca lança**: devolve `{ ok:false, code, message }` com `INVALID_CHANNEL`, `UNKNOWN_CHANNEL`, `MODULE_START_FAILED` ou `MODULE_DISPOSED` além dos erros dos próprios handlers.
- `dispose()` roda o fechamento de cada recurso (a fila grava o estado e marca o que rodava como `interrupted`; ffmpeg, yt-dlp e whisper em andamento são parados; instalações e downloads são cancelados), solta os canais do `ipcMain` e os ouvintes de `app`. É idempotente, não apaga dado nenhum e deixa o processo livre para sair sozinho (testado).
- Duas instâncias com pastas diferentes convivem no mesmo processo (testado). **Única exceção conhecida:** o cache de codificadores (`src/core/export/encoders.js`) guarda a pasta do **último** módulo registrado; o conteúdo é regenerável (veja a seção 9).

**Canais e eventos acrescentados pelo encaixe** (além dos de `docs/arquitetura.md`):

| Canal / evento | Para quê |
|---|---|
| `app:takeOpenRequest` → `{ requests: [{ path } \| { error:{code,message} }] }` | a interface busca (uma vez cada) os vídeos pedidos de fora. Chamado sozinho ao carregar e a cada aviso |
| `app:requestOpen { path }` → `{ ok:true, path }` ou erro (`INVALID_PATH`, `RELATIVE_PATH`, `UNSUPPORTED_FORMAT`, `INPUT_MISSING`, `NOT_A_FILE`) | o hospedeiro pede para abrir um vídeo. Confere o caminho e enfileira |
| evento `app:openRequest { count }` | aviso (sem dados) de que há pedido pendente |

## 4. Protocolo de mensagens (iframe ↔ página do hospedeiro)

Objetos simples `{ source: 'braga-frame', version: 1, kind, … }`. Implementação: `renderer/bridge.js` (iframe) e `src/host/bfEmbedHost.js` (hospedeiro).

| Sentido | `kind` | Campos | Observação |
|---|---|---|---|
| iframe → host | `ready` | | o app carregou; o host responde `init` |
| iframe → host | `invoke` | `id`, `channel`, `payload` | resposta: `result` com o mesmo `id` |
| iframe → host | `on` / `off` | `channel` | assina/cancela eventos (o host só repassa os assinados) |
| iframe → host | `pick-path` | `id`, `file` (File) | descobre o caminho real de um arquivo solto; resposta: `result` |
| iframe → host | `theme-changed` | `theme` | o usuário trocou o tema dentro do app |
| iframe → host | `key` | `key, code, ctrlKey, shiftKey, altKey, metaKey` | só com `forwardKeys`; só Ctrl/Alt/Meta + tecla que o app não tratou |
| iframe → host | `close-ready` | | resposta a `prepare-close`: projeto gravado |
| host → iframe | `init` | `theme`, `forwardKeys` | sem isto, chamadas pendentes expiram em 8 s com uma mensagem clara |
| host → iframe | `result` | `id`, `ok`, `value` \| `error` | `ok:true`: `value` é a resposta do canal; `ok:false`: falha de transporte |
| host → iframe | `event` | `channel`, `payload` | evento do processo principal |
| host → iframe | `theme` | `theme` | `'light'` \| `'dark'` |
| host → iframe | `visibility` | `visible` | escondida: pausa o player |
| host → iframe | `prepare-close` | | grava o projeto e responde `close-ready` |

**Validação nos dois lados:** só se aceita mensagem cuja `event.source` é a janela esperada (`iframe.contentWindow` no host; `window.parent` no iframe) e cuja origem confere (`"null"` para páginas `file://`; o iframe recebe `?hostOrigin=` na URL); formato do objeto e do canal (`/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/`) são conferidos **antes** de chamar `invoke`. O host aceita `isChannelAllowed(canal)` para restringir o que o iframe pode chamar. Testado com mensagens forjadas (canal inválido, remetente e origem errados, objeto fora do formato).

**Arrastar e soltar / "Abrir vídeo".** O botão "Abrir vídeo" chama `source:pick`, que roda no processo principal (diálogo do hospedeiro) e funciona igual. Para um arquivo solto no iframe, a ponte intercepta o `drop`, envia o `File` ao host (`pick-path`) e o host usa `pathForFile` (no BDS, `window.bds.getPathForFile`, que é o `webUtils.getPathForFile` do preload). **Testado no Electron 43**: o `File` clonado por `postMessage` mantém o caminho real, e o vídeo abre.

**Tema.** O host passa `theme` no `init` (e a URL leva `?theme=` para não piscar). Mudanças depois vão por `host.setTheme()`. O botão de tema do próprio Braga Frame continua existindo dentro do iframe e avisa o host (`onThemeChange`).

**Foco e teclado.** `host.focus()` leva o foco ao iframe (chame em `onEnter`). Eventos de teclado não atravessam o iframe: com `forwardKeys: true` os atalhos com Ctrl/Alt/Meta que o Braga Frame não tratou são recriados como `keydown` na página do BDS (assim Ctrl+K, Ctrl+1…9 continuam funcionando). Coberto só por teste unitário (não no Electron).

**Sair da tela.** Use `await host.close()` (não `destroy()`): o Braga Frame grava o projeto aberto (o salvamento dele espera 300 ms), pausa o vídeo, e só então o iframe é removido e os ouvintes soltos. Testado: o corte feito na hora de sair é gravado.

## 5. Forma A: embutido no BDS, passo a passo

> O BDS usa terminadores de linha **CRLF**; os trechos abaixo estão em LF, converta ao colar se o seu editor não fizer sozinho.

### 5.1 Copiar o Braga Frame para dentro do BDS

Pasta `vendor/braga-frame/` na raiz do BDS (**fora de `src/`**: os testes do BDS varrem `src/` atrás de `handle(`/`send(` e contariam os dezenas de canais e eventos do Braga Frame como se fossem do BDS). Só precisam ir `renderer/`, `src/` e `package.json`:

```powershell
$origem  = "D:\Projetos\Braga Frame"
$destino = "D:\Projetos\Braga Digital Studio\vendor\braga-frame"
robocopy "$origem\renderer" "$destino\renderer" /MIR
robocopy "$origem\src" "$destino\src" /MIR
Copy-Item "$origem\package.json" "$destino\package.json" -Force
# robocopy devolve 0 a 7 quando deu certo
```

(`/MIR` espelha: apaga em `vendor/braga-frame` o que não existe mais no Braga Frame, por isso essa pasta é só uma cópia, nunca edite nada dentro dela. Alternativa que mantém o histórico: `git submodule add <repositório do Braga Frame> vendor/braga-frame` e empacotar só `renderer/`, `src/` e `package.json`. Dependência `npm` não é necessária e foi evitada de propósito.)

Atualizar = repetir o comando. Nada do Braga Frame precisa de `npm install` (zero dependências de runtime; `electron` é dev-only).

### 5.2 Registrar o módulo (`src/core/modules/ModuleRegistry.js`)

```js
/** Slot 'extra': módulos futuros entram aqui (mesmo formato de BASE_MODULES). */
const EXTRA_MODULES = [
  {
    id: 'frame',
    title: 'Braga Frame',
    description: 'Cortes verticais (9:16): analisa gameplays e lives, revisa os cortes e exporta com controle de qualidade.',
    screens: ['frame'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 70
  }
];
```

Configurações → Módulos já lista o módulo sozinha (a lista vem de `modules:list`).

### 5.3 Item de menu (`renderer/index.html`) e "fail-closed" (`renderer/app.js`)

Dentro de `<nav class="tabs">` (por exemplo, depois de Transcrição). O ícone `content_cut` existe na fonte do BDS (é o mesmo arquivo `material-symbols-rounded.woff2` do Braga Frame):

```html
        <button class="tab-button" data-view="frame" type="button">
          <span class="material-symbols-rounded">content_cut</span>
          Braga Frame
        </button>
```

Para o botão não piscar antes de o main informar o estado dos módulos, acrescente `'frame'` à lista de telas controladas por módulo em `renderer/app.js`:

```js
const MODULE_GATED_SCREENS = ['download', 'converter', 'library', 'projects', 'project_workspace', 'upload', 'devices', 'luts', 'frame'];
```

### 5.4 Um canal e um evento no preload (`src/ipc/channels.js`)

O preload do BDS é **gerado** da tabela de canais. Cole este bloco **antes** do comentário `Eventos main → renderer que o preload assina` e a linha do evento no fim de `EVENTS`:

```js
// --- Braga Frame (módulo embutido): UM canal genérico para todos os canais do Braga Frame ---------------------------
// O Braga Frame valida o formato de cada canal e de cada payload por conta própria (src/host); aqui só se confere o remetente
// (frame principal da página do app) e que o nome do canal é um texto curto.
define('frame', 'throw', {
  'bf:invoke': {
    args: [
      STR('channel', 100, { min: 1, label: 'Canal do Braga Frame' }),
      t.any('o payload é validado pelo handler do Braga Frame (cada canal tem o seu formato); chega por mensagem do iframe', { name: 'payload', optional: true })
    ],
    returns: 'Resposta do canal do Braga Frame: { ok:true, … } ou { ok:false, code, message }',
    api: ['bfInvoke']
  }
});
```

```js
  ['youtubeUpload.onItemFailed', 'upload:item-failed'],
  ['onBfEvent', 'bf:event']
];
```

Depois: `npm run generate:preload`. O gerador produz estas duas linhas em `preload.js` (conferido numa cópia do gerador do BDS, sem tocar nos arquivos dele):

```js
  bfInvoke: (channel, payload) => ipcRenderer.invoke('bf:invoke', channel, payload),
  onBfEvent: (cb) => registerListener('bf:event', cb),
```

**Fixtures de teste do BDS** (`tests/fixtures/`), conferidas na mesma cópia: nada some nem muda, só aparecem 3 inserções em `preload-surface.json` e 2 em `ipc-channels.json`.

`ipc-channels.json`: `"bf:invoke",` em `handlers`, logo depois de `"bdsm:pairingStatus",`; `"bf:event",` em `events`, logo depois de `"bdsm:progress",`.

`preload-surface.json` (o arquivo é ordenado por nome):

1. a chave `bfInvoke`, logo depois da chave `analyzeSilence`:

```json
  "bfInvoke": {
    "type": "function",
    "length": 2,
    "withSentinels": {
      "made": [
        {
          "op": "invoke",
          "ch": "bf:invoke",
          "args": [
            "@1",
            "@2"
          ]
        }
      ],
      "returns": "promise"
    },
    "noArgs": {
      "made": [
        {
          "op": "invoke",
          "ch": "bf:invoke",
          "args": [
            "__undefined__",
            "__undefined__"
          ]
        }
      ],
      "returns": "promise"
    }
  },
```

2. a chave `onBfEvent`, logo depois da chave `onBdsmProgress`:

```json
  "onBfEvent": {
    "type": "function",
    "length": 1,
    "withSentinels": {
      "made": [
        {
          "op": "on",
          "ch": "bf:event"
        }
      ],
      "returns": "function"
    },
    "noArgs": {
      "made": [],
      "returns": "function"
    },
    "unsubscribe": [
      {
        "op": "on",
        "ch": "bf:event"
      },
      {
        "op": "off",
        "ch": "bf:event"
      },
      {
        "op": "off",
        "ch": "bf:event"
      }
    ]
  },
```

3. dentro de `removeAllListeners` → `withSentinels` → `made` (lista de `off` em ordem alfabética de canal), este item entre `bdsm:progress` e `converter:fileFinished`:

```json
        {
          "op": "off",
          "ch": "bf:event"
        },
```

### 5.5 Processo principal

**`src/core/modules/frameModule.js`** (novo): guarda a única instância e entrega as ferramentas do BDS.

```js
'use strict';

/**
 * Braga Frame embutido (módulo "frame"): guarda a única instância do módulo do Braga Frame no processo principal.
 *
 * - criada na primeira chamada do iframe (nada do Braga Frame é carregado com o módulo desligado);
 * - desligada por stop() (HOOKS.frame em moduleRuntime.js: ao desligar em Configurações → Módulos e ao fechar o app);
 * - o estado dela (projetos, fila, preferências, ferramentas baixadas por ela) fica em <dataDir>/braga-frame.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, shell } = require('electron');
const logger = require('../../services/logService');

// pasta do Braga Frame dentro do BDS (copiada para vendor/braga-frame, veja docs/modulo-bds.md do Braga Frame)
const BF_HOST_ENTRY = path.join(__dirname, '..', '..', '..', 'vendor', 'braga-frame', 'src', 'host');

let context = null; // { dataDir, getMainWindow }, definido por HOOKS.frame.start
let instance = null;

function setContext(next) {
  context = { ...(context || {}), ...next };
}

/** Resolve uma ferramenta do BDS sem lançar erro: o caminho ou null (o Braga Frame confere se o arquivo existe). */
function toolPath(loadTool) {
  return () => {
    try { return loadTool().resolve({ mustExist: false }) || null; } catch (_) { return null; }
  };
}

/** whisper-cli do BDS (Configurações → Transcrição): o da aceleração NVIDIA (pasta `cuda`) se estiver instalado, senão o do motor de CPU (`engine`). Veja `frameModule.js` para a versão completa. */
function whisperCli() {
  if (!context || !context.dataDir) return null;
  const exe = path.join(context.dataDir, 'modules', 'whisper', 'engine', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  return fs.existsSync(exe) ? exe : null;
}

function mainWindow() {
  const win = context && typeof context.getMainWindow === 'function' ? context.getMainWindow() : null;
  return win && !win.isDestroyed() ? win : null;
}

/** A instância do módulo (cria na primeira vez). null se o módulo ainda não recebeu o contexto (HOOKS.frame.start). */
function get() {
  if (instance && !instance.disposed) return instance;
  if (!context || !context.dataDir) return null;
  const { createBfModule } = require(BF_HOST_ENTRY);
  instance = createBfModule({
    app, dialog, shell,
    getWindow: mainWindow,
    userDataDir: path.join(context.dataDir, 'braga-frame'), // pasta PRÓPRIA do módulo
    windowControls: false, // o iframe não pode minimizar/fechar a janela do BDS
    // eventos do Braga Frame -> um único evento para a página (renderer/screens/frame.js entrega ao iframe)
    send: (channel, payload) => {
      const win = mainWindow();
      if (win) win.webContents.send('bf:event', { channel, payload });
    },
    // as ferramentas são do BDS: o Braga Frame as usa antes de procurar por conta própria
    tools: {
      ffmpeg: toolPath(() => require('../../infrastructure/external-tools/adapters/FfmpegTool').ffmpegTool),
      ffprobe: toolPath(() => require('../../infrastructure/external-tools/adapters/FfprobeTool').ffprobeTool),
      ytdlp: toolPath(() => require('../../infrastructure/external-tools/adapters/YtDlpTool').ytDlpTool),
      whisper: whisperCli
    },
    log: (level, message) => { (typeof logger[level] === 'function' ? logger[level] : logger.info).call(logger, message); }
  });
  return instance;
}

/** Chama um canal do Braga Frame (o mesmo que o iframe chamaria no app próprio). Nunca lança. */
async function invoke(channel, payload) {
  const bf = get();
  if (!bf) return { ok: false, code: 'MODULE_NOT_READY', message: 'O módulo Braga Frame ainda não foi iniciado.' };
  return bf.invoke(channel, payload);
}

/** Pede para o Braga Frame abrir um vídeo quando a tela dele abrir (ou agora, se já estiver aberta). */
async function requestOpen(file) {
  return invoke('app:requestOpen', { path: file });
}

/** Desliga a instância (processos, fila, instalações). Os dados em <dataDir>/braga-frame ficam. */
function stop() {
  const current = instance;
  instance = null;
  if (current) current.dispose();
}

module.exports = { setContext, get, invoke, requestOpen, stop };
```

**`src/ipc/frameHandlers.js`** (novo): o canal genérico. Usa o registrador do BDS (`handle`), que já recusa quem não é o frame principal da página do BDS: o iframe **não consegue** chamar `bf:invoke` direto; quem chama é a tela `frame.js`, repassando as mensagens do iframe.

```js
'use strict';

const { handle } = require('./channelRegistry');
const { moduleRuntime } = require('../bootstrap/moduleRuntime');
const frameModule = require('../core/modules/frameModule');

/**
 * Braga Frame embutido: UM canal genérico (bf:invoke) leva as chamadas do iframe ao módulo do Braga Frame.
 * O registrador (channelRegistry) já recusa quem não é o frame principal da página do BDS: o iframe NÃO chama este canal;
 * quem chama é renderer/screens/frame.js, que repassa as mensagens do iframe (src/host/bfEmbedHost.js do Braga Frame).
 * Os eventos voltam por 'bf:event' (frameModule.js).
 */
module.exports = function registerFrameHandlers() {
  handle('bf:invoke', async (_event, channel, payload) => {
    if (!moduleRuntime.isEnabled('frame')) {
      return { ok: false, code: 'MODULE_OFF', message: 'O módulo Braga Frame está desligado. Ligue-o em Configurações → Módulos.' };
    }
    moduleRuntime.start('frame'); // idempotente; garante o stop() ao desligar o módulo (HOOKS.frame)
    return frameModule.invoke(channel, payload);
  });
};
```

**`src/ipc/index.js`**: junto dos outros `require('./…Handlers')(…)`:

```js
  require('./frameHandlers')();
```

**`src/bootstrap/moduleRuntime.js`**: dentro de `HOOKS`, ao lado dos demais módulos (ligar/desligar em Configurações → Módulos e o fechamento do app, `stopAll`, chegam aqui):

```js
  // Braga Frame embutido: a instância é criada na primeira chamada do iframe (src/core/modules/frameModule.js)
  frame: {
    start(ctx) { require('../core/modules/frameModule').setContext({ dataDir: ctx.appPaths.dataDir, getMainWindow: ctx.getMainWindow }); },
    stop() { require('../core/modules/frameModule').stop(); }
  },
```

Fluxo: o iframe chama → `frameHandlers` confere `moduleRuntime.isEnabled('frame')` → `moduleRuntime.start('frame')` (idempotente; guarda o contexto) → `frameModule.invoke` cria o módulo na primeira vez. Desligar o módulo chama `stop()` → `dispose()`. Na abertura do app **não** é preciso fazer nada em `startup.js`: com o módulo desligado, nada do Braga Frame é carregado.

### 5.6 A tela (`renderer/screens/frame.html`, `frame.css`, `frame.js`)

`frame.html`:

```html
<div class="frame-host" id="bfFrameHost" aria-label="Braga Frame"></div>
```

`frame.css` (o Braga Frame ocupa toda a área de conteúdo, sem o respiro padrão das telas):

```css
.content:has(> #frameView.active) { padding: 0; overflow: hidden; }
#frameView .frame-host { width: 100%; height: 100%; }
#frameView .frame-host iframe { width: 100%; height: 100%; border: 0; display: block; }
```

`frame.js` (módulo ES, como as outras telas):

```js
// Tela do Braga Frame (módulo "frame"): embute renderer/index.html do Braga Frame num iframe e liga a ponte ao processo principal.
// O bfEmbedHost.js vem da própria pasta do Braga Frame (não há cópia para ficar desatualizada).
import '../../vendor/braga-frame/src/host/bfEmbedHost.js';

const FRAME_URL = new URL('../vendor/braga-frame/renderer/index.html', window.location.href).href;
let embed = null;
let themeObserver = null;

const hostTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

function mount() {
  if (embed && !embed.destroyed) return;
  const container = document.getElementById('bfFrameHost');
  if (!container || typeof window.bds?.bfInvoke !== 'function') return;
  embed = window.BfEmbedHost.create({
    container,
    src: FRAME_URL,
    invoke: (channel, payload) => window.bds.bfInvoke(channel, payload),
    subscribe: (handler) => window.bds.onBfEvent(handler), // handler({ channel, payload })
    pathForFile: (file) => window.bds.getPathForFile(file), // arrastar e soltar um vídeo no iframe
    theme: hostTheme,
    forwardKeys: true, // Ctrl+<tecla> não tratado pelo Braga Frame chega aos atalhos do BDS
    onError: (err) => console.warn('[Frame]', err)
  });
  // o tema do BDS (atributo data-theme da página) é repassado ao Braga Frame
  themeObserver = new MutationObserver(() => embed && embed.setTheme(hostTheme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

async function unmount() {
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
  const current = embed;
  embed = null;
  if (current) await current.close(); // o Braga Frame grava o projeto aberto antes de o iframe sair
}

export function initScreen() { mount(); }

export function onEnter() {
  mount();
  if (embed) { embed.setVisible(true); embed.focus(); }
}

export async function onLeave() { await unmount(); }
```

A tela mantém o iframe só enquanto está aberta (`onLeave` faz `close()`). Alternativa: manter o iframe vivo (esconder em vez de remover) para preservar o projeto aberto na tela; custo: vídeo/uso de memória com a tela escondida e o módulo precisa ser desmontado quando for desligado (`bds:modules-changed`). Decisão em aberto (seção 9).

### 5.7 CSP

A CSP atual do BDS (`default-src 'self'; script-src 'self'; …`, sem `frame-src`) **já permite** um iframe de `file://` do mesmo app e a importação do `bfEmbedHost.js` por módulo ES: testado com a CSP literal do BDS em `tests/e2e/fixtures/host-app/host-bds-csp.html`. **Nada precisa mudar.** Se quiser deixar a intenção explícita (ou se o `default-src` for endurecido no futuro), acrescente `frame-src file:` ao final da CSP em `renderer/index.html` (variante testada em `host.html`). A CSP **dentro** do iframe é a do próprio `renderer/index.html` do Braga Frame (`script-src 'self'`, sem scripts inline) e não depende da do BDS.

Não é preciso `webviewTag`, `nodeIntegrationInSubFrames` nem mudar `webPreferences`: o iframe **não tem preload** (de propósito) e fala só por `postMessage`.

### 5.8 Ferramentas compartilhadas

Feito em `frameModule.js` (`tools`): ffmpeg, ffprobe e yt-dlp do BDS, e o `whisper-cli` do BDS: o da **aceleração NVIDIA (CUDA)** (`<dataDir>/modules/whisper/cuda`) quando ela está instalada, senão o do **motor de CPU** (`<dataDir>/modules/whisper/engine`); a versão pinada é a mesma nos dois: `b5130`. O Braga Frame descobre se o executável é CUDA ou CPU **pela pasta** (`ggml-cuda.dll`), sem precisar de aviso do hospedeiro: com o CUDA do BDS usa o modo automático (placa se há NVIDIA, senão processador, com fallback e `-ng`; o pacote CUDA traz as DLLs de CPU) e **não baixa motor próprio** (`whisper-cuda` fica oculto na aba Ferramentas e `tools:install` dele dá `HOST_PROVIDED`). A aba Legendas mostra "motor do BDS · GPU" ou "· CPU". Cada valor é uma função consultada a cada resolução, então se o BDS atualizar uma ferramenta o Braga Frame passa a usar a nova (`app:refreshTools`, ou ao reabrir a aba Ferramentas). Regras: só vale caminho absoluto de arquivo que existe; ausente, o Braga Frame cai na resolução dele (PATH, `CORTE_*`, ou a que ele mesmo instalou). Na aba Ferramentas do Braga Frame, a que veio do BDS aparece como "do sistema". **Os modelos do Whisper não são compartilhados**: cada app baixa os seus (decisão em aberto, seção 9). Testado com a placa (GTX 1650) usando o motor CUDA do BDS (`tests/subtitles-gpu-real.test.js`) e, sem placa, com `nvidia-smi` falso e motor simulado; **não** testado numa máquina sem NVIDIA com o motor CUDA instalado de verdade (o caminho é: sem GPU detectada o automático roda o mesmo executável com `-ng`).

### 5.9 Pasta de dados

`<dataDir do BDS>/braga-frame` (`frameModule.js`). Dentro dela o Braga Frame cria `projects/`, `tools/`, `cache/`, `downloads/`, `queue.json`, `preferences.json`, `history/` etc. Desligar o módulo **não apaga nada**. Para o BDS limpar tudo ao desinstalar, apague essa pasta.

Os dados do módulo embutido **não são** os do app separado (`userData` do Braga Frame). Compartilhar a mesma pasta entre os dois é possível (`--user-data-dir=<dataDir>/braga-frame` no app separado), mas **dois gravadores** do mesmo `queue.json`/projeto se atrapalham; só faça se o BDS impedir abrir os dois ao mesmo tempo (seção 9).

### 5.10 Abrir um vídeo do BDS no Braga Frame embutido

De qualquer tela do BDS (por exemplo, um menu de contexto da Biblioteca): pede ao módulo e navega para a tela. O pedido fica na fila e a interface o busca ao carregar, então funciona com a tela ainda fechada:

```js
const res = await window.bds.bfInvoke('app:requestOpen', { path: caminhoDoVideo }); // { ok:true } ou { ok:false, code, message }
if (res.ok) document.querySelector('.sidebar .tab-button[data-view="frame"]')?.click();
else window.bdsModal?.alert?.(res.message);
```

No processo principal, `frameModule.requestOpen(caminho)` faz o mesmo (por exemplo, a partir de uma notificação).

### 5.11 Empacotamento (`package.json` do BDS e `eslint.config.js`)

- `build.files`: acrescente `"vendor/braga-frame/**/*"`. As exclusões globais já existentes (`!**/docs/**`, `!**/tests/**`, `!**/*.md`, `!**/fixtures/**`, `!**/scripts/**`) não afetam o que o Braga Frame precisa em tempo de execução. Confira com `npm run verify:package` (e atualize `scripts/verify-package-contents.js` se ele listar pastas esperadas).
- `eslint.config.js` do BDS: acrescente `'vendor/**'` a `ignores` (o código do Braga Frame tem a configuração de lint dele).
- Dentro do `.asar` tudo continua funcionando por caminhos relativos (`file://…/app.asar/vendor/braga-frame/renderer/index.html`), mas **isto não foi testado com um build do BDS** (seção 9).
- O Braga Frame não leva binários: ffmpeg/ffprobe/yt-dlp/whisper vêm do BDS (`tools`) ou são baixados por ele para dentro de `<dataDir>/braga-frame/tools` (releases oficiais, tamanho e SHA-256 conferidos).

### 5.12 Conferência no BDS depois de aplicar

```
npm run generate:preload && npm run verify:preload
npm test                 # ipc-registry, ipc-channels-snapshot, preload-generated, ipc-wiring, module-registry…
node --test tests/module-registry.test.js
```

Se algum teste do BDS que olha o menu, a lista de telas ou a fiação (`ipc-wiring`) reclamar, é porque ele enumera módulos/telas: ajuste a lista dele. Depois, abra o BDS, ligue "Braga Frame" em Configurações → Módulos, abra a tela e rode o roteiro de `tests/e2e/embed.e2e.js` à mão (abrir vídeo, abas, tema, arrastar e soltar, sair da tela).

## 6. Forma B: Braga Frame como app separado, aberto com um vídeo

### 6.1 Comando

```
"Braga Frame.exe" "C:\Videos\jogo.mp4"                     (instalado; o nome real depende do instalador)
npm start -- "C:\Videos\jogo.mp4"                         (na pasta do Braga Frame, desenvolvimento)
electron.exe "D:\Projetos\Braga Frame" "C:\Videos\jogo.mp4"   (como o BDS abriria em desenvolvimento)
```

Regras (`src/host/cli.js`, testadas): o primeiro argumento que não é opção é o vídeo (em desenvolvimento, o primeiro é a pasta do app e é descartado); tudo que começa com `-` é opção e é ignorado (`--user-data-dir=…` etc.); `--` encerra as opções. O caminho **precisa ser completo** (relativo é recusado, porque a pasta de trabalho de quem chama não é previsível), **existir**, ser **arquivo** e ter extensão de vídeo suportada (`mp4, mkv, mov, webm, avi, flv, ts`). **Nada do argumento é executado nem interpretado por shell.** Se algo falhar, a janela abre normalmente e mostra o aviso em português (por exemplo, "O arquivo não foi encontrado: …"); nenhum projeto é criado.

Se o Braga Frame **já estiver aberto**, o processo novo entrega os argumentos à janela existente (`second-instance`), ela abre o vídeo e vem para a frente, e o processo novo encerra sozinho com código 0 (isso não é erro). Testado no Electron: abrir na partida, segunda instância com outro vídeo, argumentos inválidos e a forma com a pasta do app por extenso. A parte "trazer a janela à frente" depende das regras de foreground do Windows (pode apenas piscar na barra de tarefas): ver seção 9.

Não existe `--embedded` para o app próprio: a janela é sem moldura e, sem os controles dela, o usuário não teria como fechá-la. O modo embutido é testado pelo hospedeiro de teste.

### 6.2 Como o BDS descobre o executável

O Braga Frame **ainda não tem instalador** (`package.json` sem configuração de empacotamento). Até lá, a escolha segura é **configurável**: o usuário aponta o programa em Configurações (caminho guardado nas configurações do BDS) e, em desenvolvimento, o BDS usa `electron.exe` + a pasta `vendor/braga-frame` ou o repositório. As pastas abaixo são **convenções a adotar** quando o instalador existir (é o padrão do `electron-builder` NSIS por usuário com `productName: "Braga Frame"`; **a confirmar** quando o instalador do Braga Frame existir), não algo que já exista:

1. caminho configurado pelo usuário;
2. `%LOCALAPPDATA%\Programs\Braga Frame\Braga Frame.exe`;
3. `%ProgramFiles%\Braga Frame\Braga Frame.exe`;
4. (opcional) chave `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Braga Frame.exe`, se o instalador a gravar.

### 6.3 Código para o BDS (processo principal)

`src/core/integrations/bragaFrameApp.js` (novo). Sem shell, argumentos em lista, `detached` + `unref` (o BDS pode fechar sem fechar o Braga Frame). `shell.openPath(video)` **não** serve: abriria o programa associado ao tipo de arquivo, não o Braga Frame.

```js
'use strict';

/**
 * Braga Frame como app SEPARADO: acha o executável e o abre com um vídeo ("Braga Frame.exe" "C:\Videos\jogo.mp4").
 * Se o Braga Frame já estiver aberto, o processo novo só entrega o caminho à janela existente e encerra sozinho.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const EXE_NAME = 'Braga Frame.exe'; // nome do executável que o instalador do Braga Frame vai gerar (ainda não existe instalador)

/** Onde procurar, em ordem: 1) o caminho que o usuário escolheu nas Configurações do BDS; 2) pastas de instalação por usuário e por máquina. */
function candidateExecutables(configuredPath, env = process.env) {
  const list = [];
  if (configuredPath) list.push(configuredPath);
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'Braga Frame', EXE_NAME));
  if (env.ProgramFiles) list.push(path.join(env.ProgramFiles, 'Braga Frame', EXE_NAME));
  return list;
}

/** Primeiro executável que existe (arquivo comum) ou null. Nada é executado aqui. */
function findBragaFrameExe(configuredPath, env = process.env) {
  return candidateExecutables(configuredPath, env).find((file) => {
    try { return path.isAbsolute(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
  }) || null;
}

/**
 * Abre o Braga Frame com o vídeo. `videoPath` precisa ser um caminho COMPLETO de um arquivo de vídeo (o Braga Frame confere de novo
 * e avisa na tela se não servir). Sem shell: o caminho vai como argumento, nunca é interpretado. Resolve { ok, pid? } ou { ok:false, message }.
 */
function openInBragaFrame(exe, videoPath) {
  return new Promise((resolve) => {
    if (!exe) { resolve({ ok: false, message: 'O Braga Frame não foi encontrado. Escolha o programa em Configurações.' }); return; }
    let child;
    try {
      child = spawn(exe, [videoPath], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      resolve({ ok: false, message: `Não foi possível abrir o Braga Frame: ${err.message}` });
      return;
    }
    child.once('error', (err) => resolve({ ok: false, message: `Não foi possível abrir o Braga Frame: ${err.message}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
  });
}

/** Em desenvolvimento: electron.exe + pasta do Braga Frame + vídeo (equivale a `npm start -- "vídeo"` dentro da pasta dele). */
function openInBragaFrameDev(electronExe, bragaFrameDir, videoPath) {
  return new Promise((resolve) => {
    const child = spawn(electronExe, [bragaFrameDir, videoPath], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => resolve({ ok: false, message: `Não foi possível abrir o Braga Frame: ${err.message}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
  });
}

/** (Opcional) lê o caminho de um instalador que registre o App Paths do Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>. */
function exeFromRegistry(exeName = EXE_NAME) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const match = !err && /REG_SZ\s+(.+?)\s*$/m.exec(String(stdout));
      resolve(match && path.isAbsolute(match[1]) ? match[1] : null);
    });
  });
}

module.exports = { findBragaFrameExe, openInBragaFrame, openInBragaFrameDev, exeFromRegistry, candidateExecutables };
```

Uso (por exemplo, num handler IPC "abrir no Braga Frame"):

```js
const { findBragaFrameExe, openInBragaFrame } = require('../core/integrations/bragaFrameApp');
const exe = findBragaFrameExe(settingsManager.load().bragaFramePath);
const res = await openInBragaFrame(exe, caminhoCompletoDoVideo); // { ok:true, pid } | { ok:false, message }
```

### 6.4 Dados no app separado

O app separado usa o `userData` dele; projetos e fila **não** são os do módulo embutido. Para os dois enxergarem os mesmos projetos, o BDS pode abrir o app com `--user-data-dir=<dataDir>/braga-frame` (a linha de comando ignora essa opção), com o aviso da seção 5.9 sobre dois gravadores.

## 7. Colisão de canais

Os 91 canais do Braga Frame (contados com `windowControls: true`) comparados com os 280 handlers de `tests/fixtures/ipc-channels.json` do BDS: **colidem 4**, todos `window:*` (`window:minimize`, `window:maximize`, `window:fullscreen`, `window:close`). O módulo embutido **não os registra** (`windowControls` desligado) e, de qualquer forma, o BDS não registra os canais do Braga Frame no `ipcMain`: só `bf:invoke`. Prefixos que os dois usam (`app`, `shell`, `window`) não geram colisão exata, exceto os quatro acima. **Eventos do Braga Frame:** nenhum nome coincide com os eventos do BDS (e no BDS todos viajam dentro do único `bf:event`).

Se algum dia o BDS preferir registrar os canais direto (`ipcMain` + `channelPrefix: 'bf:'`), os nomes viram `bf:<canal>` (ex.: `bf:tools:status`) e não colidem com nada; o preload do BDS então precisaria de uma entrada por canal, o que é o que o canal genérico evita.

## 8. O que foi testado, e como rodar

```
node --test tests/host.test.js tests/host-cli.test.js tests/host-embed.test.js
node tests/e2e/embed.e2e.js          # abre o Electron de verdade (hospedeiro de teste + app próprio); cerca de 1 min
```

**Unitários (Electron falso):** opções inválidas; `meta`; estado só em `userDataDir`; `windowControls`; `ipcMain` falso com prefixo e `invoke` direto (mesma resposta); canal inválido/desconhecido; erros viram `{ok:false}`; handler que não carrega; eventos com/sem `send` e prefixo; ferramentas do hospedeiro (caminho, função, inexistente, relativa, que lança, troca em tempo de execução); `dispose` (fecha cada recurso uma vez, solta canais e ouvintes, idempotente, falha de um recurso não impede os outros); dois módulos independentes; fila de "abrir vídeo"; o **processo Node termina sozinho** depois de `dispose`; linha de comando (empacotado, desenvolvimento, opções, relativo, inexistente, pasta, formato, injeção, absurdos); protocolo `postMessage` com janelas falsas ligadas entre si (handshake, invoke, eventos, tema, drop, teclado, expiração, `close`, validação e mensagens forjadas).

**E2E (Electron 43, `tests/e2e/embed.e2e.js`):** hospedeiro de teste com preload `sandbox`, sem `nodeIntegration`, recusando chamadas que não vêm do frame principal (como o registrador do BDS), carregando o Braga Frame num `iframe` e usando **um** canal genérico com `channelPrefix: 'bf:'`:
carrega sem erros de console; menu em trilho (64 px) sem controles de janela, botão de recolher nem região de arrasto; o iframe não tem `require`, `process` nem `hostApi`; `tools:status` e `app:info` pela ponte; ffmpeg do hospedeiro vence a variável `CORTE_FFMPEG`; `source:open` pelo canal genérico cria o projeto em `<hospedeiro>/braga-frame/projects` e **em nenhum outro lugar**; abrir vídeo e salvar corte pela interface; as 11 telas pelo menu de 5 itens (itens, abas internas e o botão de Projetos para Novo projeto); botão "Abrir vídeo" (diálogo do hospedeiro); `app:requestOpen` e `requestOpen` (pedido válido abre, inválido avisa); tema nos dois sentidos; eventos (`tools:changed` e o real `queue:update`); foco; mensagens forjadas barradas e `window:close` inexistente; **arrastar e soltar** no iframe (evento de arrasto real do Chromium) com a tela Novo projeto aberta: dois arquivos abrem só o primeiro, avisam do outro e o app segue para Cortes; `dispose()` com **exportação real em andamento** (job vira `interrupted`, o ffmpeg para, nenhum `.part` fica, o módulo responde `MODULE_DISPOSED`); `close()` grava o corte pendente; a CSP literal do BDS (com o bfEmbedHost.js importado como módulo ES, como as telas do BDS); **a cópia só com `renderer/`, `src/` e `package.json`** (a de `vendor/braga-frame`) carrega e funciona sozinha; hospedeiro sem processos restantes. **App próprio:** vídeo na linha de comando abre na partida; segunda instância (`.` e pasta do app por extenso) faz a primeira abrir o projeto; argumentos inválidos (relativo, inexistente, formato) viram aviso e não abrem nada; janela própria mantém controles e usa o preload (não a ponte).

Regressão do app próprio: `tests/e2e/app.e2e.js` passa; `tests/ipc-base.test.js`, `tests/preload.test.js`, `tests/renderer-base.test.js` e `tests/single-instance.test.js` passam. Para o lado do BDS foram feitas **simulações** (fora do repositório, sem tocar no BDS): geração do `preload.js` com o gerador do BDS numa cópia, e `frameModule.js` + `frameHandlers.js` + `bragaFrameApp.js` rodando com `electron`, `logService`, adaptadores de ferramentas e registrador falsos.

## 9. Riscos e decisões em aberto

**Não verificado**

- O **BDS real nunca foi alterado nem rodou com o módulo**. Os trechos das seções 5 e 6 foram escritos lendo o código do BDS e simulados com dublês; a tela `frame.js/css` (layout dentro de `.content`) e a integração com `app.js`/`startup.js` precisam ser vistas na tela pelo dono.
- **Build empacotado do BDS** (`app.asar`): iframe de `file://…/app.asar/vendor/…`, `electron-builder`, `verify-package-contents`. Não testado.
- `forwardKeys` só por teste unitário; "trazer a janela à frente" da segunda instância depende das regras de foreground do Windows (o teste confere o fluxo, não o foco real).
- O nome da pasta de dados do app separado (`%APPDATA%\braga-frame`) é o padrão do Electron pelo `name` do `package.json`; não foi conferido num app instalado. Não existe instalador do Braga Frame.
- Desempenho/memória do iframe dentro do BDS (um processo de renderização a mais com a tela aberta?): não medido.

**Riscos conhecidos**

1. **`encoders.js` é global**: guarda a pasta de cache do último módulo registrado (`encoders.configure`). Com dois módulos no mesmo processo, o cache de "qual codificador funciona" de um pode ser gravado na pasta do outro. É só cache regenerável; o certo seria o dono do `exportEngine` guardar isso por instância.
2. **Superfície do iframe**: pelo canal genérico, o iframe alcança **todos** os canais do Braga Frame (incluindo `shell:reveal`, downloads e instalar ferramentas). É código do próprio produto, mas o BDS pode restringir com `isChannelAllowed` (host) e/ou uma lista permitida no `frameHandlers.js`. O registrador do BDS garante que só a página do BDS (e não o iframe) chama o IPC dele.
3. **`postMessage` com `targetOrigin: '*'`** nas respostas, por causa da origem opaca de `file://`; o destino é sempre `iframe.contentWindow`, e o iframe só aceita o que vem de `window.parent`.
4. **Dois gravadores** (módulo embutido + app separado na mesma pasta de dados) se atrapalham: a trava de instância única só protege dois processos do app separado entre si.
5. **Pasta de downloads padrão** do Braga Frame é `app.getPath('videos')` (Vídeos do usuário), não a pasta do módulo: é conteúdo do usuário, não estado do módulo.
6. **Sair da tela destrói o iframe**: o projeto aberto e a aba são esquecidos (a fila de exportação continua no processo principal). Manter o iframe vivo preserva a tela, mas deixa vídeo/memória e exige desmontar ao desligar o módulo.

**Decisões em aberto (do dono)**

1. **Colar os trechos da seção 5 no BDS?** E onde fica a cópia: `vendor/braga-frame` (cópia/`git submodule`) ou outra pasta fora de `src/`.
2. **Duas cópias do ffmpeg**: resolvida por `options.tools` (o BDS é o dono). Falta decidir se o yt-dlp/whisper do BDS também são os do módulo (o trecho já faz) e se os **modelos do Whisper** (GB) passam a ser compartilhados (hoje cada app baixa os seus).
3. **Versão do Electron**: os dois declaram `electron ^43.7.7`. Embutido, o código do Braga Frame roda no Electron do BDS; se o BDS subir de versão, o `embed.e2e.js` (com a CSP do BDS) deve ser reexecutado.
4. **Tema e acento**: os dois usam os mesmos tokens (acento vermelho `#ff0000`) e o BDS repassa o tema. Falta decidir o botão de tema dentro do iframe (redundante embutido; esconder exige mexer em `renderer/features/shell.*` do Braga Frame) e se o menu em trilho do Braga Frame ao lado do menu do BDS (dois menus) é aceitável.
5. **Instalador único**: ao embutir, o Braga Frame deixa de precisar do próprio instalador para os usuários do BDS; para o app separado ainda é preciso definir o instalador (e as convenções da seção 6.2).
6. **Estado da tela** ao sair (seção 5.6) e **atalhos** (`forwardKeys: true` leva Ctrl+K etc. do BDS a funcionar com o foco no iframe; se algum atalho do Braga Frame com Ctrl colidir, desligue).
7. **Compartilhar a pasta de dados** entre embutido e separado (seção 5.9) ou manter separadas (recomendado).

## 10. Integração feita no BDS (estado atual)

**Onde está.** BDS: `vendor/braga-frame/` (cópia gerada), `scripts/sync-braga-frame.js`, `src/core/modules/frameModule.js`, `src/ipc/frameHandlers.js`, `renderer/screens/frame.{html,css,js}`, entradas em `ModuleRegistry.js`, `renderer/index.html` (menu), `renderer/app.js` (MODULE_GATED_SCREENS), `src/ipc/channels.js` + `preload.js` (gerado) + fixtures, `src/ipc/index.js`, `src/bootstrap/moduleRuntime.js` (HOOKS.frame), `package.json` (build.files e scripts), `eslint.config.js`, `scripts/verify-package-contents.js` e `src/core/modules/README.md`. A lista exata está em `LISTA-DE-ARQUIVOS.txt` da sessão.

**Como re-sincronizar** (depois de mudar o Braga Frame): na pasta do BDS, `npm run sync:braga-frame` (usa a pasta irmã "Braga Frame" ou `--source <pasta>` / variável `BRAGA_FRAME_DIR`); `npm run verify:braga-frame` confere a cópia. Nunca edite dentro de `vendor/braga-frame`.

**O que o Braga Frame ganhou para isso** (modo embutido, `createBfModule`):
- `options.tools` aceita também `deno`; `options.hostName` ("BDS") e `options.embedded`; `ctx.host = { embedded, name, tool(chave), whisperModels }`.
- `options.whisperModels = { resolve(id), install(id, { signal, onProgress }), cancel?(id) }`: o `ModelManager` usa o arquivo do hospedeiro só se tamanho e SHA-256 batem com o catálogo daqui (`verifyHost`, uma vez por arquivo, sem travar o processo; `subtitles:generate` espera essa conferência), delega a instalação ao hospedeiro e recusa remover (`HOST_MANAGED`). Nenhuma pasta de modelos própria é criada.
- Ferramentas fornecidas pelo hospedeiro: `tools:status` marca `origin: 'host'` (ffmpeg, ffprobe, yt-dlp, Deno, whisper-cli, com versão); `tools:install` delas é recusado (`HOST_PROVIDED`: não há segunda cópia); o aviso de yt-dlp antigo manda atualizar pelo hospedeiro. O que o hospedeiro não tem (TwitchDownloaderCLI) continua instalável.
- Interface embutida: `?themeLocked=1` esconde o botão de tema; `bfEmbedHost` aceita `accent` (variáveis `--accent*`) e `themeLocked`; a ponte aplica o acento recebido (`init`/`theme` com `accent`); `setAccent()`.

**IA na nuvem (análise de cortes por IA).** O BDS entrega `options.ai` (`src/core/modules/frameModule.js`, `aiBridge`) apoiada em dois métodos novos e aditivos do `AIService` (`complete()`, uma requisição crua com o provedor ativo e o mesmo fallback do assistente, sem o limite de 20000 caracteres por mensagem; `describeActive()`, o provedor ativo sem a chave) e em `temperature`/`jsonMode` opcionais no `OpenAIProvider.chat` (repete sem `response_format` se o servidor recusar). `registerAiHandlers` devolve o `AIService` e o `ipc/index.js` o passa a `registerFrameHandlers({ getAiService })`. Nenhuma chave entra no Braga Frame nem é copiada para a pasta `braga-frame`; a configuração do provedor continua sendo a do assistente (Configurações → Assistente de IA). **A trava "Usar apenas modelos gratuitos" do OpenRouter vale também no BDS** (pedido do dono, 23/10/2026). O Braga Frame reconhece o OpenRouter pelo `serverHost` que o `describe()` do hospedeiro informa (`openrouter.ai`); com o modo ligado (padrão; o interruptor "Usar apenas modelos gratuitos" aparece na aba Análise, é do Braga Frame e é o único ajuste daqui) o modelo do assistente passa pelo MESMO guard do app próprio: modelo pago deixa o provedor "não pronto" (`NOT_FREE`, nada é enviado) e o `chat` do hospedeiro recebe `acceptProvider(p)`, que o `AIService` do BDS usa para filtrar a CADEIA de fallback (`complete({ accept })`: provedor recusado nem é tentado; se recusar todos, `AI_NOT_ALLOWED`, que o Braga Frame mostra como `NOT_FREE`). Outros provedores do BDS (Gemini, Groq, OpenAI, locais…) não são afetados. A lista pública de modelos é conferida antes da análise, como no app próprio. O **perfil de humor do canal** (critérios, listas e os exemplos de cortes aprovados e rejeitados) vai no mesmo pedido que o BDS faz pelo provedor do assistente e fica nas Preferências do módulo (pasta `braga-frame`), não no BDS; nada muda na ponte (`describe`/`chat`). Dentro do BDS continuam ausentes a lista de modelos gratuitos, o selo de pedidos restantes e os modelos de reserva (o modelo e a chave são do assistente do BDS: a aba mostra "Usando o provedor do BDS" e nenhum canal `aiOpenrouter:*` é chamado; esse domínio **não** está em `ALLOWED_DOMAINS` do iframe e **não precisa** estar). O modelo que respondeu aparece porque o `AIService.complete` devolve `model` (aceito como `answeredModel`). Mudanças no BDS: `AIService.complete({ accept })`, `_runChain({ accept })`, `_publicView`, o código `AI_NOT_ALLOWED` e a ponte `aiBridge.chat` (`frameModule.js`), cobertas por `tests/braga-frame-module.test.js`.

**Decisões tomadas:** o iframe é destruído ao sair da tela (grava o projeto antes; menos memória); dados em `<dataDir>/braga-frame`; o motor do whisper do BDS é compartilhado (CUDA se instalado, senão CPU); lista permitida de recursos no `frameHandlers` (sem `window:*`). **Limites documentados:** cookies/sessão do YouTube do BDS não são compartilhados; o `FfmpegLimiter` do BDS não envolve as exportações do Braga Frame (fila própria); se o BDS não tem o motor do Whisper, o Braga Frame baixa o dele.

**Testes.** BDS: `tests/braga-frame-module.test.js`; E2E real `node tests/e2e/braga-frame.e2e.js [--shots <pasta>]` (copia o app para uma pasta temporária, liga o módulo pela interface, abre um vídeo, exporta um corte com o ffmpeg do BDS, prova "fornecido pelo BDS" sem downloads, confere a tela Exportações dentro do iframe (o corte exportado em Concluídos e a barra de saída com o perfil e o destino do projeto), a tela Novo projeto dentro do iframe (os quatro cartões, a área de soltar e um painel por vez), a tela Início (boas-vindas, atalhos e o projeto aberto entre os recentes), a aba Projetos (miniatura do vídeo carregada, confirmação da lixeira e **apagar o projeto aberto**: o corte exportado sai com ele, o vídeo do usuário fica, o iframe recarrega com o aviso e nada é regravado), tema/acento, desligar sem órfãos). Braga Frame: `tests/host-shared.test.js`.

**Não verificado:** build/instalador empacotado do BDS (`app.asar`), Windows instalado de verdade, alimentar o BDS com a CSP endurecida, uso de memória do iframe, o fluxo de instalar um modelo novo pelo ModuleManager real (só com dublê; a instalação real baixa gigabytes) e os motores de GPU (CUDA).
