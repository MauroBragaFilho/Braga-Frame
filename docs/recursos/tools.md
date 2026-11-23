# Ferramentas oficiais (instalador, IPC e tela)

Contrato: [`docs/arquitetura.md` 3.7](../arquitetura.md). Este documento descreve (1) como **outro recurso acrescenta uma ferramenta** (próxima seção), (2) a **ligação com o app**: IPC `tools:*`, resolução do `ctx.tools` e a aba Ferramentas, e (3) o **núcleo** do instalador: baixar, conferir, extrair e registrar binários externos de **releases oficiais** (whisper.cpp, yt-dlp, TwitchDownloaderCLI…).

## Como um recurso acrescenta uma ferramenta

1. **Crie a entrada** `src/core/tools/entries/<id>.js` (formato em [`entries/README.md`](../../src/core/tools/entries/README.md)): release **oficial** do projeto, URL `https` fixa, versão, tamanho exato e SHA-256. Nada mais é preciso para ela aparecer na aba Ferramentas e poder ser instalada/removida.
2. **Use o id certo** se o app precisa do caminho: só estes ids alimentam o `ctx.tools` (mapeamento em `src/core/tools/catalog.js`, `TOOL_KEY_BY_ID`):

   | id da entrada | chave em `ctx.tools` | variável de ambiente | nome no PATH |
   |---|---|---|---|
   | `ytdlp` | `ytdlp` | `CORTE_YTDLP` | `yt-dlp` |
   | `whisper` | `whisper` | `CORTE_WHISPER` | `whisper-cli` |
   | `twitchdownloader` | `twitchDownloader` | `CORTE_TWITCHDOWNLOADER` | `TwitchDownloaderCLI` |

   Uma entrada com outro id aparece na tela e instala normalmente, mas nenhum módulo a recebe pelo `ctx.tools`. (O `ffmpeg` agora também vem do registro: a entrada `ffmpeg` alimenta `ctx.tools.ffmpeg` e, pelo campo `alsoExe` do pacote, `ctx.tools.ffprobe`. O `ffprobe` não tem entrada própria.)
3. **Pegue o caminho na hora de usar**: `ctx.tools.whisper` (caminho ou `null`; nunca guarde o valor). Se for `null`, devolva erro explicando que a ferramenta precisa ser instalada na aba **Ferramentas** e deixe a ação desabilitada na interface. No renderer, `BF.state.tools.whisper` e o evento `BF.bus 'tools:changed'` mantêm a interface em dia.
4. **Declare que está usando a ferramenta** enquanto houver trabalho dela em andamento (fila, legendas, fontes), para o app não remover/atualizar o programa no meio do trabalho:

   ```js
   const off = ctx.toolUsage.register((key) => (key === 'whisper' && running.size > 0 ? 'a geração de legendas está rodando' : null));
   ```

   `register(fn)` devolve a função que cancela o registro; `fn(chave, id)` devolve o motivo (texto curto, entra na mensagem de erro) ou `null`. Com motivo, `tools:remove`, `tools:install { force:true }` e a atualização de uma versão antiga respondem `TOOL_IN_USE` (instalar pela primeira vez nunca é bloqueado).
5. **Teste** sem baixar nada da internet: servidor HTTP local + `BF_TEST_TOOL_ENTRIES` (veja "Entradas de teste") ou um `ctx` falso com `toolCatalog` (veja `tests/tools-ipc.test.js`).
6. A primeira instalação real (GitHub) precisa ser conferida à mão por quem criar a entrada: não existe teste que baixe da internet.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/tools/ToolInstaller.js` | `ToolInstaller`: `install`, `cancel`, `remove`, `status`, `cleanupStaging`; download, verificação, extração, instalação atômica |
| `src/core/tools/registry.js` | Carrega e valida `entries/*.js`; escolhe o pacote por `<sistema>-<arquitetura>`; `resolveInstalled`, `resolveAll`, `status`; `ToolError` |
| `src/core/tools/catalog.js` | Catálogo do app: entradas oficiais + entradas de teste; id da entrada -> chave de `ctx.tools` (`toolKeyFor`) |
| `src/core/tools/entries/README.md` | Formato das entradas (quem cria uma ferramenta lê este) |
| `src/core/ffmpeg/locate.js` | `findTool(nome, variável, env)` / `findTools(specs, env)` / `locateTools(env)`: variável de ambiente (precisa ser um arquivo) e depois PATH, varrido pelo próprio Node numa única passagem (sem `where`/`which`: funciona com pasta de acento, não executa nada da pasta atual e custa milissegundos) |
| `src/ipc/context.js` | `resolveTools`, `ctx.tools`, `ctx.refreshTools`, `ctx.toolCatalog`, `ctx.toolUsage` |
| `src/ipc/handlers/tools.js` | Canais `tools:status`, `tools:install`, `tools:cancel`, `tools:remove` e eventos `tools:progress` |
| `renderer/features/tools.js` / `.css` | Aba **Ferramentas** (ordem 90) |
| `renderer/features/transcription.js` / `.css` | Cartão **Transcrição (legendas automáticas)** da aba Ferramentas: instala o motor do Whisper e os modelos (`BF.transcription`); veja `docs/recursos/subtitles.md` |
| `tests/tools-*.test.js`, `tests/tools-fixtures.js`, `tests/e2e/tools.e2e.js` | Testes (servidor HTTP/HTTPS local de verdade, zip/tar.gz gerados no teste, app Electron real) |
| `tests/transcription-ui.test.js`, `tests/e2e/transcription.e2e.js` | Testes do cartão da Transcrição (DOM de mentira; app Electron real com motor e modelos servidos por HTTP local) |

## Ligação com o app

### IPC (`src/ipc/handlers/tools.js`)

| Canal | Payload | Resposta |
|---|---|---|
| `tools:status` | — | `{ ok, platform, system, tools }` (abaixo) |
| `tools:install` | `{ id, force? }` | `{ ok, id, version, path, alreadyInstalled }`; só volta quando termina (o progresso vai por `tools:progress`). Sem `force`, instalação íntegra da versão fixada não baixa nada |
| `tools:cancel` | `{ id }` | `{ ok, cancelled }` (a chamada de `tools:install` volta com `CANCELLED`) |
| `tools:remove` | `{ id }` | `{ ok, id, removed }` (`removed:false` = não havia nada instalado) |

`tools:status`:

```js
{ ok: true, platform: 'win32',
  system: [ { id: 'ffmpeg'|'ffprobe', label, found, path, version } ],        // só do sistema; version = "7.1.1" ou "build 2026-02-09" (null se não deu para ler)
  tools:  [ { id, label, version /* fixada no app */, source, sizeBytes,       // uma por entrada do registro, na ordem do registro
              available, unavailableReason,                                    // o projeto oficial publica pacote para este sistema?
              installed, installedVersion, outdated, installedAt, busy,       // do app (registry.status + instalação em andamento)
              active: { origin: 'app'|'system'|null, path },                   // o que o ctx.tools usa de fato
              test } ] }                                                      // true = entrada de teste (BF_TEST_TOOL_ENTRIES)
```

Eventos (main -> renderer): `tools:progress { id, label, phase, message, percent, received, total, speedBps }` (as fases são as do `progress` do instalador; `percent` é `null` quando não há percentual) e `tools:changed { tools }` (o `ctx.tools` atualizado; o `app.js` repassa ao `BF.bus 'tools:changed'` e atualiza `BF.state.tools`). Depois de instalar ou remover, o handler chama `ctx.refreshTools({ force: true })`: o `tools:changed` sai **mesmo que o `ctx.tools` não tenha mudado** (a tela precisa recarregar a lista).

Erros (`{ ok:false, code, message }`, mensagem em português com causa e solução): os do instalador (lista abaixo) e `INVALID_ARGS` (id ausente), `UNKNOWN_TOOL` (id fora do catálogo, inclusive em `cancel`/`remove`), `TOOL_IN_USE` (alguém declarou em `ctx.toolUsage` que usa a ferramenta). Fechar o app no meio de uma instalação a cancela (`before-quit`); ao iniciar, `cleanupStaging()` apaga resíduos.

### Resolução do `ctx.tools` (`resolveTools` em `src/ipc/context.js`)

1. **ffmpeg / ffprobe**: o que o **app instalou** (botão "Instalar o FFmpeg"; `registry.resolveInstalled` e `registry.resolveExtras`, reconferidos no disco a cada chamada) tem preferência; sem isso, `CORTE_FFMPEG` / `CORTE_FFPROBE` e depois o PATH. O projeto FFmpeg não publica binários, então o pacote é uma **compilação de terceiros** (Gyan Doshi, a que ffmpeg.org/download.html indica), GPL v3, **só baixada quando o usuário clica** e nunca embutida no instalador. Os dois programas vêm do mesmo pacote: sem qualquer um deles a instalação não vale e os dois voltam para o sistema (nunca um de cada lugar). Detalhes da entrada em `entries/ffmpeg.js`.
2. **yt-dlp, whisper, TwitchDownloaderCLI**: a **instalada pelo app** (`registry.resolveInstalled`, reconferida no disco a cada chamada) tem preferência; sem ela, a variável `CORTE_*` da tabela acima e depois o PATH. Remover a do app devolve o uso da do sistema, se houver.

`ctx.refreshTools()` refaz essa busca, atualiza `ctx.tools` no lugar e avisa só se algo mudou. `ctx.toolCatalog` (`{ entries, errors, allowLoopbackHttp, testIds }`) é a lista de entradas em uso; `deps.toolCatalog` e `deps.env` permitem injetar tudo em testes com `createContext`.

### Entradas de teste (`BF_TEST_TOOL_ENTRIES`)

O e2e instala uma "ferramenta" servida por HTTP local. Para isso, `src/core/tools/catalog.js` (o **único** arquivo que menciona a variável) aceita `BF_TEST_TOOL_ENTRIES` = JSON de uma entrada ou de uma lista de entradas (mesmo formato de `entries/*.js`, com `http://127.0.0.1:<porta>/…`), **somente se** `NODE_ENV === 'test'` **e** o app não estiver empacotado (`app.isPackaged === false`; indefinido conta como empacotado) **e** todas as URLs forem de loopback. A entrada de teste substitui a oficial de mesmo id, aparece na tela com o selo "teste local" (nunca passa por oficial) e o app registra um aviso no log. Em produção (app empacotado) a variável é ignorada por completo, mesmo com `NODE_ENV=test`. Garantias testadas em `tests/tools-catalog.test.js` (matriz de ambientes bloqueados, URL não local recusada e uma varredura que falha se qualquer outro arquivo de `src/`, `renderer/`, `main.js` ou `preload.js` citar a variável) e no e2e (com `NODE_ENV=production` a entrada é ignorada).

### Catálogo de modelos de teste (`BF_TEST_MODELS`)

O e2e da transcrição baixa "modelos" de um servidor local. `src/core/subtitles/models.js` (o **único** arquivo que menciona a variável) aceita `BF_TEST_MODELS` = JSON `{ baseUrl, catalog }` (o `catalog` no formato de `MODELS`, com revisão, tamanho e SHA-256 fixados) **somente se** `NODE_ENV === 'test'`, o app não estiver empacotado (`isPackaged === false`), o endereço for `http` de loopback e todo item do catálogo for válido; qualquer falha devolve `null` e o app usa o catálogo oficial. Testado em `tests/subtitles-models.test.js` (matriz de ambientes bloqueados e uma varredura que falha se outro arquivo de `src/`, `renderer/`, `main.js` ou `preload.js` citar a variável).

### A aba Ferramentas (`renderer/features/tools.js`)

- **No seu computador**: FFmpeg e FFprobe com versão, caminho e a origem (do sistema, do hospedeiro ou "Instalado pelo app"); as linhas não têm botão. Se faltar algum, o bloco "O FFmpeg não está instalado" traz o botão **Instalar o FFmpeg** (no Windows 64 bits: baixa o pacote fixo, ~100 MB, com tamanho e SHA-256 conferidos, depois de uma confirmação que diz que é de terceiros, com licença GPL v3, e que dá para cancelar; a barra de progresso aparece ali e na linha) e, recolhida, a instalação à mão (página ffmpeg.org/download.html, PATH ou `CORTE_FFMPEG`/`CORTE_FFPROBE`, reabrir o app). Nos outros sistemas, sem pacote, só as instruções à mão. Também há "Verificar de novo" (`app:refreshTools`). A aba mostra "!" enquanto faltar FFmpeg/FFprobe, e o aviso do topo (`shell.js`) traz o mesmo resumo (é nele que o usuário lê isso sem vídeo aberto, já que o painel lateral só aparece com um vídeo).
- **Transcrição (legendas automáticas)**: cartão próprio (`renderer/features/transcription.js`), entre "No seu computador" e "Instaladas pelo app", para o usuário instalar o que a legenda automática e a transcrição do vídeo precisam **sem abrir vídeo nem corte** (a aba Legendas só mostra o bloco de instalação com um corte escolhido). Um botão, **Instalar a transcrição**, baixa o motor (Whisper) e o modelo recomendado, um depois do outro, com **uma** confirmação que diz o tamanho total e de onde vem (GitHub oficial do whisper.cpp e Hugging Face), "Passo 1 de 2" e "Passo 2 de 2" com progresso real e **Cancelar**. Só falta o modelo: **Baixar o modelo Pequeno**; só falta o motor: o botão baixa só ele; pronta: resumo ("motor do app · processador · 2 modelos baixados") e **Remover o motor** (só o que o app instalou). Abaixo, a lista dos cinco modelos (tamanho, Recomendado, Baixar, Cancelar, Remover; os de 200 MB ou mais pedem confirmação) e, com placa NVIDIA utilizável, a **aceleração pela placa** (opcional; a confirmação cita que as bibliotecas da NVIDIA têm licença própria, botão "Baixar e aceitar"). O motor e o pacote NVIDIA (`whisper`, `whisper-cuda`) **não têm linha** na lista "Instaladas pelo app"; se a leitura do cartão (`subtitles:status`) falhar, voltam para ela. Do hospedeiro (BDS): "Fornecido pelo BDS", sem remover. O cartão avisa `transcription:changed` quando o que está instalado muda (a Análise e as Legendas se atualizam); os botões "Instalar a transcrição" da Análise e das Legendas chamam `BF.transcription.install()`, que leva à aba Ferramentas e, no fim, devolve o usuário à tela de origem.
- **Placa de vídeo**: uma linha discreta no topo ("Placa NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa", de `subtitles:hardware`) e a aceleração pela placa, a entrada **`whisper-cuda`** (oferecida no cartão da Transcrição; motor do Whisper para placa NVIDIA, 674 539 285 bytes, release oficial b5130, só Windows x64; veja `docs/recursos/subtitles.md`). Downloads grandes (>= 200 MB) mostram o aviso "Download grande" na linha e pedem confirmação antes de baixar. No módulo embutido, se o hospedeiro fornece o motor do Whisper, `whisper-cuda` não aparece e `tools:install` dele é recusado (`HOST_PROVIDED`).
- **Instaladas pelo app**: só aparece se o registro tiver entradas (sem entrada, sem placeholder); o motor e o pacote NVIDIA do Whisper ficam no cartão da Transcrição, não aqui. Uma linha por ferramenta com estado (não instalado / usando a do sistema / instalado / versão antiga / indisponível neste sistema com o motivo / instalando), versão, origem oficial, tamanho do download, e os botões Instalar, Atualizar, Remover (com confirmação) ou Cancelar; barra de progresso com percentual, bytes e velocidade (indeterminada na extração); erro de cada tentativa explicado na própria linha; `<details>` com caminho em uso e data. Atualiza com `tools:changed` e `tools:progress`; o foco do teclado acompanha o botão ao redesenhar.

## Pedidos de contrato (para `arquitetura.md`)

Quem consolida o contrato deve incorporar:

- **Seção 1.1 (`ctx`)**: `ctx.refreshTools({ force })`, `ctx.toolCatalog`, `ctx.toolUsage` (`register(fn) -> off`, `inUse(chave, id) -> motivo|null`), `deps.env` e `deps.toolCatalog` no `createContext`.
- **Seção 3.7 (ferramentas)**: IPC e eventos da tabela acima (`tools:status` devolve `system` e `tools`; `tools:progress` usa `received`/`total`; `tools:install` aceita `force`; códigos `INVALID_ARGS`, `UNKNOWN_TOOL`, `TOOL_IN_USE`).
- **Seção 5, "Resolução de ferramentas"**: o texto atual diz que whisper e twitchDownloader são `null` e que só `CORTE_FFMPEG`, `CORTE_FFPROBE` e `CORTE_YTDLP` existem. Agora: instalada pelo app > `CORTE_*` > PATH, e foram acrescentadas `CORTE_WHISPER` e `CORTE_TWITCHDOWNLOADER` (PATH: `whisper-cli`, `TwitchDownloaderCLI`).
- **Seção 1.3**: a aba `tools` deixou de ser stub; o painel lateral continua só visível com vídeo aberto (veja o problema abaixo).
- **Problema conhecido (base/layout)**: sem vídeo aberto o painel lateral (e portanto a aba Ferramentas e a Fontes) não é alcançável; para yt-dlp/TwitchDownloader, que são necessários *antes* de existir um vídeo, o layout deveria expor a aba Ferramentas também no estado vazio (por exemplo, painel sempre visível ou um atalho na barra superior).

## Em disco

```
<toolsDir>/                      (= ctx.paths.tools)
  <id>/<versão>/                 instalação (pasta completa, nasce pronta)
    manifest.json                versão, arquivo, sha256, data, origem…
    <executável e arquivos do pacote>
  .tmp/                          pasta de trabalho (some quando vazia)
    <id>-XXXXXX/                 uma instalação em andamento (.part, extract/, files/)
    trash-*/                     lixo que ainda estava em uso (veja "Programa em uso")
```

`manifest.json`:

```json
{ "schema": 1, "id": "whisper", "label": "…", "version": "b5130",
  "file": "whisper-bin-x64.zip", "sha256": "…", "size": 8573270,
  "exe": "whisper-cli.exe", "exeSize": 123456,
  "platform": "win32-x64", "url": "https://…", "source": "oficial: https://…",
  "installedAt": "2026-10-21T05:57:03.804Z" }
```

## Uso

```js
const { ToolInstaller } = require('./src/core/tools/ToolInstaller');
const registry = require('./src/core/tools/registry');

const installer = new ToolInstaller({ toolsDir: ctx.paths.tools });
installer.cleanupStaging();                                   // ao iniciar o app: varre resíduos
installer.on('progress', (ev) => ctx.send('tools:progress', ev));

installer.status();                                           // [{ id, label, version, installed, path, available, … }]
const r = await installer.install('whisper');                 // { id, version, dir, exe, manifest, alreadyInstalled }
await installer.install('whisper', { force: true });          // refaz o download e substitui com segurança
installer.cancel('whisper');                                  // true se havia instalação em andamento
await installer.remove('whisper');                            // { id, removed }

registry.resolveInstalled(ctx.paths.tools, 'whisper');        // caminho do .exe ou null (reconfere o disco)
registry.resolveAll(ctx.paths.tools);                         // { whisper: '…\\whisper-cli.exe', ytdlp: null, … } (base do ctx.tools)
```

Opções do construtor: `toolsDir` (obrigatório), `entries` (padrão: `entries/*.js`), `platform`/`arch` (padrão: o sistema atual), `attempts` (3), `backoffMs` (1500), `maxRedirects` (5), `idleTimeoutMs` (30000), `extractTimeoutMs` (10 min), `allowLoopbackHttp` (**só para testes**: aceita `http://localhost`).

`install(idOuEntrada, { signal, force, onProgress })`: aceita um `AbortSignal` externo ou `installer.cancel(id)`. Sem `force`, uma instalação íntegra da versão fixada é devolvida como está (`alreadyInstalled: true`) sem baixar nada. Uma instalação por ferramenta por vez (`BUSY`); ferramentas diferentes podem instalar em paralelo.

### `status()` / `registry.status(toolsDir)`

Uma linha por entrada: `id`, `label`, `version` (a fixada no app), `installed` (a versão fixada está instalada **e íntegra**), `path` (executável ou `null`), `available` (o projeto oficial publica pacote para este sistema), `unavailableReason` (pt-BR, quando `available` é `false`), `source`, `sizeBytes` (tamanho do download), `installedVersion`, `outdated` (só há uma versão antiga instalada: instalar atualiza), `installedAt`; o `installer.status()` acrescenta `busy`.

Quando `available` é `false` a interface deve mostrar `unavailableReason` e deixar a ação desabilitada (regra "nada fictício").

### Eventos `progress`

`{ id, label, phase, message, percent, receivedBytes, totalBytes, speedBps }`

| `phase` | Quando |
|---|---|
| `prepare` | verificando espaço, criando a pasta de trabalho |
| `download` | baixando (`percent` 0 a 100; mensagem de nova tentativa quando a conexão cai) |
| `verify` | tamanho e SHA-256 conferidos |
| `extract` | extraindo o pacote (sem percentual) |
| `install` | gravando o manifesto e publicando |
| `done` | concluído (`percent: 100`) |
| `cancelled` / `error` | último evento antes de a promessa rejeitar (`message` em pt-BR) |

### Erros (`ToolError`, com `code` e `message` em pt-BR)

`CANCELLED`, `BUSY`, `UNKNOWN_TOOL`, `INVALID_ENTRY`, `PLATFORM_UNAVAILABLE`, `DISK_SPACE`, `INSECURE_URL`, `BAD_URL`, `REDIRECT_DOWNGRADE`, `TOO_MANY_REDIRECTS`, `HTTP_<status>`, `TIMEOUT`, `INCOMPLETE` (conexão caiu), `NETWORK`, `TLS` (certificado não confiável), `WRITE_FAILED`, `SIZE_MISMATCH`, `CHECKSUM_MISMATCH`, `EXTRACT_UNAVAILABLE`, `EXTRACT_UNSAFE` (zip-slip), `EXTRACT_FAILED`, `EXE_MISSING`, `INSTALL_FAILED`, `REMOVE_FAILED`. Servem direto no `{ ok:false, code, message }` do `ctx.handle`.

Repetidos automaticamente (até `attempts`): `TIMEOUT`, `INCOMPLETE`, `NETWORK`, HTTP 5xx/408/429. Nunca repetidos: integridade (`SIZE_MISMATCH`, `CHECKSUM_MISMATCH`), `HTTP_4xx`, `TLS`, cancelamento.

### Ligação no IPC

Feita em `src/ipc/handlers/tools.js` (veja "Ligação com o app"): cria o `ToolInstaller` com `ctx.paths.tools` e o catálogo do `ctx`, converte o evento `progress` em `tools:progress` (`receivedBytes`/`totalBytes` viram `received`/`total`), chama `installer.cleanupStaging()` ao registrar, cancela tudo em `before-quit` e, depois de instalar/remover, `ctx.refreshTools({ force: true })`. Antes de `force`/atualizar/`remove` consulta `ctx.toolUsage` (nenhum job pode estar usando a ferramenta).

## Garantias

1. **Só fonte oficial, fixada**: a entrada traz URL `https`, tamanho e SHA-256. O download vai para `<nome>.part`; só depois de **tamanho e SHA-256** conferidos vira o arquivo final. Servidor que manda mais bytes que o declarado é cortado no meio; `Content-Length` diferente do esperado é recusado antes de baixar.
2. **HTTPS obrigatório**: `http` só é aceito em loopback e apenas com `allowLoopbackHttp` (testes). Redirecionamento de `https` para `http` é bloqueado; no máximo 5 redirecionamentos; certificado não confiável é recusado (`TLS`).
3. **Zip-slip**: antes de extrair, a lista de entradas (`tar -tf`) é validada (sem `..`, caminho absoluto, letra de unidade, variações com barra invertida e, no Windows, `:`); depois de extrair, links simbólicos/junções precisam ser relativos e ficar dentro da pasta. Nada é gravado fora da pasta de trabalho.
4. **Nunca pela metade**: todo o trabalho (download, extração, manifesto) acontece em `.tmp/<id>-XXXXXX/`; a pasta final só aparece em `<id>/<versão>/` por um `rename`. Falha, cancelamento ou queda de rede apagam a pasta de trabalho. Uma instalação anterior só sai do lugar no último passo e **volta** se a publicação falhar; falhou = nada mudou.
5. **Reinstalação segura**: `force` baixa e confere tudo antes de tocar na instalação atual; versões antigas da mesma ferramenta são descartadas depois do sucesso.
6. **`resolveInstalled` não confia em memória**: lê o `manifest.json` e confere `id`, `versão`, SHA-256 do pacote e `exe` contra a entrada, e o tamanho gravado do executável. Manifesto ausente/corrompido/adulterado ou executável faltando = `null`.
7. **Remoção atômica**: `remove` move `<id>/` para `.tmp/trash-*` com um `rename` e apaga em seguida; se o sistema não deixar mover, falha com mensagem clara e nada muda.

### Programa em uso (Windows)

O Windows deixa renomear a pasta de um programa em execução, mas não apagar o `.exe` que está rodando. Então `force`/`remove` funcionam, e o que não puder ser apagado na hora fica em `.tmp/trash-*` até o programa fechar: é varrido na próxima instalação ou por `installer.cleanupStaging()` (chame ao iniciar o app). O processo que já estava rodando continua com os arquivos antigos; por isso o handler recusa reinstalar/atualizar/remover (`TOOL_IN_USE`) enquanto algum módulo declarar uso em `ctx.toolUsage`.

## Decisões e limites

- **Sem retomada de download parcial** (diferente do `FileDownloader` do BDS): falha apaga tudo e recomeça do zero, para não deixar `.part` esquecido. Os pacotes (whisper.cpp, yt-dlp, TwitchDownloaderCLI) são pequenos.
- **Extração só com o `tar` do sistema**: no Windows, o `tar.exe` do próprio Windows (10 versão 1803 ou mais nova; lê zip e tar.gz). Não há fallback com PowerShell `Expand-Archive`: sem `tar.exe` a instalação falha com `EXTRACT_UNAVAILABLE` e orientação. Em Linux, `.zip` usa `unzip`. Linux/macOS têm o código escrito (inclusive `chmod 755` no executável) mas **não foram executados** (desenvolvimento em Windows).
- Sem dependências npm novas; sem logger (quem chama registra o que quiser a partir do evento `progress` e dos erros).
- O pacote não pode trazer `manifest.json` na raiz (conflito com o manifesto; use `stripComponents`). Hardlinks de `tar.gz` não são inspecionados (o bsdtar já recusa `..` e caminhos absolutos).
- Um pacote que vira executável precisa ser um arquivo único (`yt-dlp.exe`) ou um zip/tar.gz; `.7z`, `.exe` instalador e `.msi` não são suportados.

## Testes

```bash
node --test tests/tools-registry.test.js tests/tools-extract.test.js tests/tools-installer.test.js tests/tools-https.test.js tests/tools-catalog.test.js tests/tools-ipc.test.js
node tests/e2e/tools.e2e.js        # abre o app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas da janela)
npx eslint src tests/tools-*.js tests/e2e/tools.e2e.js renderer/features/tools.js
```

- `tools-registry.test.js`: validação de entradas, carga de `entries/` (inclui as entradas reais, que precisam ser válidas), `resolveInstalled`/`status` com manifesto adulterado.
- `tools-installer.test.js` (servidor `node:http` real): sucesso (zip, tar.gz com pasta externa, arquivo único), SHA-256 errado, tamanho errado (menor/maior, com e sem `Content-Length`), cancelamento no meio (por sinal e por `cancel(id)`), redirecionamentos, laço de redirecionamento, 404/503, queda de rede no meio (com e sem nova tentativa), timeout, zip-slip (zip e tar.gz), reinstalação, atualização, falha de publicação com restauração (falha injetada em `fs.renameSync`), remoção, plataforma indisponível, programa em uso (Windows, com `PING.EXE`), limpeza de resíduos.
- `tools-extract.test.js`: nomes de entradas, links, extração real com o `tar` do sistema, cancelamento/timeout de processo (confere que o filho morreu), URLs e redirecionamentos.
- `tools-https.test.js`: servidor https local com certificado autoassinado (gerado com `openssl`; pulado se não houver): recusa de certificado desconhecido e instalação de ponta a ponta com redirecionamento https.
- `tools-catalog.test.js`: chaves do `ctx.tools` (`toolKeyFor`, inclusive nomes de protótipo), entradas de teste (matriz de ambientes bloqueados, substituição por id, URL não local, JSON inválido), varredura que garante que `BF_TEST_TOOL_ENTRIES` só aparece em `catalog.js`, e `resolveTools` (instalada > `CORTE_*` > PATH; instalação adulterada não vale; ffmpeg nunca vem da pasta do app).
- `tools-ipc.test.js` (`ctx` de verdade com Electron falso, servidor HTTP local, extração real): `tools:status` (versão do FFmpeg, programa que não executa, sem FFmpeg), instalar/reinstalar/remover com `tools:progress`/`tools:changed` e prioridade sobre a do sistema, erros (id inválido/desconhecido, SHA-256, plataforma sem pacote, nada sobra no disco), cancelar e `BUSY`, `before-quit`, `ctx.toolUsage` (`TOOL_IN_USE`), `refreshTools({ force })` e limpeza de resíduos ao iniciar.
- `subtitles-gpu.test.js` (parte de ferramentas): a entrada `whisper-cuda` (tamanho/SHA-256 oficiais, só `win32-x64`, não alimenta `ctx.tools`) e a instalação de um zip `Release/` com `ggml-cuda.dll` pelo `ToolInstaller` contra um servidor local; o pacote real de 675 MB nunca é baixado nos testes.
- `tests/e2e/tools.e2e.js` (app Electron real, perfil temporário): sem entradas de teste FFmpeg/FFprobe com versão e a entrada do FFmpeg como de terceiros; sem FFmpeg no PATH o botão Instalar o FFmpeg (na aba e no aviso do topo) e a instalação à mão recolhida; **o botão do aviso de ponta a ponta com um pacote de mentira em servidor local** (recusar não baixa, aceitar mostra o progresso, instala os dois programas, o aviso some, remover o traz de volta); com entradas de teste: cancelar, instalar com barra de progresso parcial e crescente, erro de SHA-256 explicado, persistência após reiniciar, remover com confirmação, `BF.state.tools`/`BF.bus` e `NODE_ENV=production` ignorando as entradas de teste.

Não há teste que baixe da internet: o caminho HTTPS é validado contra o servidor local, e a primeira instalação real (GitHub) deve ser conferida à mão por quem criar a primeira entrada.
