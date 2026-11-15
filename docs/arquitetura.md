# Arquitetura e contratos (Braga Frame)

Este documento é o contrato entre os módulos. Quem implementa um recurso **só edita os arquivos do próprio recurso** e fala com os outros pelos contratos abaixo. Se um contrato precisar mudar, registre o pedido na seção "Pedidos de contrato" de `docs/recursos/<recurso>.md`; a integração o consolida na seção 5 deste arquivo.

> **Como ler.** As seções 1 a 4 descrevem o contrato original, já corrigido onde o código real diferia (as correções estão marcadas com "(5.x)", apontando para a seção 5). A **seção 5 é a fonte de verdade dos contratos efetivos**, agrupada por tema: quando uma frase das seções 1 a 4 e a seção 5 divergirem, vale a 5. A seção 5.15 lista as contradições que já foram resolvidas e o que ainda está pendente.

## 0. Regras gerais (valem para todo o código)

- Idioma da interface e das mensagens: **português do Brasil**. Código e comentários seguem o estilo existente (comentários curtos, em português quando explicam regra de negócio).
- **Sem dependências npm novas** em runtime. Só `electron` (dev) e as ferramentas existentes. Binários externos (whisper.cpp, yt-dlp, TwitchDownloaderCLI) só de **releases oficiais** do próprio projeto, baixados pelo app com **tamanho + SHA-256 conferidos** (nunca compilar, nunca build de terceiros). FFmpeg/ffprobe: usa o do sistema (o projeto oficial não publica binários).
- **Nada fictício**: nenhum botão sem ação, nenhuma integração simulada apresentada como real. Se algo depende de ferramenta/permissão indisponível, a interface mostra o motivo e como resolver, e a ação fica desabilitada.
- **Telas limpas**: poucos botões visíveis, ajustes avançados recolhidos em `<details>`, textos curtos.
- **Nunca sobrescrever arquivo do usuário em silêncio**; nunca apagar arquivo do usuário. A única exclusão que existe é a de um **projeto** (lixeira da aba Projetos) e ela só apaga o que o app **prova** ser dele: os dados que guarda em pastas próprias, os cortes exportados que o projeto anotou (com a legenda gravada ao lado) e o vídeo e o chat que o próprio app baixou; o vídeo e a legenda do usuário nunca saem (veja `docs/recursos/base.md`, aba Projetos). Gravações de estado sempre atômicas (tmp + rename).
- Não fazer commit/push, não mexer em `package.json`, `eslint.config.js`, `.gitignore`, `main.js`, `preload.js`, `renderer/index.html`, `renderer/app.js`, `renderer/app.css` fora da etapa de base (veja propriedade de arquivos).
- Ao terminar, limpar todo temporário criado (pastas em `%TEMP%`, arquivos `.part`, processos filhos). Testes devem usar `fs.mkdtempSync(os.tmpdir()+'/bf-…')` e remover no `finally`.
- Testes: unitários em `tests/<recurso>*.test.js` (rodam com `node --test`), e2e opcionais em `tests/e2e/<recurso>.e2e.js` usando `tests/e2e/helpers.js` (porta de depuração dinâmica, perfil de usuário temporário). Durante o desenvolvimento de um recurso, rodar só os testes dele; **não** rodar o conjunto inteiro nem o e2e dos outros enquanto outros agentes editam. Na integração vale o conjunto todo: `npm test`, `npm run test:e2e` (um arquivo por vez, em sequência), `npm run lint` (veja 5.14).

## 1. Camadas

```
main.js ── src/ipc/index.js ── src/ipc/handlers/<recurso>.js ── src/core/<recurso>/…
preload.js  (window.bf: invoke / on / pathForFile)
renderer/index.html ── app.js (window.BF) ── features/<recurso>.js (+ .css)
```

### 1.1 Processo principal / IPC

- `src/ipc/index.js` carrega **todo arquivo** `src/ipc/handlers/*.js`. Cada um exporta `register(ctx)`.
- `ctx` (criado em `src/ipc/context.js`):
  - `ipcMain`, `app`, `dialog`, `shell`
  - `getWindow()`; `send(channel, payload)` envia evento ao renderer
  - `paths`: `{ userData, projects, tools, cache, downloads }` (pastas já criadas)
  - `tools`: objeto vivo `{ ffmpeg, ffprobe, ytdlp, whisper, twitchDownloader }` (caminhos ou `null`), atualizado por `ctx.refreshTools({ force? })`; mais `toolCatalog` e `toolUsage` (5.2)
  - `projectStore` (veja 2.3), `bus` (EventEmitter do processo principal), `log(level, msg)`; extras `channels` (canais registrados), `handlers` (`{ loaded, failed }`) e `preferences` (serviço de preferências, só depois de `handlers/prefs.js` carregar; opcional); `busyChecks` e `projectBusy(project)` (cada handler que roda trabalho sobre um projeto registra em `busyChecks` uma função `(project) => mensagem | null`; `projectBusy` devolve a primeira mensagem e a exclusão de projeto recusa com ela) e, publicados pelos handlers para quem precisa saber o que está rodando: `queue` (`activeForProject`, `forgetProject`), `sources` (`downloadRecord`, `forgetDownload`) e `analysis` (`{ manager, ai }`)
  - `handle(channel, fn)`: registra `ipcMain.handle` com tratamento de erro; `fn(payload, event)` retorna objeto; exceções viram `{ ok:false, code, message }`.
- Canais: `<recurso>:<acao>` em camelCase (`queue:enqueue`). Respostas: `{ ok:true, ... }` ou `{ ok:false, code, message, details? }`. Mensagens de erro em português, com causa e possível solução.
- Eventos do main → renderer: `ctx.send('<recurso>:<evento>', payload)` (ex.: `queue:progress`).

### 1.2 Preload

`window.bf = { invoke(channel, payload), on(channel, cb) -> off(), pathForFile(file) }`.
Canais válidos: `/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/`. Só existe handler no main para o que for registrado — essa é a lista permitida.

### 1.3 Renderer (`window.BF`, em `renderer/app.js`)

```js
BF.state      // { project, info, url, tools }  (project = projeto v2 em memória; única fonte de verdade no renderer)
BF.bus        // .on(evt, fn) -> off ; .emit(evt, data)
BF.api(channel, payload)           // invoke + trata { ok:false } (devolve o objeto; mostra toast só se { toast:true })
BF.on(channel, cb)                 // evento vindo do main
BF.project.update(mutatorFn, {reason}) // muta BF.state.project, emite 'project:changed', salva (debounce) via project:save
BF.project.cut(id)                 // cut por id
BF.ui.log(msg, kind)               // barra de status ('ok'|'error'|'')
BF.ui.toast(msg, kind)
BF.ui.confirm({title, message, okLabel, cancelLabel, danger}) -> Promise<boolean>   // modal próprio (não usar window.confirm)
BF.ui.prompt({title, label, value}) -> Promise<string|null>
BF.ui.registerTab({ id, title, order, render(container), onShow?(), badge?() })
BF.ui.selectTab(id)
BF.player     // { video, seek(sec), playRange(start,end), pause(), time(), duration(), onTime(cb) }
BF.hooks      // .add(name, async fn(ctx)) ; .run(name, ctx)  — hooks: 'beforeOpen' (ctx:{path,origin,info}), 'afterOpen'
BF.prefs      // { get(key, fallback), resolve(), explain(key), set(key, value, scope?), unset(key, scope?), scope(), reload(), ready } — implementado por features/prefs.js (5.11); antes dele a base devolve o fallback
BF.util       // { fmt(sec), parseTime(text), el(tag, attrs, ...children), debounce, dirOf, nameOf, baseOf, joinPath }
BF.openSource(path, origin?)       // abre/cria projeto (passa por hooks beforeOpen/afterOpen)
BF.ready      // Promise: app:info carregado
BF.model      // { newCut, normalizeCut, normalizeProject } (src/core/projects/model.js)
BF.review     // namespace da revisão (engine, adjust, select, history, timeline) — 5.8
BF.audioPreview  // { state(), level(), setMode(mode), nodes() } — prévia Web Audio do áudio; 5.6
BF.analysis   // funções puras da aba Análise (isCovered, pendingSuggestions, clock, addSuggestions, splitKeywords) — 5.9
```

As adições da base a este bloco (`BF.ready`, `BF.model`, `BF.project.flush/addCut`, `BF.ui.refreshTabs`, `BF.player.load`) estão em 5.1.

Eventos do `BF.bus` (nome → payload):

| Evento | Quando | Payload |
|---|---|---|
| `project:loaded` | projeto aberto | `{ project, restored }` |
| `project:changed` | qualquer mutação | `{ reason }` |
| `cuts:changed` | lista/dados de cortes mudaram | `{ ids?, from? }` — `from` identifica quem emitiu (`'review'`, `'review:inline'`, `'cuts:retitle'`, `'audio:adjust'`, `'queue:done'`, `'analysis'`…) para ele não se redesenhar à toa |
| `cut:selected` | usuário selecionou corte | `{ id }` |
| `decision` | decisão do usuário sobre um corte | `{ cutId, type, before, after }` com `type` em `approve`, `reject`, `reset`, `adjust`, `recategorize`, `retitle`, `remove`, `create`; campos opcionais `scope`, `source`, `label`, `reviewGroup` e `what` (veja 5.12: **`adjust` tem três formas**) |
| `player:time` | tempo do player mudou | `{ time }` |
| `tools:changed` | ferramentas instaladas/removidas | `{ tools }` |
| `prefs:changed` | algum valor de preferência em vigor mudou | `{ reason, keys }` (renderer; o processo principal tem um `prefs:changed { what }` próprio no `ctx.bus`) |
| `review:timeline` | interno: liga/desliga o botão Timeline | `{ open }` |

Eventos que **vêm do processo principal** chegam por `BF.on(canal, cb)` (e não pelo `BF.bus`): `queue:*`, `sources:progress`, `subtitles:progress`, `subtitles:modelProgress`, `analysis:*`, `tools:progress`, `review:waveformProgress`, `export:progress` (legado). A tabela completa está em 5.12.

### 1.4 Menu, abas e telas

O menu lateral tem **5 itens**: **Início · Projetos · Cortes · Exportações · Configurações** (`src/core/ui/menuLayout.js`, `window.BFMenu`; também módulo CommonJS, testado em `tests/menu-layout.test.js`: o `LAYOUT` diz que telas cada item abriga). As telas continuam sendo as **abas** que cada feature registra com `BF.ui.registerTab` (mesmo contrato de antes, com os mesmos `id`, `order`, `title` e `view`): **Cortes** abriga as abas internas Cortes · Análise · Legendas · Áudio · Exportar e **Configurações** abriga Geral · Preferências · Ferramentas (as abas internas ficam em cima do painel, em `#subTabs`). **Novo projeto** (`sources`) não tem item nem aba: abre pelos botões "Novo projeto" da Início e de Projetos e acende o item Projetos. Os ids das telas **não mudam** (`#tabpanel-<id>`, `BF.ui.selectTab(id)` abre qualquer uma); uma tela que o layout não conhece (recurso novo) ganha um item próprio, na posição do `order`. O desenho tem ainda um item "Biblioteca" que o app não tem (não existe biblioteca para mostrar): ele não foi criado. DOM, teclado e selos: `docs/recursos/interface.md`.

Ordem e responsável (arquivo `renderer/features/<id>.js`, estilo `renderer/features/<id>.css`):

| order | id | título | onde fica no menu | dono |
|---|---|---|---|---|
| 1 | `home` | Início (boas-vindas, busca, "Novo projeto", "Continuar de onde parou" e os projetos recentes; é a tela inicial sem projeto aberto) | item Início | base |
| 5 | `projects` | Projetos (com o botão "Novo projeto" no cabeçalho) | item Projetos | base (tela larga, usa `project:list`) |
| 6 | `sources` | Novo projeto (a antiga Fontes; ícone `add_circle`: cartões Arquivos locais, YouTube, Twitch e Gravações do OBS e a área de soltar) | sem item: abre pelos botões e acende Projetos | sources |
| 10 | `cuts` | Cortes | item Cortes › aba Cortes | review |
| 20 | `export` | Exportar | item Cortes › aba Exportar | exportEngine |
| 30 | `queue` | Exportações (antes "Fila"; pílulas Fila, Concluídos e Falhas e a barra de saída) | item Exportações | queue |
| 40 | `subtitles` | Legendas | item Cortes › aba Legendas | subtitles |
| 50 | `audio` | Áudio | item Cortes › aba Áudio | audio |
| 60 | `analysis` | Análise | item Cortes › aba Análise | analysis |
| 75 | `general` | Geral (Aparência, Pasta de projetos e Sobre; a primeira aba de Configurações) | item Configurações › aba Geral | base |
| 80 | `prefs` | Preferências | item Configurações › aba Preferências | prefs |
| 90 | `tools` | Ferramentas | item Configurações › aba Ferramentas | base |

Além disso: `renderer/features/timeline.js` (dono: review) desenha a timeline detalhada opcional no elemento `#timelineSlot` (abaixo do player); `renderer/features/shell.js` (dono: base) cuida da barra superior e do atalho de abrir/arrastar vídeo.
`renderer/index.html` referencia todos esses arquivos; todas as abas estão implementadas (nenhum stub). Os módulos "universais" (CommonJS no processo principal, `window.BF*` no renderer) `projects/model.js`, `ui/menuLayout.js` (`window.BFMenu`, o layout do menu, carregado antes do `app.js`), `subtitles/shared.js`, `audio/audioFilter.js`, `audio/audioHistory.js`, `export/framing.js` (`window.BFFraming`), `export/layouts.js` (`window.BFLayouts`, depende de `BFFraming`) e `analysis/humor.js` (`window.BFHumor`, o perfil de humor do canal) entram por `<script>` estático **antes** da aba que os usa (`framing.js` e `layouts.js` antes de `features/export.js`; `humor.js` antes de `features/analysis.js`); os de revisão (`src/core/review/*.js`, `src/core/history/log.js`) são carregados pelo `features/cuts.js` por `<script>` dinâmico (cada carregador pula o que já existir). Regra para qualquer arquivo universal: sem `require`/`module` fora do bloco condicional, e só `<script src>` do próprio app (CSP `script-src 'self'`, sem scripts inline).

## 2. Modelo de dados

### 2.1 Projeto v2 (`src/core/projects/model.js`)

```js
{
  version: 2, id, updatedAt,
  source: { path, size, duration, width, height, origin: null | {
      type: 'file'|'obs'|'vod', platform?: 'youtube'|'twitch', url?, videoId?, channel?, title?, game?, uploadDate?, fetchedAt?,
      duration? /* extra (5.10): segundos no momento da consulta, só em 'vod' */ } },
  meta: { game: '', channel: '' },          // editáveis; usados pelas preferências por jogo/canal
  cuts: [Cut],
  exportDir: null, profileId: 'vertical-1080-h264',  // perfil escolhido
  profile: null,                            // legado v1 (mantido na migração)
  customProfiles: [],                       // perfis do usuário (veja 3.1)
  chat: null | { path, format: 'bf-chat-1', count, fetchedAt, platform },
  analysis: { lastRun: null | { at, signals: [...], params: {}, count } },
  history: [],                              // reservado; NÃO usado: o histórico da revisão vive em userData/history/<projectId>.json (5.8)
  ext: {}                                   // namespace livre por recurso: ext.<recurso> (veja a lista em 5.3)
}
```

### 2.2 Corte (`normalizeCut`)

```js
{
  id, title, titleSuggestions: [], start, end,
  status: 'pending'|'approved'|'rejected',
  category: '',                // livre; lista de sugestões vem das preferências
  relevance: null | 0..1,      // só para cortes sugeridos
  origin: 'manual'|'auto', reasons: [],      // motivos da sugestão automática (texto curto)
  revision: 1,                 // incrementa quando start/end mudam
  framing: null | Framing,     // veja 3.2 (null = herda do perfil/padrão); parcial: só os campos ajustados
  layout?: 'conversa'|'jogo',  // só da análise (palpite da IA, que lê só o texto); o exportador nunca o altera (5.4)
  theme?: string, keywords?: string[],  // só da análise por IA: o tema do perfil do canal (um dos que o dono escreveu) e até 5 palavras-chave; só indicadores, nada os usa
  layoutChoice?: 'conversa'|'jogo'|'padrao',   // escolha do usuário na aba Exportar (ausente = segue a sugestão; 5.4)
  layoutLocal?: { layout, confidence, reason, key, at, samples },   // resultado do detector local de layout (layout pode ser null; 5.4)
  audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [], redo?: [] },   // redo: pilha de refazer (5.6)
  subtitles: null | { enabled, basedOn:{start,end,revision}, cues:[{start,end,text,needsReview?}],
                      style, mode: 'burn'|'sidecar'|'both', sidecarFormat?: 'srt'|'ass', generated?: {…} },  // tempos RELATIVOS ao início do corte (5.7)
  exports: [{ path, at, start, end, profile, jobId?, key?, revision? }],     // jobId/key/revision: acrescentados pela fila (5.5)
  titleCustom?: boolean, reviewedRange?: [start, end],                         // campos da revisão (5.8)
  notes: '', createdAt, updatedAt, reviewedAt
}
```

Campos extras de um corte (`titleCustom`, `reviewedRange`, `audio.redo`, qualquer outro) são **preservados** por `normalizeCut`/`normalizeProject` (`withExtras`).

`normalizeProject(raw)` migra v1→v2 sem perder campos desconhecidos (qualquer campo extra é preservado). `normalizeCut` preenche padrões. **Sempre** usar essas funções ao ler/escrever.

### 2.3 Armazenamento

- `projectStore` (já existe, ampliado): `load(sourcePath)`, `save(project)`, `list()` (resumo de todos os projetos: `id`, `source`, `meta`, `cutCount`, `counts { pending, approved, rejected }`, `exportedCount` (cortes com ao menos uma exportação concluída) e `updatedAt`; o canal `project:list` acrescenta `fileMissing` quando o arquivo do vídeo já não existe), `adopt(existingProject, newSourcePath)` (copia cortes/decisões para uma nova fonte, sem alterar o original), `peekById(id)` (lê sem nenhum efeito colateral: não separa arquivo corrompido nem restaura `.bak`; devolve `{ project }` ou `{ error }`) e `remove(id)` (apaga `<id>.json` e suas cópias `.bak`/`.corrupt`/`.tmp`, o principal por último; devolve `{ files, bytes, failed }`; só a exclusão de projeto o usa).
- O **renderer é o único que grava o projeto** (`BF.project.update` → `project:save`). Módulos do main devolvem resultados/emitem eventos; o renderer aplica ao projeto.
- Estado de recursos que precisa sobreviver sem projeto aberto fica em arquivos próprios em `paths.userData` (`queue.json`, `preferences.json`, `learned.json`, `history/<projectId>.json`), com gravação atômica.

## 3. Contratos entre recursos

### 3.1 Perfis de exportação (`src/core/export/profiles.js`, dono: exportEngine)

```js
Profile = { id, name, kind: 'vertical'|'horizontal'|'custom', width, height, resolutionLabel, codec: 'h264'|'h265',
            bitrateKbps, encoder?: 'auto'|'software'|'nvenc', fps?: 'source'|number, container: 'mp4',
            framing?: Framing /* enquadramento inicial do perfil, parcial */, builtin?: true /* só leitura: devolvido por export:listProfiles */ }
```
Perfis embutidos: `vertical-1080-h264` (padrão, 9:16, 10 Mbps), `vertical-1440-h264`, `vertical-2160-h264` e variantes `-h265`; `horizontal-*` 16:9; o usuário cria `custom`. **9:16 é o padrão obrigatório** do produto; horizontais/personalizados são extras.

### 3.2 Enquadramento (`Framing`, dono: exportEngine)

```js
{ mode: 'center'|'blur'|'stack'|'custom',
  focusX: 0..1,            // posição horizontal do recorte no modo center/blur
  focusY: 0..1,            // posição vertical (padrão 0,5); vale com zoom ou quando a fonte é mais estreita que o quadro
  zoom: 1..3,
  blur: { strength },      // modo blur: gameplay inteira sobre fundo desfocado
  stack: { webcamRect:{x,y,w,h}, gameRect:{x,y,w,h}, webcamHeightPct, webcamPosition:'top'|'bottom' }, // fração 0..1 da fonte
  custom: { x,y,w,h } }    // retângulo livre da fonte (0..1) a ser escalado
```
`resolveFraming(cut, profile, projectDefaults)` → enquadramento efetivo; camadas: padrão do app < `profile.framing` < padrão do projeto (`project.ext.export.framing`) < `cut.framing`. O perfil/padrão nunca é modificado por ajuste de um corte. **Com layouts** (Conversa | Jogo) o preset do layout do corte entra entre o padrão do projeto e `cut.framing` (`src/core/export/layouts.js`). `framing.js` é universal (`window.BFFraming`) e ganhou `mergeLayers(...camadas)`. Detalhes em 5.4.

### 3.3 Job de exportação (consumido por queue, produzido por export)

```js
Job = { id, projectId, projectTitle, sourcePath, sourceInfo:{width,height,fps,duration,hasAudio, audioTracks?, hdr?} /* os dois últimos só quando valem um aviso (5.4) */, framingSource? /* origem do enquadramento, só auditoria (5.4) */,
        cut: <Cut normalizado (snapshot)>, profile: Profile, framing: Framing|null,
        outputDir, baseName, onConflict: 'ask'|'rename'|'replace'|'skip'|'fail', createdAt }
```
- `onConflict` (nome já existe): `ask` = a fila pergunta ao usuário (estado `needsAction`); `rename` = "nome (2).mp4"; `replace` = substituir **somente por escolha explícita do usuário** (grava em `.part` e troca de forma atômica ao concluir); `skip` = pular; `fail` = erro `OUTPUT_EXISTS`. O `jobRunner` recebe sempre um valor resolvido (`rename`, `replace`, `skip` ou `fail`), nunca `ask`.
- `src/core/export/jobRunner.js`: `runExportJob(job, { tools, onProgress(0..1), signal, tmpDir, onStart? })` → `{ output, warnings:[{code,message}], skipped, encoder:{kind,name}|null, sizeBytes }` ou lança `ExportError(code, message, details)` (assinatura efetiva em 5.4; o retorno original `{ output, warnings }` ganhou campos).
- `src/core/export/qc.js`: `preflight(job, { tools })` → `{ errors:[{code,message,solution}], warnings:[{code,message}] }` (erros bloqueiam só aquele job). Síncrono.
- Códigos de erro **recuperáveis** (a fila pode tentar de novo): `FFMPEG_START_FAILED`, `IO_BUSY`, `FFMPEG_CRASH`, `DISK_TRANSIENT`. **Não recuperáveis**: `INPUT_MISSING`, `INVALID_PROFILE`, `INVALID_RANGE`, `NO_DISK_SPACE`, `OUTPUT_EXISTS` (quando `onConflict:'fail'`), `CANCELLED`, `CODEC_UNSUPPORTED` e, acrescentados (5.4), `NO_FFMPEG`, `FFMPEG_FAILED`, `OUTPUT_NOT_WRITABLE`, `SUBTITLES_FAILED`, `AUDIO_FAILED`, `OUTPUT_INVALID`.
- A fila **não conhece** enquadramento/áudio/legendas: só chama `runExportJob`.
- O `runExportJob` monta o filtro de vídeo (enquadramento), o filtro de áudio (`src/core/audio/audioFilter.js`: **`buildAudioFilter(audio, { duration, offset? }) -> string|null`**, mais **`resolveAudio(audio, { duration })`** para os avisos de limite) e legendas (`src/core/subtitles/burnIn.js`: **`prepareBurnIn(cut, { tmpDir, width, height, ffmpegPath? }) -> null | { vfFilter: string|null, sidecars:[{path, ext}], warnings:[string] }`**, **síncrono**, pode lançar `SubtitlesError`); se o recurso/módulo não existir, avisa e segue (módulo que falha vira erro do job).
- Resultado concluído é gravado pela fila em `queue.json` e anunciado por `queue:jobDone`; o renderer (aba `queue`) aplica em `cut.exports`.

### 3.4 Fila (`src/core/queue/`, dono: queue)

IPC: `queue:enqueue {jobs, force?}`, `queue:list`, `queue:pause {interrupt?}`, `queue:resume`, `queue:recover {action:'resume'|'discard'}`, `queue:cancel {id|all}`, `queue:reorder {ids}`, `queue:remove {id}`, `queue:retry {id}`, `queue:clearFinished {includeFailed?}`, `queue:getSettings`, `queue:setSettings {parallel, retries, recovery:'ask'|'resume'|'discard', onConflict, defaultParallel?}`, `queue:resolveConflict {id, action}`; eventos `queue:update {jobs, running, paused, parallel, active, blocked, recovery, loadWarning, saveError, settings}`, `queue:progress {id, p, etaSec}`, `queue:jobDone {job, output}`, `queue:conflict {job, path}`, `queue:recovery {jobs}` (detalhes em 5.5).
Estados: `queued`, `running`, `done`, `failed`, `interrupted`, `cancelled`, `skipped`, `needsAction`. (O contrato original listava também `paused`; **o job nunca fica em `paused`**: a pausa é da fila inteira, `paused` em `queue:update`/`queue:list`.)

### 3.5 Preferências (dono: prefs)

Chaves reconhecidas (valor padrão entre parênteses): `export.profileId` (`vertical-1080-h264`), `export.framing.mode` (`center`), `export.layout.conversa` e `export.layout.jogo` (um preset de enquadramento cada, tipo `object`) e `export.layout.refs` (quadros de referência do detector, `object` de até 32 KB; as outras chaves de objeto seguem em 4 KB), `analysis.minRelevance` (0.5), `analysis.minDurationSec` (15), `analysis.maxDurationSec` (60), `analysis.padBeforeSec` (3), `analysis.padAfterSec` (2), `analysis.keywords` (lista; sem valor = as do app), `analysis.humor` (perfil de humor do canal: `object` `{ criteria, catchphrases, reactions, examples }` de até 16 KB, **normalizado ao gravar** por `analysis/humor.js` e recusado se vazio; sem valor = nenhum perfil), `review.defaultSort` (`chrono`), `review.categories` (lista), `queue.parallel` (1), `subtitles.enabled` (false), `subtitles.mode` (`burn`; aceita `burn`, `sidecar`, `both`), `subtitles.style` (objeto). **`analysis.sensitivity` ainda não existe** no catálogo de chaves (pendente, 5.15).
Prioridade (provisória, a confirmar com a Liz): **canal/criador > jogo > geral** (o mais específico vence). `BF.prefs.get(key, fallback)` já aplica a prioridade; `BF.prefs.explain(key)` diz de onde veio o valor. Detalhes em 5.11.
Aprendizado: o módulo escuta o evento `decision` e propõe preferências aprendidas (nunca aplica sem poder ser visto, editado, desativado e desfeito).

### 3.6 Chat (dono: sources)

Formato unificado `bf-chat-1` (JSON): `{ format:'bf-chat-1', platform, videoId, messages:[{ t:<seg desde o início do vídeo>, user, text }] }`. A análise lê só esse formato (`src/core/sources/chatFormat.js`: `readChat(path)` e `writeChat(path, data)` **assíncronos** (existem `readChatSync`/`writeChatSync`), `messagesPerWindow(chat, windowSec, durationSec?)` → `number[]`; erros `ChatFormatError` com `code`; detalhes em 5.10).

### 3.7 Ferramentas (dono: base; entradas por recurso)

`src/core/tools/ToolInstaller.js`: baixa um pacote oficial com **URL fixa, tamanho e SHA-256**, valida, extrai para `paths.tools/<id>/<versão>/`, grava manifesto, nunca deixa instalação pela metade; progresso e cancelamento. Cada ferramenta tem uma entrada em `src/core/tools/entries/<id>.js` (`{ id, label, version, assets:{'win32-x64':{url,name,size,sha256,exe}}, source:'oficial: <url do projeto>' }`). IPC: `tools:status`, `tools:install {id, force?}`, `tools:cancel {id}`, `tools:remove {id}`; eventos `tools:progress` e `tools:changed`. `ctx.tools` reflete o resultado. Entradas oficiais hoje: `ytdlp`, `whisper`, `twitchdownloader` e `deno` (esta última **não** alimenta o `ctx.tools`; é do `sources`). Detalhes em 5.2.

## 4. Propriedade de arquivos

| Dono | Pode editar |
|---|---|
| base | `main.js`, `preload.js`, `src/appInfo.js`, `renderer/index.html`, `renderer/app.js`, `renderer/app.css`, `renderer/features/shell.js`, `renderer/features/tools.js` (+ `.css`), `src/ipc/index.js`, `src/ipc/context.js`, `src/ipc/handlers/app.js`, `handlers/project.js`, `handlers/tools.js`, `src/core/projects/*` (exceto `matcher.js` e `compare.js`, que são do prefs), `src/core/ffmpeg/**`, `src/core/tools/{ToolInstaller,registry,catalog}.js` e `src/core/tools/entries/README.md`, `tests/e2e/helpers.js`, `tests/e2e/app.e2e.js`, `tests/e2e/tools.e2e.js`, `tests/ipc-base.test.js`, `tests/projectModel.test.js`, `tests/projectStore.test.js`, `tests/renderer-base.test.js`, `tests/preload.test.js`, `tests/tools-*` |
| exportEngine | `src/core/export/**`, `src/ipc/handlers/export.js`, `renderer/features/export.*`, testes `tests/export*` |
| queue | `src/core/queue/**`, `src/ipc/handlers/queue.js`, `renderer/features/queue.*`, `tests/queue*` |
| audio | `src/core/audio/**`, `src/ipc/handlers/audio.js`, `renderer/features/audio.*`, `tests/audio*` |
| subtitles | `src/core/subtitles/**`, `src/core/tools/entries/whisper.js`, `src/ipc/handlers/subtitles.js`, `renderer/features/subtitles.*`, `tests/subtitles*` |
| review | `src/core/review/**`, `src/core/history/**`, `src/ipc/handlers/review.js`, `renderer/features/cuts.*`, `renderer/features/timeline.*`, `tests/review*`, `tests/history*` |
| analysis | `src/core/analysis/**`, `src/core/ai/**` (exceto `openrouter/`), `src/ipc/handlers/analysis.js`, `renderer/features/analysis.*`, `tests/analysis*`, `tests/ai-*` (exceto `ai-openrouter*`) |
| aiOpenrouter (da análise) | `src/core/ai/openrouter/**`, `src/ipc/handlers/aiOpenrouter.js`, `renderer/features/aiOpenrouter.*`, `tests/ai-openrouter*`, `tests/e2e/ai-openrouter.e2e.js`, `tests/e2e/analysis-openrouter.e2e.js`, `docs/recursos/openrouter-gratuito.md` (o cartão do provedor em `renderer/features/analysis.*` e o chat em `src/core/ai/{client,runtime,errors,providers}.js` seguem sendo da análise) |
| sources | `src/core/sources/**`, `src/core/tools/entries/ytdlp.js`, `src/core/tools/entries/twitchdownloader.js`, `src/core/tools/entries/deno.js`, `src/ipc/handlers/sources.js`, `renderer/features/sources.*`, `tests/sources*` |
| prefs | `src/core/preferences/**`, `src/core/projects/matcher.js`, `src/core/projects/compare.js`, `src/ipc/handlers/prefs.js`, `renderer/features/prefs.*`, `tests/prefs*` |

| integração | `docs/arquitetura.md` (seção 5), `docs/requisitos-e-etapas.md`, `README.md`, `scripts/**` (`run-e2e.js`, `run-network-tests.js`, `run-perf-tests.js`), `package.json` (só `scripts`), `tests/e2e/helpers.js` e `tests/e2e/{app,tools}.e2e.js` (em conjunto com a base) |

Documentação de cada recurso: `docs/recursos/<recurso>.md` (dono do recurso): `exportEngine`, `queue`, `audio`, `subtitles`, `review`, `analysis`, `sources`, `prefs` e, da base, `base.md` e `tools.md`. Arquivos de teste e de fixtures que começam com o nome do recurso (`tests/<recurso>-*.js`) pertencem ao dono.

## 5. Alterações de contrato (consolidadas)

Quem precisar de uma mudança de contrato **não edita este arquivo** (vários agentes trabalham ao mesmo tempo): descreve o pedido na seção "Pedidos de contrato" do próprio `docs/recursos/<recurso>.md` e informa em `openIssues`. O responsável pela integração consolida aqui, **agrupado por tema** (5.1 a 5.14) e sem apagar o que já estava; o que foi corrigido por contradição fica em 5.15. Cada recurso tem o detalhe completo no seu `docs/recursos/<recurso>.md`; aqui ficam só os contratos que **outro módulo** precisa conhecer.

Sumário: 5.1 Base · 5.2 Ferramentas · 5.3 Modelo de dados e namespaces · 5.4 Exportação · 5.5 Fila · 5.6 Áudio · 5.7 Legendas · 5.8 Revisão e histórico · 5.9 Análise · 5.10 Fontes e chat · 5.11 Preferências · 5.12 Eventos · 5.13 Canais IPC · 5.14 Ambiente, scripts e testes · 5.15 Contradições resolvidas e pendências.

### 5.1 Base (IPC, modelo, renderer, ganchos, preload, testes)

- (base) `onConflict` ganhou o valor `replace` (veja 3.3).
- (base) **IPC da base** (`src/ipc/handlers/app.js` e `project.js`): `app:info` → `{ name, tagline, version, projectsDir, tools, loadErrors:[{file,message}] }` (`projectsDir`: a pasta onde ficam os projetos, que a tela Geral mostra); `app:refreshTools` (procura as ferramentas de novo; o `tools:changed` só sai se algo mudou); `shell:reveal { path }`; `source:pick`; `source:open { path, origin? }` → `{ info, project, restored, url }`; `project:save { project }` → `{ project }`; `project:list` → `{ projects:[{ id, source, meta, cutCount, counts:{pending,approved,rejected}, updatedAt }] }`; `project:adopt { fromId | fromPath, path, origin? }` → `{ project, info, url }`. Códigos de erro: `NO_FFPROBE`, `INPUT_MISSING`, `INVALID_PATH`, `INVALID_PROJECT`, `PROJECT_NOT_FOUND`, `PROJECT_EXISTS`, `ADOPT_SAME_SOURCE`, `PROJECT_VERSION_UNSUPPORTED`. `export:*` (pickDir, warnings, run, cancel) era a versão mínima da base; **o exportEngine já substituiu `handlers/export.js`** (5.4): `export:warnings`, `export:run` e `export:cancel` ficam como canais **legados** só porque `tests/ipc-base.test.js` os cobre; a interface não os usa.
- (base) **`ctx.handle`**: resposta sem `ok` ganha `ok:true`; canal inválido ou repetido lança erro no registro; `details` precisa ser JSON. `ctx.channels` (canais registrados) e `ctx.handlers` (`{ loaded, failed }`) são extras do `ctx`. Um handler que falha ao carregar não derruba os outros; o app avisa pelo `loadErrors` de `app:info`.
- (base) **Resolução de ferramentas** fica em `resolveTools({ paths, env })` (`src/ipc/context.js`): ffmpeg/ffprobe por `locate.js`, yt-dlp por PATH/`CORTE_YTDLP`, whisper e twitchDownloader `null`. Quando o ToolInstaller existir, é nesse ponto que se consulta `paths.tools`. As variáveis de ambiente `CORTE_FFMPEG`, `CORTE_FFPROBE` e `CORTE_YTDLP` continuam com esses nomes. **(Superado por 5.2: whisper e twitchDownloader já são resolvidos — instalada pelo app > `CORTE_*` > PATH.)**
- (base) **Modelo** (`src/core/projects/model.js`): arquivo "universal" (CommonJS no main e `window.BFModel` no renderer, carregado por `index.html`), exposto como `BF.model` (`newCut`, `normalizeCut`, `normalizeProject`). `projectIdFor` e `newProject(sourcePath, info, origin)` ficam em `projectStore.js`. Migração v1→v2: `profile` legado mantido e `profileId` derivado dele (`vertical-<res>-<codec>`; o bitrate fica só em `profile`); cortes v1 herdam a data do projeto; antes de regravar um v1 o store guarda a cópia `<id>.json.v1.bak` (uma vez); versão maior que 2 não é tocada (`PROJECT_VERSION_UNSUPPORTED`); arquivo ilegível vira `.corrupt`. `store.save` força `id` = hash do caminho. `adopt` copia cortes (sem `exports`), `meta`, `exportDir`, perfis, `ext` e campos desconhecidos; **não** copia `id`, `source`, `analysis`, `chat` nem `history`; recusa se o vídeo novo já tem projeto com cortes (um projeto vazio é substituído).
- (base) **Renderer, adições a 1.3**: `BF.api(channel, payload, { toast:true })` (o terceiro argumento é que liga o toast); `BF.ready` (Promise: `app:info` carregado); `BF.state.app` (`name, tagline, version`) e `BF.state.loadErrors`; `BF.model`; `BF.project.flush()` (grava já o que estiver pendente) e `BF.project.addCut(fields)` (corte manual completo, ordem cronológica; emite `cuts:changed`, `decision` `create` e `cut:selected`); `BF.ui.refreshTabs()` (reavalia os `badge()`); `BF.player.load(url)`; `BF.util` também tem `dirOf, nameOf, baseOf, joinPath`; `BF.prefs` (stub da base) tem `get`, `resolve` e `explain`, e o arquivo é `features/prefs.js` (não `preferences.js`) — o `BF.prefs` completo está em 5.11. O painel de abas aparece sempre; sem projeto aberto (`BF.state.project === null`, `#app.no-project`) só as abas `home` (Início), `projects`, `sources` (Novo projeto), `queue`, `prefs` e `tools` ficam utilizáveis (as demais ficam desabilitadas com dica) — **essas seis abas precisam funcionar sem projeto** (tratar `BF.state.project` nulo). `BF.ui.droppedMany(count)` (toast quando soltam mais de um arquivo: só o primeiro abre) é novo.
- (base) **Ganchos**: `BF.hooks.run` executa em sequência e, se algum gancho devolver `false`, para e devolve `false` (`BF.openSource` cancela a abertura). Em `beforeOpen` o `ctx.info` é `null` (o ffprobe só roda em `source:open`); `afterOpen` recebe `{ path, origin, info, project, restored }`. Erros lançados por um gancho são registrados no console e ignorados.
- (base) **Eventos**: `decision` — `before`/`after` são o status (`approve`, `reject`, `reset`), o título (`retitle`), `null`→cópia do corte (`create`) e cópia do corte→`null` (`remove`). `cuts:changed` pode trazer `from` (ex.: `'cuts:retitle'`) para quem o emitiu dispensar a si mesmo de redesenhar. `tools:changed` do main chega ao renderer como evento do `BF.bus` e atualiza `BF.state.tools`.
- (base) **Preload/CSP**: `window.bf` não tem mais `window.corte`. A CSP de `index.html` passou a aceitar `img-src 'self' data: blob: file:` e `media-src file: blob:` (miniaturas e legendas futuras); continua sem scripts ou estilos inline.
- (base) **Testes**: `tests/e2e/helpers.js` exporta `ROOT, sleep, mkTemp, removeDir, makeSampleVideo, connect, waitFor, launchApp, cleanupAll, answerModal, modalOpen, assertNoConsoleErrors, screenshot`; `launchApp(userDataDir, { env, args, timeout })` devolve `{ page, errors, stop }` (`page.eval`, `page.press`, `page.send`, `page.errors`). A integração acrescentou a `launchApp` uma nova leitura do `DevToolsActivePort` quando o arquivo está transitoriamente ocupado/incompleto (EBUSY/EPERM/parcial). Os scripts de execução estão em 5.14.
- (consolidação) **Contexto do OpenRouter e do módulo embutido**: `ctx.aiOpenrouter` é o serviço do OpenRouter (`createOpenRouterService`: catálogo público, guard "só gratuitos", limites, erros explicados e fallback; criado por `handlers/aiOpenrouter.js`, que carrega **antes** de `analysis.js`, e usado pela análise); sem ele o OpenRouter **não fica pronto** (falha fechada, `NOT_CONFIGURED`). `ctx.aiOpenrouterOptions` (`{ baseUrl?, fetchImpl?, safeStorage?, … }`) é **só para testes**. `BF_OPENROUTER_BASE_URL` aponta o serviço para um servidor local que imita o OpenRouter e é **ignorada no app empacotado** (só testes).
- (consolidação) **Renderer, adições a 1.3**: `BF.aiOpenRouter` = `{ createModelPicker, createLimitsChip, format, ROUTER_ID }` (`renderer/features/aiOpenrouter.js/.css`, sem aba): o seletor de modelos do OpenRouter (o roteador gratuito "Automático" em **primeiro**, os gratuitos logo abaixo; o cartão da Análise o marca como selecionado enquanto o usuário não escolhe outro) e o selo "Restam N de L pedidos gratuitos hoje". `renderer/index.html` carrega os dois arquivos **antes** de `features/analysis.js`, que monta o cartão do provedor com eles. No módulo embutido do BDS o seletor e o selo **não aparecem** (o provedor é o do hospedeiro e a tela não chama `aiOpenrouter:*`).

### 5.2 Ferramentas (instalador, resolução, uso)

- (consolidação) **Ferramentas (tools)**: IPC `tools:status`, `tools:install {id, force?}`, `tools:cancel {id}`, `tools:remove {id}`, eventos `tools:progress` e `tools:changed`. `ctx.refreshTools({force})`, `ctx.toolCatalog` e `ctx.toolUsage.register(...)`: todo recurso que **usa** uma ferramenta instalada pelo app (whisper, yt-dlp, TwitchDownloaderCLI e Deno) deve registrar o uso enquanto o processo roda, para a Ferramentas não remover/atualizar durante o uso. Ordem de resolução: instalada pelo app > variável de ambiente (`CORTE_FFMPEG`, `CORTE_FFPROBE`, `CORTE_YTDLP`, `CORTE_WHISPER`, `CORTE_TWITCHDOWNLOADER`) > PATH (`whisper-cli`, `TwitchDownloaderCLI`). Ids do registro: `ytdlp`, `whisper`, `twitchdownloader` (nome do arquivo da entrada = id) e `deno`. Detalhes em docs/recursos/tools.md.
- (consolidação) **Entradas do registro**: campos opcionais `kind` ('zip'|'tar.gz'|'file') e `stripComponents` (0..5); arquivo único (ex.: yt-dlp.exe) usa `exe` só com o nome. Não há retomada de download parcial.
- **Entradas oficiais hoje** (todas de releases oficiais, URL fixa, tamanho e SHA-256 conferidos): `ytdlp` 2026.08.19, `twitchdownloader` 1.56.5, `deno` 2.9.7 (do `sources`; `entries/deno.js`) e `whisper` b5130 (do `subtitles`; `entries/whisper.js`, `stripComponents: 1`). Só o pacote Windows x64 foi baixado, instalado e executado; os demais têm hash (e, nos zips, conteúdo) conferidos, mas **não foram executados**. FFmpeg/FFprobe **nunca** são baixados (o projeto não publica binários): só do sistema.
- **`ctx.toolUsage`**: `register(fn) -> off` e `inUse(chave, id) -> motivo|null`; `fn(chave, id)` devolve o motivo (texto curto) ou `null`. Com motivo, `tools:remove`, `tools:install {force:true}` e a atualização de versão antiga respondem `TOOL_IN_USE`. Usam-no: `subtitles` (whisper), `sources` (yt-dlp, TwitchDownloaderCLI e o Deno do app). `exportEngine`, `queue`, `audio`, `analysis` e `review` só usam FFmpeg/ffprobe do sistema e **não** registram.
- **`tools:status`** devolve `{ system:[{id,label,found,path,version}], tools:[{id,label,version,source,sizeBytes,available,unavailableReason,installed,installedVersion,outdated,installedAt,busy,active:{origin,path},test}] }`; `tools:progress` usa `received`/`total`; códigos de erro novos: `INVALID_ARGS`, `UNKNOWN_TOOL`, `TOOL_IN_USE`, além dos do instalador (`CHECKSUM_MISMATCH`, `SIZE_MISMATCH`, `CANCELLED`, `BUSY`, `DISK_SPACE`, `TLS`…).
- **Pendente (base)**: `deno` ainda **não** está em `TOOL_KEY_BY_ID`/`ctx.tools` nem tem variável própria resolvida pelo `resolveTools`; o `sources` resolve o Deno sozinho (`registry.resolveInstalled(paths.tools,'deno')` e `findTool('deno','CORTE_DENO')`). Por isso a aba Ferramentas não mostra "em uso pelo sistema" para o Deno. Os **modelos do Whisper não entram no registro** (o hash é lido da fonte na hora de instalar); a Ferramentas não os lista (ficam na aba Legendas).
- **Entradas de teste** (`BF_TEST_TOOL_ENTRIES`): só valem com `NODE_ENV=test`, app não empacotado e URLs de loopback; substituem a oficial de mesmo id e aparecem com o selo "teste local". `catalog.js` é o único arquivo que cita a variável (um teste varre o código para garantir).

### 5.3 Modelo de dados e namespaces

- **Quem grava o quê.** Só o **renderer** grava o projeto (`BF.project.update` → `project:save`); o processo principal devolve resultados/eventos. Estado que sobrevive sem projeto aberto vive em arquivos próprios de `userData`, sempre com gravação atômica: `queue.json`, `preferences.json`, `learned.json`, `profiles.json`, `sources.json`, `history/<projectId>.json`, `chats/<plataforma>-<id>.json`, `transcripts/<projectId>.json` (transcrição do vídeo inteiro, formato `bf-transcript-1`, 5.9) e `transcripts/<projectId>.partial.json` (rascunho para retomar), `ai/config.json` (provedor de IA sem segredo, aceite de privacidade e limites) e `ai/secrets.json` (chaves de API, cifradas pelo sistema quando possível; só no app próprio, 5.9), `cache/encoders.json`, `cache/analysis/`, `cache/waveform/`, `cache/subtitles/`, `models/whisper-<id>/…`.
- **Campos do corte acrescentados pelos recursos** (todos preservados por `normalizeCut`): `titleCustom` e `reviewedRange` (revisão, 5.8); `audio.redo` (áudio, 5.6); `subtitles` completo e `exports[].jobId/key/revision` (5.5 e 5.7); `framing` parcial, `layoutChoice` e `layoutLocal` (5.4); `layout` (`'conversa'|'jogo'`, só da análise por IA, 5.9). Os cortes criados pela análise têm `origin:'auto'`, `relevance` e `reasons`, e **sempre** `status:'pending'`.
- **Namespaces `project.ext.<recurso>`** (quem escreve → onde está documentado): `ext.export` = `{ profileId?, overrides?:{[perfil]:{width,height,codec,bitrateKbps,encoder,fps}}, framing?:Framing parcial, nameTemplate?, useSuggestedLayout?:boolean /* ausente = ligado */, layouts?:{ conversa?, jogo? } /* { framing parcial, ref:{w,h} } */, layoutRefs?:{ conversa:[base64], jogo:[base64] } /* até 4 miniaturas 64×36 por layout */ }` (exportEngine, 5.4); `ext.subtitles` = `{ language, modelId, mode, sidecarFormat, style }` (subtitles, 5.7); `ext.analysis` = `{ settings, source:{ path, size, duration }, runAt, fromCache, tookMs, limit, engine:'algorithm'|'ai', ai?, signals, warnings, suggestions, dismissed }` (analysis, 5.9; `settings` ganhou `signals.text`, `weights.text` e `textWeights` (com a pista `humor`, "Expressões do canal") e **perdeu `audioHints`**, que projetos antigos ainda trazem e é ignorada; `source` é a identidade do vídeo a que o resultado pertence, `dismissed` as sugestões descartadas, `settings.engine` o motor escolhido e `ai` o resumo da última análise por IA, sem texto da transcrição); `ext.prefs` = `{ sourceChange?, match?, adoptedFrom? }` (prefs, 5.11). Fila, áudio e revisão não usam `ext` (a fila anota `cut.exports`; o áudio, `cut.audio`; a revisão, os campos do corte e o arquivo de histórico).
- **Origem da fonte**: `source.origin` = `null` | `{ type:'file' }` | `{ type:'obs' }` | `{ type:'vod', platform, url (canônica), videoId, channel, title, game, uploadDate ('AAAA-MM-DD'), fetchedAt (ISO), duration (s, extra) }`. O `videoId` da Twitch é só o número do link (sem o "v" do yt-dlp). `sources:refreshMeta` devolve `origin` nesse mesmo formato (consulta de novo a plataforma), mas **ninguém a chama hoje**: a comparação "a fonte mudou?" do `prefs` é sempre entre o arquivo aberto e o que o projeto registrou (`origin.duration` serve de reserva quando a duração medida falta); um VOD que cresceu no site só é percebido depois que o usuário baixa de novo e abre o arquivo.
- **`project.chat`** = `{ path, format:'bf-chat-1', count, fetchedAt, platform }`, gravado pelo `sources` (via `BF.project.update`); o `path` aponta para `userData/chats/…`.
- **`project:adopt`** copia cortes (sem `exports`), `meta`, `exportDir`, perfis, `ext` e campos desconhecidos; **não** copia `id`, `source`, `analysis`, `chat` nem `history`. Depois de adotar, o `prefs` chama `review:historyCopy { fromProjectId, toProjectId }` (em melhor esforço, nunca sobrescreve) para levar o histórico.
- **Regra de título**: quem renomeia cortes (a análise ao reanalisar, as fontes ao adotar) **nunca** troca o título de um corte com `titleCustom === true`. A análise, na prática, só **cria** cortes novos (não renomeia os existentes).

### 5.4 Exportação (exportEngine)

- **Perfis** (`src/core/export/profiles.js`): 12 embutidos (`vertical-<1080|1440|2160>-<h264|h265>`, 10 Mbps em todos os verticais; `horizontal-…` 10/16/35 Mbps) e os do usuário (`userData/profiles.json`, `kind:'custom'`, id `user-…`, nome único de até 60 caracteres). Embutidos nunca são editados nem excluídos (`PROFILE_BUILTIN`). `Profile` ganhou `framing?` (enquadramento inicial, parcial), `builtin?` (só leitura) e `fps` pode ser número. `export.profileId` (preferência) e `project.profileId` podem guardar o id de um perfil do usuário; quem lista perfis (Preferências) deve usar `export:listProfiles`.
- **Enquadramento**: `Framing` tem `focusY` (0..1, padrão 0,5). Camadas, da mais fraca para a mais forte: padrão do app < `profile.framing` < `project.ext.export.framing` < `cut.framing`. Valores fora da faixa são ajustados (clamp) por `normalizeFraming`; o Job guarda o enquadramento já resolvido em `job.framing` e o runner o resolve de novo com o mesmo resultado (idempotente).
- **`runExportJob(job, { tools, onProgress, signal, tmpDir, onStart? })`** → `{ output, warnings:[{code,message}], skipped, encoder:{kind,name}|null, sizeBytes }`. `skipped:true` quando `onConflict:'skip'` encontrou o arquivo (`output` = o arquivo existente, sem rodar o ffmpeg); `onStart({ pid })` é só observação. `onConflict` chega **sempre resolvido** (`rename|replace|skip|fail`; `ask` ou qualquer outro valor vale `fail`). `replace` grava no `.part` e troca de forma atômica só depois do sucesso; nada é sobrescrito sem escolha explícita; o vídeo de origem nunca é destino (`OUTPUT_IS_SOURCE` no QC).
- **`ExportError`** traz `code`, `message`, `recoverable` e `details:{ solution, stderr (final), exitCode }` (a fila lê `details.solution`). **Recuperáveis**: `FFMPEG_START_FAILED`, `IO_BUSY`, `FFMPEG_CRASH`, `DISK_TRANSIENT`. **Não recuperáveis**: `INPUT_MISSING`, `INVALID_PROFILE`, `INVALID_RANGE`, `NO_DISK_SPACE`, `OUTPUT_EXISTS`, `CANCELLED`, `CODEC_UNSUPPORTED` e os acrescentados `NO_FFMPEG`, `FFMPEG_FAILED`, `OUTPUT_NOT_WRITABLE`, `SUBTITLES_FAILED`, `AUDIO_FAILED`, `OUTPUT_INVALID`. O QC também usa `OUTPUT_IS_SOURCE`.
- **`preflight(job, { tools })`** (síncrono): erros que bloqueiam só aquele trabalho (`NO_FFMPEG`, `INVALID_PROFILE`, `INPUT_MISSING`, `INVALID_RANGE`, `OUTPUT_NOT_WRITABLE`, `OUTPUT_IS_SOURCE`, `NO_DISK_SPACE`, `CODEC_UNSUPPORTED`) e avisos que **nunca** bloqueiam (`NO_AUDIO`, `UPSCALE`, `HEVC_COMPAT`, `RES_COMPAT`, `BITRATE_LOW`, `BITRATE_HIGH`, `LONG_CUT`, `NAME_CONFLICT`, `LOW_DISK`, `ENCODER_FALLBACK`, `SUBTITLES_WARNING`, `SUBTITLES_UNAVAILABLE`, `AUDIO_UNAVAILABLE` e os `*_LIMITED` do áudio). O aviso `NAME_CONFLICT` é informativo: a decisão é da fila.
- **Codificadores**: `auto` usa a placa NVIDIA (NVENC) se um mini-encode real de 1 quadro funcionar (resultado em cache por 24 h, chave = caminho + tamanho + data do ffmpeg), senão software, sem aviso; `nvenc` sem placa cai para software **e avisa** (`ENCODER_FALLBACK`); falha da placa durante o trabalho refaz por software e avisa. Áudio da saída: AAC 192 kb/s, 48 kHz, estéreo.
- **Canais** `export:*`: `pickDir`, `listProfiles`, `saveProfile`, `deleteProfile`, `encoders`, `framePreview`, `sourceFrame`, `prepare`, `preflight` (e os legados `warnings`, `run`, `cancel`). `export:prepare { project, info, cutIds, profile, framing, outputDir, nameTemplate }` → `{ jobs, missing, reports }`; a prévia (`framePreview`) usa o **mesmo grafo** de filtros da exportação; `key` em `framePreview`/`sourceFrame` cancela o pedido anterior com a mesma chave (`SUPERSEDED`, ignorado pela interface).
- **Aba Exportar** ↔ fila: um único botão "Adicionar à fila (N)" refaz o `export:prepare`, envia por `BF.api('queue:enqueue', { jobs })` só os Jobs **sem erro** (os com erro ficam de fora e isso é dito) e leva para a tela Exportações (aba `queue`); se a fila não existe ou recusa, mostra o motivo e **não** diz que enfileirou. A barra de saída da tela Exportações mostra e altera o perfil e o destino do projeto aberto pelo `BF.exportOut` desta aba (`summary`, `ensureProfiles`, `chooseProfile`, `pickDir`). `cutExporter.js` e `exportProfile.js` (da base) foram aposentados.
- **Fonte do Job (`Job.sourceInfo`)**: `buildJobs` copia `audioTracks` (2 ou mais faixas de áudio) e `hdr: true` (curva de cor `smpte2084` ou `arib-std-b67`) **só quando valem um aviso**. Os dados vêm do `probeMedia` da base (`src/core/ffmpeg/probe.js`), que passou a devolver `audioTracks` (contagem) e `colorTransfer` (`video.color_transfer` ou `null`): mudança aditiva. A exportação usa sempre a **primeira** faixa de áudio (como a medição do Áudio e a forma de onda).
- **Códigos e avisos**: `FFMPEG_CRASH` só vale para sinal ou NTSTATUS `0xC000xxxx` (qualquer outra saída ≠ 0 é `FFMPEG_FAILED`). Avisos novos do QC (nunca bloqueiam): `AUDIO_TRACKS`, `HDR_SOURCE`, `NOT_9X16`, `NOT_16X9` e `CAMERA_RECT` (a câmera de um layout "webcam + jogo" sai da fonte, a fonte tem outra proporção da usada para medir o layout ou é pequena demais; é conta com medidas conhecidas, não procura a câmera na imagem). `export:listProfiles` pode trazer `warning` (arquivo de perfis ilegível: devolve os 12 embutidos); em `export:encoders`, `detection.nvenc.<codec>.reason` é texto em português e `detail` é a linha técnica do ffmpeg.
- **Layouts do canal (Conversa | Jogo)**, fonte única `src/core/export/layouts.js` (universal, com testes). Precedência, da mais forte para a mais fraca: `cut.framing` > preset do layout do corte (`cut.layoutChoice` do usuário > sugestão, **só com `ext.export.useSuggestedLayout` ligado**: detector local válido > `cut.layout` da análise > nenhuma) > `ext.export.framing` > perfil > app. As camadas se juntam campo a campo (`mergeLayers`) e **nenhuma é alterada por outra**. Presets: fábrica < Preferências (`export.layout.conversa|jogo`, canal > jogo > geral) < projeto (`ext.export.layouts`). O Job grava a origem em `job.framingSource = { kind:'custom'|'chosen'|'suggested'|'default', layout, via:'ia'|'detector'|null, base, label, preset:{ from, ref }|null, camera|null, confidence|null }` **só para auditoria**: a chave do job (`jobKey`) já inclui o enquadramento **resolvido**, não a origem. Sem `layouts` em `export:prepare` nenhum layout se aplica e a origem é `padrão`. Mudanças fora dos arquivos do exportEngine: uma linha em `QueueManager.enqueue` (preserva `framingSource` até o `queue.json`) e, nas Preferências, `DEFS[].valueText` (texto do valor quando a chave é editada em outra aba; lido por `formatValue` em `keys.js` e por `fmtValue` em `renderer/features/prefs.js`) e `DEFS[].maxLength`.
- **Detector local de layout** (`src/core/export/layoutDetector.js`): ffmpeg + Node, sem rede e sem dependências; compara quadros do corte com 2 a 4 quadros de referência de cada layout (miniaturas 64×36 em tons de cinza) e, na dúvida, devolve `layout:null` ("incerto": o corte segue o palpite da IA ou o padrão). O resultado só vale para as mesmas referências e o mesmo trecho (`key` = `<digest das referências>:<início>-<fim>`). Canais `export:layoutRef { sourcePath, timeSec }` → `{ thumb, w, h, timeSec }`, `export:detectLayouts { sourcePath, cuts:[{ id, start, end }], refs:{ conversa:[…], jogo:[…] } }` → `{ refsDigest, model, tookMs, results:[{ cutId, layout|null, confidence, reason, key, at, samples }] }` e `export:detectCancel` (uma detecção por vez); `export:prepare` aceita `layouts = { presets, useSuggested, refsDigest }`; evento do main `export:detectProgress { done, total }`. Erros: `BAD_REFS` (com `details.problems` entre `FEW_REFS`, `SIMILAR_REFS`, `NO_SCENERY`), `INVALID_ARGS`, `CANCELLED`, `NO_FFMPEG`, `INPUT_MISSING`, `NO_FRAME`.

### 5.5 Fila (queue)

- **Canais** (todos `{ ok:true, … }` ou `{ ok:false, code, message, details? }`): `queue:enqueue { jobs, force? }` → `{ jobs, ids }` (entrada estruturalmente inválida recusa **tudo**, `INVALID_JOB`; job repetido volta já como `skipped`); `queue:list` → `{ jobs, running, paused, parallel, active, blocked, recovery:{pending,jobs}, loadWarning, saveError, settings }`; `queue:pause { interrupt? }`; `queue:resume`; **`queue:recover { action:'resume'|'discard' }`** (canal extra do banner de recuperação); `queue:cancel { id } | { all:true } | { id:'all' }`; `queue:reorder { ids }`; `queue:remove { id }` (nunca apaga o arquivo exportado); `queue:retry { id }`; `queue:clearFinished { includeFailed? }` (as falhas ficam, salvo `includeFailed`); `queue:getSettings`/`queue:setSettings` (`parallel` 1..4 ou `null` = "padrão das Preferências", `retries` 0..5, `recovery` `ask|resume|discard`, `onConflict` `ask|rename|skip|fail` — **nunca** `replace` —, `defaultParallel?`); `queue:resolveConflict { id, action:'rename'|'replace'|'skip' }`.
- **Eventos** (também no `ctx.bus`): `queue:update` (coalescido, ~40 ms), `queue:progress { id, p, etaSec }` (no máximo 4 por segundo por job), `queue:jobDone { job, output }`, `queue:conflict { job, path }`, `queue:recovery { jobs }` (pode chegar antes da janela existir: a interface lê `recovery` de `queue:list`).
- **Estados**: `queued`, `running`, `done`, `failed`, `interrupted`, `cancelled`, `skipped`, `needsAction`. O job nunca fica `paused` (a pausa é da fila). `skipped` traz `skippedCode` (`ALREADY_DONE`, `ALREADY_QUEUED`, `CONFLICT_SKIPPED`) e `skippedReason`. O resultado do executor com `skipped:true` vira `skipped`.
- **`Job.onConflict:'ask'`** significa "siga o ajuste de conflito da fila" (padrão: perguntar; `needsAction` antes de ocupar vaga). **Substituir nunca é padrão**: só escolha arquivo a arquivo, com segunda confirmação. O executor nunca recebe `ask`.
- **Não repetir concluído**: chave estável = SHA-256 de fonte (caminho + duração + resolução) + início + fim + perfil (sem `name`/`resolutionLabel`) + enquadramento + áudio (sem `history`) + legendas (só se ligadas). O mesmo trabalho concluído na **mesma pasta de destino** com o arquivo ainda existindo entra `skipped/ALREADY_DONE`; "Exportar de novo" (`retry` ou `force`) refaz de propósito e, como o arquivo existe, cai no conflito de nome.
- **Tentativas**: `retries` só para os códigos recuperáveis (5.4), espera 2 s × 2^(n−1) (máx. 30 s); qualquer outro código (inclusive desconhecido) vai direto para `failed` com `message` e `solution` (a do executor, `details.solution`, tem prioridade). Erro do QC bloqueia só aquele job; aviso não bloqueia.
- **`cut.exports[]`** ganha `jobId`, `key` e `revision` além de `{ path, at, start, end, profile }`; a tela Exportações (aba `queue`) anota em `queue:jobDone` (idempotente) e emite `cuts:changed { ids, from:'queue:done' }`. `profile` pode ser o id (texto) ou um objeto com `id`; o aprendizado lê os dois.
- **Persistência**: `userData/queue.json` (atômico, com fsync); arquivo ilegível ou de versão mais nova é preservado (`.corrupt` / `.vN.bak`). Recuperação: ao abrir, `running` vira `interrupted` e, com `recovery:'ask'`, a fila espera o banner (Retomar/Descartar). **O ffmpeg não é retomado: interromper = recomeçar do início.**
- **Teste**: `BF_TEST_QUEUE_RUNNER` (caminho absoluto de um módulo com `runExportJob`) só é aceito com `NODE_ENV=test` e `app.isPackaged === false`; só o e2e da fila o usa.
- **Prefs → fila**: a fila lê `queue.parallel` por `BF.prefs.get` e sincroniza ao abrir o app, carregar projeto, mostrar a aba e, na hora, quando chega `prefs:changed` com `queue.parallel` em `keys` (`defaultParallel` enviado ao main).

### 5.6 Áudio

- **Assinaturas reais** (`src/core/audio/audioFilter.js`, universal: `window.BFAudioFilter` no renderer): `buildAudioFilter(audio, { duration, offset? }) -> string|null` (`duration` é obrigatório para o fade out; sem ela o fade out é omitido com `FADE_OUT_NEEDS_DURATION`; `offset: cut.start` só se o corte for feito depois da entrada — a exportação usa `-ss` antes do `-i`, então não passa) e `resolveAudio(audio, { duration }) -> { …, warnings, neutral }` (avisos `GAIN_LIMITED`, `FADE_IN_LIMITED`, `FADE_OUT_LIMITED`, `FADE_OUT_NEEDS_DURATION`). Mudo → `volume=0`; ganho → `volume=<dB>dB`; fades → `afade`. Limites: ganho −30..+20 dB, cada fade até a metade da duração. **Não existe tratamento automático** (nada de normalização, redução de ruído, compressor): um teste varre o recurso.
- **`audioHistory.js`** (universal: `window.BFAudioHistory`, depende de `BFAudioFilter` carregado antes): `applyChange`, `undo`, `redo`, `restoreEntry`, `resetToOriginal`. Ambos entram por `<script>` estático em `renderer/index.html` antes de `features/audio.js` (que ainda os carregaria sozinha se faltassem).
- **`cut.audio`** = `{ gainDb, mute, fadeInSec, fadeOutSec, history:[{at,label,before,after}], redo?:[…] }`; `history` guarda até 50 entradas; `redo` é a pilha de refazer (some quando vazia); uma mudança nova a descarta.
- **`audio:measure { sourcePath, start, end }`** → `{ hasAudio, peakDb, meanDb, samples, start, end, cached }` (ffmpeg `volumedetect`, só leitura, primeira faixa de áudio). Erros: `NO_FFMPEG`, `INVALID_PATH`, `INVALID_RANGE`, `INPUT_MISSING` (só arquivo local existente), `MEASURE_FAILED`, `MEASURE_TIMEOUT` (5 min), `CANCELLED`. Fonte sem áudio e trecho depois do fim são resultados normais, não erros.
- **Eventos**: cada mudança (inclusive desfazer/refazer/restaurar/voltar ao original) chama `BF.project.update({reason:'audio:adjust'})`, emite `cuts:changed { ids, from:'audio:adjust' }` e `decision { cutId, type:'adjust', scope:'audio', before, after }` com `before`/`after` = `{ gainDb, mute, fadeInSec, fadeOutSec }`. Quem consome `adjust` para tempos de corte precisa checar `scope`/`what` (5.12).
- **`BF.audioPreview`** = `{ state(), level(), setMode(mode), nodes() }`. Um `<video>` só aceita **um** `MediaElementSource`: quem precisar do áudio do player deve reutilizar `BF.audioPreview.nodes()` em vez de criar outro.

### 5.7 Legendas

- **`cut.subtitles`** = `{ enabled, basedOn:{start,end,revision}, cues:[{start,end,text,needsReview?}], style, mode, sidecarFormat?, generated? }`. **Os tempos das falas são em segundos RELATIVOS ao início do corte** (0 = `cut.start`), os mesmos do vídeo exportado. `mode` ∈ `burn | sidecar | both` (a leitura aceita também `srt`, `ass`, `burn+srt`, `burn+ass`, normalizados por `shared.normalizeMode`); `sidecarFormat` ∈ `srt | ass`; `generated` = `{ at, language, model, modelLabel, start, end, noSpeech }` da última geração automática (`start`/`end` em tempo da ORIGEM); `style` segue `shared.DEFAULT_STYLE` (11 campos, validados por `shared.normalizeStyle`; tamanhos em pixels de um quadro de referência de 1080 px de lado menor).
- **`prepareBurnIn(cut, { tmpDir, width, height, ffmpegPath?, support?, fontsDir? })`** é **síncrono** e devolve `null` (legenda desligada, sem falas ou nenhuma visível) ou `{ vfFilter: string|null, sidecars:[{path, ext}], warnings:[string] }`; `vfFilter` é `null` quando a entrega é só arquivo separado; o filtro entra **depois** do enquadramento, na resolução de saída; lança `SubtitlesError` (`BURNIN_UNSUPPORTED`, `INVALID_SIZE`, `NO_TMPDIR`). O jobRunner copia os `sidecars` ao lado do vídeo como `<nome do vídeo>.<ext>` sem sobrescrever (se já existe um diferente: aviso `SIDECAR_EXISTS`). Também exportadas: `detectBurnInSupport(ffmpegPath)` e `subtitleWarnings(cut)` (o QC as usa para avisar antes de enfileirar). Sem libass no FFmpeg a legenda incorporada fica desabilitada com o motivo; arquivo separado nunca depende do libass.
- **Intervalo do corte**: se `cut.start/end` diferem de `basedOn`, as falas acompanham (`shared.rebaseSubtitles`: deslocadas e recortadas; as afetadas ficam `needsReview`; **nada é apagado**). A aba reconcilia ao abrir o projeto, em `cuts:changed` de outros recursos e ao mostrar a aba; `prepareBurnIn` aplica a mesma regra em memória. Quem altera `start`/`end` deve incrementar `revision` e emitir `cuts:changed` (a revisão faz).
- **`decision`**: Legendas emite `adjust` com `before`/`after` = `{ what:'subtitles', … }` (`{ action:'shift', seconds }`, `{ enabled }`, `{ mode }` ou `{ style }`), **nunca** `start`/`end` do corte.
- **Preferências**: `subtitles.style` segue `normalizeStyle`; a aba lê `BF.prefs.get('subtitles.style', null)` e `BF.prefs.get('subtitles.mode', 'burn')` ao criar a legenda de um corte; `subtitles.enabled` só define se a caixa "Legendar este corte" de um corte que ainda não tem legenda nasce ligada (a escolha continua explícita por corte; nada é gerado sozinho) e o botão "Usar esta aparência nos próximos vídeos" grava `subtitles.style`.
- **Canais** `subtitles:*`: `status`, `installModel`, `cancelModel`, `removeModel`, `generate`, `cancel`, `importFile`; eventos `subtitles:progress { cutId, phase, percent, message }` e `subtitles:modelProgress`. O motor é a entrada `whisper` (5.2); os modelos (Tiny, Base, **Pequeno** padrão, Médio, Large v3 Turbo) têm tamanho e SHA-256 lidos da fonte oficial na hora de instalar. Uma geração por vez; o idioma padrão é o português. **Nunca inventa fala**: sem áudio, silêncio ou só ruído/música o resultado é "nenhuma fala detectada".

- (analysis → subtitles) **`ctx.transcription`** (criado por `handlers/subtitles.js`; a transcrição do vídeo inteiro da aba Análise o usa): `prepareRun({ key, modelId, engine, onPrepare })` confere ffmpeg, motor e modelo, registra a execução (o mesmo "uma por vez" e a mesma proteção do motor/modelo de `subtitles:generate`) e decide placa ou processador; `releaseRun(run)`; `describeRun(run, result)`; `readiness({ modelId })` → `{ ready, reason, modelId, modelLabel, device, busy }`. `subtitles:generate` passou a usar `prepareRun` (comportamento igual).

### 5.8 Revisão e histórico (review)

- **Campos do corte** (dono: review): `titleCustom` (`true` = digitado pelo usuário, `false` = veio de uma sugestão, ausente = desconhecido) e `reviewedRange` (`[início, fim]` quando foi aprovado/rejeitado; "Alterado" = o tempo atual difere desse). Sugestões de título (`cut.titleSuggestions`, até 12) são geradas localmente (sem IA nem rede) e **nunca** trocam um título personalizado sem confirmação.
- **`decision` do módulo**: `approve|reject|reset` (before/after = status), `retitle` (título), `recategorize` (categoria), **`adjust` (before/after = `{ start, end }`)**, `remove` (before = cópia do corte, after `null`), `create` (before `null`, after = cópia). Campos extras: `reviewGroup` (id do grupo; todas as decisões de um lote o compartilham), `source` (`user`, `batch`, `undo`, `redo`, `restore`) e `label`. Desfazer/refazer/restaurar também emitem `decision` com o tipo do **resultado** (desfazer uma aprovação emite `reset`). Quem aprende com as decisões (prefs) **trabalha com o estado atual dos cortes**, não com o evento, então não conta desfazer como preferência.
- **Eventos**: um `cuts:changed { ids, from:'review' | 'review:inline' }` por ação (mesmo em lote); `cut:selected { id }` ao abrir um corte. O `engine.recordExternal` transforma `decision` de **outros** recursos em entradas de histórico desfazíveis (`create`, `remove`, `approve|reject|reset`, `retitle`, `recategorize`, `adjust` com `{start,end}`).
- **`BF.review`** (namespace do recurso): `ready`, `engine`, `adjust(id,{start?,end?})`, `select(id,{seek})`, `activeId()`, `history.flush()`, `timeline.{toggle,open,close,isOpen,info,edgePoint,timeToX}`.
- **Histórico**: arquivo `userData/history/<projectId>.json` (atômico, só acrescenta, até 5000 grupos; `project.history` do modelo **não** é usado). A pilha de desfazer/refazer é só da sessão; "Restaurar" volta ao estado de ANTES da ação escolhida e vira entrada nova. Canais: `review:historyLoad`, `review:historyAppend`, `review:historyCopy`.
- **Forma de onda**: `review:waveform { sourcePath, buckets?, start?, end?, durationHint? }` → `{ duration, start, end, buckets, secPerBucket, peaks, cached, partial, masterPps }` (ffmpeg, primeira faixa de áudio, cache em `userData/cache/waveform/`), `review:waveformCancel { sourcePath }`, evento `review:waveformProgress { sourcePath, p }`. Erros: `INVALID_ARGS`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_AUDIO`, `WAVEFORM_FAILED`, `CANCELLED`, `HISTORY_WRITE_FAILED`.
- **Módulos universais** (`core`, `order`, `similarity`, `titles`, `batch`, `engine` e `history/log`): carregados por `<script>` dinâmico pelo `cuts.js` (que detecta `window.BFReview.engine` se um dia entrarem no `index.html`). Atalhos: `I`/`O`, `Espaço`, `Ctrl+Z`/`Ctrl+Y`; **`J`/`K`/`L` não foram implementados** (decisão).
- **Preferências lidas**: `review.defaultSort` (`chrono`|`relevance`, ao abrir o vídeo) e `review.categories` (lista de textos; aceita objetos com `name`/`label`; padrão `Jogada, Clutch, Engraçado, Fail, Hype, Dica`). A aba redesenha com `prefs:changed`.
- **Fonte atualizada**: enquanto existir `project.ext.prefs.sourceChange` com `dismissed:false`, a aba Cortes sinaliza com um selo os cortes cujo `end` passa da duração da fonte (só sinaliza: o corte não é alterado nem apagado); a aba Preferências lista os mesmos cortes.

### 5.9 Análise (analysis)

- **Canais**: `analysis:defaults` → `{ defaults, ranges, version }`; `analysis:start { path, params?, chatPath?, fresh?, projectId?, size?, duration? }` → `{ jobId }` (volta na hora; uma por vez, senão `BUSY`; erros `INVALID_ARGS`, `NO_FFMPEG`, `NO_FFPROBE`, `INPUT_MISSING`); `analysis:cancel { jobId? }`; `analysis:status`. Eventos: `analysis:progress { jobId, p, stage, message }`, `analysis:done { jobId, result }`, `analysis:failed { jobId, code, message, details? }` (inclui `CANCELLED`). O processo principal **não grava o projeto**.
- **Resultado**: `{ version, at, fromCache, tookMs, source, params, signals, usedSignals, limit, warnings, suggestions:[{ id, start, end, peak, relevance, reasons, signals }] }`. Sinal ausente ou com falha **não bloqueia** (vira aviso: `NO_AUDIO`, `CHAT_UNREADABLE`, `AUDIO_FAILED`, `IMAGE_FAILED`, `AUDIO_PARTIAL`, `IMAGE_PARTIAL` e os de cobertura `AUDIO_SHORT`, `IMAGE_SHORT`, `AUDIO_SILENT`); só `NO_SIGNALS` falha. `analysis:start` aceita também `fresh:true` (ignora o cache). `source.duration` do resultado é a duração do ffprobe e **nenhuma sugestão termina depois dela** (a exportação recusaria o corte). Resultado incompleto (`*_PARTIAL`) não vai para o cache. Códigos de falha: `CANCELLED`, `INVALID_ARGS`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_FFPROBE`, `BUSY`, `PROBE_FAILED`, `NO_SIGNALS`, `FFMPEG_START_FAILED`.
- **Dados no projeto**: `project.analysis.lastRun = { at, signals, params, count }` e `project.ext.analysis` (5.3). As sugestões viram cortes `origin:'auto'`, `status:'pending'` com `relevance` e `reasons`, com `cuts:changed { ids, from:'analysis' }` e um `decision` `create` por corte; **nada é aprovado automaticamente**.
- **Chat**: lê só `bf-chat-1` (via `readChat` do `sources`; cai para o JSON direto se ele falhar). **Preferências lidas**: `analysis.padBeforeSec`, `padAfterSec`, `minDurationSec`, `maxDurationSec`, `minRelevance` e `analysis.keywords`. A sensibilidade é um controle por projeto (não há `analysis.sensitivity` ainda, 5.15). Todos os critérios são **provisórios** e calibrados só com mídia sintética (`docs/recursos/analysis.md`).

- **IA na nuvem (analysis, `src/core/ai/**` e `src/core/analysis/ai/**`)**: `analysis:start` aceita `engine:'ai'` (e então `projectId`, `size`, `duration`, `meta?`, `existingCuts?`; **não aceita mais `audioHints`**, as dicas de volume foram removidas); os eventos `analysis:progress|done|failed` são os mesmos do algoritmo e `analysis:status` traz `engine`. Resultado de IA: `engine:'ai'`, `suggestions:[{ id, start, end, peak, relevance, reasons, title, category, layout?, flags? }]` e `ai:{ provider, model, blocks, failedBlocks, calls, retries, promptTokens, completionTokens, pickUsed, candidates, droppedTotal, droppedByReason, dropped:[{ reason, detail, start, end, title }] }`. Novos códigos: `NO_KEY`, `NOT_CONFIGURED`, `CONSENT_REQUIRED` (aviso de privacidade não aceito: nada é enviado), `NO_TRANSCRIPT`, `TOO_MANY_CALLS`, `AUTH`, `MODEL`, `RATE_LIMIT`, `QUOTA`, `SERVER`, `NETWORK`, `TIMEOUT`, `INTERRUPTED`, `BAD_JSON`, `KEY_INSECURE`. **Perfil de humor do canal** (`analysis/humor.js`, docs/recursos/analise-ia.md seção 16): `analysis:start` (IA) e `analysis:aiEstimate` aceitam `profile` (`{ criteria, catchphrases, reactions, examples }`, validado de novo no processo principal), o canal `analysis:humorExamples { projectId }` devolve `{ examples: { approved, rejected, projects } }` (cortes do mesmo canal que iriam como exemplo; não envia nada) e o resultado traz `ai.profile = { criteria, catchphrases, reactions, examples:{ approved, rejected } }` (só contagens). Canais novos (11): `analysis:aiState`, `aiSave`, `aiTest`, `aiAccept`, `aiEstimate`, `humorExamples`, `transcriptStatus`, `transcriptImport`, `transcriptGenerate`, `transcriptCancel`, `transcriptRemove`; eventos `analysis:transcriptProgress|Done|Failed`. Todos no domínio `analysis:` (a lista permitida do BDS já o cobre). Detalhes, formatos e a regra de segredos em docs/recursos/analise-ia.md.
- **Transcrição (formato `bf-transcript-1`)**: `{ format, version:1, projectId, origin:'generated'|'imported', source:{ path, size, duration }, engine?:{ modelId, modelLabel, language, device, deviceLabel, fellBack }, importedFrom?, createdAt, updatedAt, coveredSec, stats:{ cues, speechSec, laughs, dropped:{ invalid, beyond, repeats } }, cues:[{ start, end, text, laugh? }] }` (segundos desde o início do vídeo). Marcas de risada (`*Risos*`) viram `laugh:true`.
- **Provedor do hospedeiro**: `createBfModule({ ai: { describe(), chat(params) } })` (5.1/`docs/modulo-bds.md`): com ele `ctx.host.ai` existe, o Braga Frame **não guarda chave** (o hospedeiro faz a requisição) e a configuração do provedor é só leitura.
- **Algoritmo v5 (`ALGO_VERSION` 5): momento calmo** (`calmSignal.js`; `signals.calm`, `weights.calm` 0,7, `result.signals.calm = { used, reason, calmSeconds }`; cota própria `calmLimit`, e `result.limit` soma as duas). **Algoritmo v4 (`ALGO_VERSION` 4) e o sinal de texto**: `analysis:start { path, params?, chatPath?, fresh?, projectId?, size?, duration? }`; com `projectId` (e `size`/`duration`) o processo principal procura a transcrição do projeto (conferida com o arquivo) e a usa como sinal de **texto**: `result.signals.text = { used, reason, cues?, laughs? }`, `result.usedSignals` pode trazer `'text'` e há um aviso novo, `TEXT_SHORT`. Parâmetros novos: `params.signals.text`, `params.weights.text`, `params.textWeights` (`laugh`, `exclaim`, `pace`, `repeat`, `meta`, `humor`), `params.humor` (`{ phrases, reactions }`: bordões e palavras de reação do perfil de humor; entra na chave de cache; `result.signals.text.humorHits` conta as achadas, só com perfil) e `params.spread` (`windowSec`, `perWindow`, `minGapSec`: as sugestões ficam distribuídas no tempo). A relevância nunca chega a 1,0 por sinal (teto 0,97). Sem transcrição (ou de outro arquivo) o texto é ignorado com o motivo e o resto roda igual.
- **IA: configuração e privacidade**: `analysis:aiState` devolve `selected: null` e `provider.id: null` enquanto o usuário não escolhe o provedor (nenhum vem pré-selecionado); `presets[].suggestedModel` e `provider.suggestedModel` só sugerem (o modelo vem do usuário; **única exceção**: no OpenRouter, escolhido o provedor, `provider.model` parte do roteador gratuito `openrouter/free` até o usuário escolher outro, sem gravar o padrão); `analysis:aiSave` recusa `model`/`apiKey`/`baseUrl`/`clearKey` sem provedor (`INVALID_ARGS`) e `analysis:aiAccept` responde `NOT_CONFIGURED`. O aceite do aviso de privacidade é guardado como `{ origin, baseUrl?, at }` por provedor, **não expira**, e mudar o endereço do Personalizado o apaga (e a chave, se a origem mudou). `provider.reasonCode` (novo) diz qual código vale enquanto o provedor não está pronto: `NOT_CONFIGURED` (sem provedor, endereço ou modelo) ou `NO_KEY` (sem chave ou chave ilegível); `chat`, `test` e `analysis:start` o usam. O método de IA está na **versão 2** (mensagem de sistema sem dicas de volume; `result.signals` da IA não traz `audio`).
- **Descartar uma sugestão não é decisão**: não emite `decision` nem `cuts:changed`, só `project:changed` com `reason: 'analysis:dismiss'` ou `'analysis:restore'`; o descarte fica em `ext.analysis.dismissed` e não entra no histórico da revisão nem no aprendizado. Se o produto quiser aprender com descartes, falta definir um tipo de `decision` novo (dono: prefs + analysis).
- **OpenRouter só com modelos gratuitos** (`src/core/ai/openrouter/**`, [openrouter-gratuito.md](recursos/openrouter-gratuito.md)): o provedor `openrouter` tem `freeCapable: true`; `analysis:aiState` traz `provider.freeCapable`, `provider.freeOnly` e `provider.fallbackModels` (e `presets[].freeCapable`), e `provider.reasonCode` pode ser **`NOT_FREE`** (modelo pago com o modo ligado: o provedor não fica pronto). `analysis:aiSave` aceita `freeOnly` (boolean; **ligado por padrão**, guardado por provedor) e `fallbackModels` (até 3 ids, só gratuitos com o modo ligado) **somente no OpenRouter** (`INVALID_ARGS` nos outros; `NOT_FREE` se a reserva tem um modelo pago com o modo ligado). **A regra é garantida no código do chat** (`openrouter/guard.js` e `ai/runtime.js`), não só na interface: antes de CADA pedido o modelo é conferido (`NOT_FREE`: o pedido nem sai), o corpo nunca leva `models`/`route`/plugin de busca pagos, há ~3 s entre pedidos (Pacer: 20 por minuto), a falha de um modelo (404, 429 por minuto ou do provedor, 5xx, tempo esgotado, resposta inválida) tenta o **próximo gratuito** da reserva do usuário, e o erro chega explicado em português, sem a chave e sem o `user_id` da conta. Antes de cada análise o `manager.js` confere a lista pública de modelos (cache de 6 h). Códigos novos: `NOT_FREE`, `DATA_POLICY` (404 pela política de dados da conta), `CREDITS` (402) e `MODERATION` (403); `QUOTA` vale também para o limite **diário** de pedidos gratuitos. `result.ai.models = { <modelo>: chamadas }` diz quem **de fato respondeu** (o campo `model` da resposta; com o roteador é o modelo sorteado) e há os avisos `AI_MODEL_SWITCHED`, `AI_COST_REPORTED` (o OpenRouter informou custo com o modo ligado), `FREE_LIST_OLD` e `FREE_LIST_MISSING`. A resposta de um modelo de **moderação/segurança** sorteado pelo roteador (medido em rede real: `nvidia/nemotron-3.5-content-safety:free` respondeu "User Safety: unsafe") vale como falha da tentativa (`BAD_RESPONSE`): a reserva assume ou a análise tenta de novo. **No BDS a regra "só gratuitos" vale também** quando o provedor ativo do assistente é o OpenRouter (reconhecido pelo `serverHost` do `describe()` do hospedeiro): o modelo dele passa pelo mesmo guard, `provider.freeCapable`/`freeOnly` aparecem em `analysis:aiState`, `analysis:aiSave { freeOnly }` é o **único** ajuste permitido no modo hospedeiro (o resto é só leitura) e o `chat` do hospedeiro recebe `acceptProvider(p)`, que o `AIService` do BDS usa para filtrar a cadeia de fallback (`AI_NOT_ALLOWED` quando recusa todos; chega como `NOT_FREE`). Outros provedores do BDS não são afetados (`docs/modulo-bds.md`).

### 5.10 Fontes e chat (sources)

- **Canais** `sources:*`: `state`, `setSettings`, `pickFolder`, `obsDetect`, `obsList`, `probe`, `fetchVod`, **`refreshMeta`** (devolve `origin` pronto para comparar com `project.source.origin`; o `prefs` **não** a usa: não consulta a plataforma sozinho ao abrir um projeto), `partial`, `discardPartial`, `download` (só volta **ao terminar**), `chat`, `cancel`, `originFor`, `chatCheck`. Um único trabalho por vez (`BUSY`). Evento `sources:progress { jobId, kind:'download'|'chat', phase, percent, downloaded, total, speed, eta, message, resumed, resumeBytes, url, videoId, platform }` (`phase` ∈ `prepare|download|merge|chat|finishing|done|error|cancelled`; `percent` e `total` são `null` quando a fonte não informa — barra indeterminada).
- **Erros** (`{ ok:false, code, message, details:{ solution, dependsOnAccess, retryable, raw } }`): mensagens com causa e solução; o que **depende da fonte** diz isso (`dependsOnAccess`). Baixar depende de acesso, permissões e disponibilidade da fonte.
- **Chat** (`src/core/sources/chatFormat.js`): `readChat`/`writeChat` são **assíncronas** (`readChatSync`/`writeChatSync` existem); `messagesPerWindow(chat, windowSec, durationSec?)` devolve `number[]` (índice `i` = `[i*windowSec, (i+1)*windowSec)`; com `durationSec` o vetor vai até o fim do vídeo); `normalizeChat` descarta mensagens com tempo inválido e ordena por `t`; erros `ChatFormatError` com `code` ∈ `CHAT_NOT_FOUND`, `CHAT_UNREADABLE`, `CHAT_BAD_FORMAT`, `CHAT_BAD_ARGS`. Arquivos em `userData/chats/<plataforma>-<id>.json`.
- **Ganchos**: `sources.js` registra `beforeOpen` (preenche `ctx.origin` de arquivo conhecido: VOD baixado por aqui ou gravação numa pasta do OBS) e `afterOpen` (preenche `meta.game`/`meta.channel` **só se vazios** e anexa o chat). Como `sources.js` carrega antes de `prefs.js` no `index.html`, o `afterOpen` do `prefs` já enxerga `meta` preenchido. Reabrir um VOD nunca sobrescreve o que o usuário editou.
- **Ferramentas**: yt-dlp, TwitchDownloaderCLI e Deno (5.2). O Deno é **recomendado, não obrigatório** para o YouTube; a aba mostra o aviso e segue tentando. Cookies do navegador (`--cookies-from-browser`) valem só para o yt-dlp.
- A aba **Novo projeto** (`sources`; antes Fontes, ordem 70) funciona **sem projeto aberto**, assim como Projetos, Exportações, Preferências e Ferramentas. A tela: a pergunta "Como deseja adicionar o seu vídeo?", quatro cartões (Arquivos locais, YouTube, Twitch, Gravações do OBS) e só o painel do escolhido: a área de soltar (arrastar e soltar ou escolher o arquivo por `source:pick`), o painel do link (o mesmo para YouTube e Twitch; colar o link do outro site troca o cartão) ou a lista do OBS. A escolha do cartão fica em `BF.local` (`sourceKind`). Abrir um vídeo estando na tela leva para a aba Cortes (`afterOpen` + `tab:changed`). Detalhes em docs/recursos/sources.md.

### 5.11 Preferências (prefs)

- **`BF.prefs`** (renderer, `features/prefs.js`; o objeto da base é mantido e suas funções são trocadas por dentro, então referências antigas continuam certas): `get(key, fallback)` síncrono (devolve o `fallback` de quem pergunta quando nada do usuário/aprendido vale; senão o padrão do contrato), `resolve()` → `{ chave: valor }`, `explain(key)` → `{ value, scope:'channel'|'game'|'general'|'default', source:'explicit'|'learned'|'default', scopeName, label, evidence }`, `set(key, value, scope?)`/`unset(key, scope?)` (`scope`: `'general'` (padrão), `'game'`/`'channel'` do projeto aberto ou `{ type, name }`), `scope()` (jogo/canal a que o cache se refere), `reload()` e `ready` (Promise do primeiro carregamento). Evento `prefs:changed { reason, keys }` no `BF.bus`, só quando algum valor **em vigor** mudou.
- **Prioridade (PROVISÓRIA, a confirmar com a Liz)**: para cada chave, **canal** (valor do usuário, depois o aprendido) > **jogo** (idem) > **geral** (idem) > padrão. Jogo e canal vêm de `project.meta` e, na falta, de `source.origin.game/channel` (nunca grava `meta` sozinho); nomes ignoram acento, caixa e espaços repetidos. Mudar a ordem é só em `Preferences.resolve`.
- **Chaves** (padrão; validação): `export.profileId` (`vertical-1080-h264`; aceita id de perfil do usuário), `export.framing.mode` (`center|blur|stack|custom`), `analysis.minRelevance` (0,5; 0..1), `analysis.minDurationSec` (15; 3..120), `analysis.maxDurationSec` (60; 5..180) — as faixas da análise (`RANGES` de `analysis/params.js`) —, `analysis.padBeforeSec` (3; 0..60), `analysis.padAfterSec` (2; 0..60), **`analysis.keywords`** (lista de textos; vazio/ausente = as do app), **`analysis.humor`** (objeto, até 16 KB; perfil de humor do canal, normalizado e nunca vazio), `review.defaultSort` (`chrono|relevance`), `review.categories` (lista, até 30), `queue.parallel` (1; 1..4), `subtitles.enabled` (false), `subtitles.mode` (`burn|sidecar|both`), `subtitles.style` (objeto, até 4 KB). A duração mínima não pode passar da máxima no mesmo escopo; conflito entre escopos vira **aviso** na resolução.
- **Aprendizado**: o renderer observa `decision` e envia (a cada ~0,4 s) o **estado atual** dos cortes tocados (`prefs:observe`); nada aprendido vale antes de **N cortes de evidência** (padrão 5, configurável de 3 a 100) e tudo é visível, editável, desativável e desfazível pelo histórico. Regras: faixa de duração a partir da mediana dos aprovados, categorias mais usadas, relevância mínima, perfil de exportação mais usado.
- **Correspondência e fonte atualizada** (ganchos do `prefs`): `beforeOpen` chama `prefs:inspect { path, origin? }` (não grava nada) e pergunta ("Abrir o projeto existente / Criar novo / Cancelar"); "abrir o existente" usa `project:adopt` e `review:historyCopy`; fonte regravada/cresceu mostra a diferença antes de abrir, tanto no mesmo caminho (`compare`) quanto numa live parecida em outro arquivo (`matches[].compare`, mostrada na própria pergunta; ao abrir o existente grava `sourceChange`). Grava `project.ext.prefs` = `{ sourceChange?, match?, adoptedFrom? }`. Nunca abre sem confirmar e nunca altera o projeto original.
- **Canais** `prefs:*`: `schema`, `resolve`, `get`, `set`, `unset`, `list`, `names`, `observe`, `learned`, `learnedSet`, `learning`, `history`, `revert`, `forget`, `inspect`. Códigos: `UNKNOWN_KEY`, `INVALID_VALUE`, `INVALID_SCOPE`, `INVALID_ARGS`, `INVALID_PATH`, `NOT_FOUND`, `ALREADY_REVERTED`, `NOT_REVERSIBLE`, `WRITE_FAILED`. No processo principal, `ctx.preferences` expõe o serviço e `ctx.bus` emite `prefs:changed { what }`. Arquivos: `preferences.json` e `learned.json` (atômicos; ilegível vira `.corrupt` e o app recomeça nos padrões e avisa).

### 5.12 Eventos (tabela completa)

**No `BF.bus` (renderer)**

| Evento | Payload | Quem emite | Quem escuta |
|---|---|---|---|
| `project:loaded` | `{ project, restored }` | base | analysis, audio, cuts, export, prefs, queue, shell, sources, subtitles, timeline |
| `project:changed` | `{ reason }` | base (`BF.project.update`) | analysis, export, prefs, sources |
| `cuts:changed` | `{ ids?, from? }` | review (`'review'`, `'review:inline'`), base, analysis (`'analysis'`), audio (`'audio:adjust'`), export, queue (`'queue:done'`), subtitles | analysis, audio, cuts, export, subtitles, timeline |
| `cut:selected` | `{ id }` | review, base, audio, prefs ("Ver"), subtitles, timeline | audio, cuts, shell, subtitles, timeline |
| `decision` | veja abaixo | review (pelo engine), base, analysis, audio, subtitles | review (histórico, `recordExternal`), prefs (aprendizado) |
| `player:time` | `{ time }` | base | subtitles (prévia), timeline |
| `tools:changed` | `{ tools }` | base (vem do main) | analysis, audio, export, shell, sources, subtitles, tools |
| `prefs:changed` | `{ reason, keys }` | prefs | review, queue |
| `review:timeline` | `{ open }` | review | review (interno) |

**`decision` — as formas de `adjust`** (distinguir **antes** de ler `start`/`end`):

| Quem emite | Forma | Como reconhecer |
|---|---|---|
| review (tempo do corte) | `before`/`after` = `{ start, end }` | sem `scope` e sem `before.what` |
| audio | `scope:'audio'`, `before`/`after` = `{ gainDb, mute, fadeInSec, fadeOutSec }` | `scope === 'audio'` |
| subtitles | `before`/`after` = `{ what:'subtitles', … }` | `before.what === 'subtitles'` |

Os demais tipos têm `before`/`after` simples (status, título, categoria) ou a cópia do corte (`create`/`remove`). Campos opcionais do review: `reviewGroup`, `source` (`user|batch|undo|redo|restore`), `label`.

**Quem consome `decision` precisa ler assim** (regra que o `prefs` já segue em `classifyDecision`): só `approve|reject|reset|recategorize|remove` e `create` de corte **manual** contam como decisão do usuário; `create` com `after.origin === 'auto'` (sugestões da análise em lote) **não** conta; `adjust` só conta com `before`/`after` = `{ start, end }` (nunca com `scope` nem `what`); `retitle` não muda o que se aprende; `source` `undo|redo|restore` não é evidência nova (só retira o que foi desfeito). O histórico da revisão (`engine.recordExternal`) guarda as decisões de outros recursos que ele sabe desfazer (`create`, `remove`, status, título, categoria, `adjust` de tempo) e ignora os `adjust` de áudio e de legendas (conferido executando `recordExternal` com os dois).

**Do processo principal para o renderer** (`BF.on(canal, cb)`; os marcados com ● também saem no `ctx.bus`)

| Canal | Payload |
|---|---|
| `tools:changed` | `{ tools }` (vira evento do `BF.bus`) |
| `tools:progress` ● | `{ id, label, phase, message, percent, received, total, speedBps }` |
| `queue:update` ● | `{ jobs, running, paused, parallel, active, blocked, recovery, loadWarning, saveError, settings }` |
| `queue:progress` ● | `{ id, p, etaSec }` |
| `queue:jobDone` ● | `{ job, output }` |
| `queue:conflict` ● | `{ job, path }` |
| `queue:recovery` ● | `{ jobs }` |
| `sources:progress` ● | `{ jobId, kind, phase, percent, downloaded, total, speed, eta, message, resumed, resumeBytes, url, videoId, platform }` |
| `subtitles:progress` | `{ cutId, phase, percent, message }` |
| `subtitles:modelProgress` | `{ id, phase, percent, received, total, speedBps, message }` |
| `export:detectProgress` | `{ done, total }` (detector local de layout, 5.4) |
| `analysis:progress` / `analysis:done` / `analysis:failed` | `{ jobId, p, stage, message }` / `{ jobId, result }` / `{ jobId, code, message, details? }` |
| `analysis:transcriptProgress` / `analysis:transcriptDone` / `analysis:transcriptFailed` | `{ jobId, p, doneUntil, message }` / `{ jobId, projectId, status, speed?, deviceNote? }` / `{ jobId, projectId, code, message, resumable?, doneUntil? }` |
| `review:waveformProgress` | `{ sourcePath, p }` |
| `export:progress` | `p` (0..1) — **legado** (exportação mínima da base) |
| `prefs:changed` (só `ctx.bus`) | `{ what, … }` |

### 5.13 Canais IPC (tabela completa; 105 canais registrados)

| Recurso | Canais |
|---|---|
| app / shell / source | `app:info`, `app:refreshTools`, `shell:reveal`, `source:pick`, `source:open` |
| window | `window:minimize`, `window:maximize`, `window:fullscreen`, `window:close`, `window:state` (controles da janela sem moldura; **não existem no módulo embutido do BDS**: `window` fica fora da lista permitida do iframe) |
| project | `project:save`, `project:list`, `project:adopt`, `project:thumbnail` (miniatura do vídeo, cache em `userData/cache/thumbs`), `project:deletePreview` (o que a exclusão apagaria, em números) e `project:delete` (apaga o projeto e os dados dele; com `files:true` também os cortes exportados e o vídeo/chat baixados pelo app; `PROJECT_BUSY` e `PROJECT_DELETING` como recusas) |
| tools | `tools:status`, `tools:install`, `tools:cancel`, `tools:remove` |
| export | `export:pickDir`, `export:listProfiles`, `export:saveProfile`, `export:deleteProfile`, `export:encoders`, `export:framePreview`, `export:sourceFrame`, `export:prepare`, `export:preflight`, `export:layoutRef`, `export:detectLayouts`, `export:detectCancel`; legados: `export:warnings`, `export:run`, `export:cancel` |
| queue | `queue:enqueue`, `queue:list`, `queue:pause`, `queue:resume`, `queue:recover`, `queue:cancel`, `queue:reorder`, `queue:remove`, `queue:retry`, `queue:clearFinished`, `queue:getSettings`, `queue:setSettings`, `queue:resolveConflict` |
| audio | `audio:measure` |
| subtitles | `subtitles:status`, `subtitles:installModel`, `subtitles:cancelModel`, `subtitles:removeModel`, `subtitles:generate`, `subtitles:cancel`, `subtitles:importFile`, `subtitles:hardware` |
| review | `review:waveform`, `review:waveformCancel`, `review:historyLoad`, `review:historyAppend`, `review:historyCopy` |
| analysis | `analysis:defaults`, `analysis:start`, `analysis:cancel`, `analysis:status`; IA na nuvem e transcrição: `analysis:aiState`, `analysis:aiSave`, `analysis:aiTest`, `analysis:aiAccept`, `analysis:aiEstimate`, `analysis:humorExamples`, `analysis:transcriptStatus`, `analysis:transcriptImport`, `analysis:transcriptGenerate`, `analysis:transcriptCancel`, `analysis:transcriptRemove` |
| aiOpenrouter | `aiOpenrouter:models` (lista de seleção: o roteador gratuito primeiro, os gratuitos abaixo; catálogo público, sem chave), `aiOpenrouter:limits` (pedidos gratuitos que restam hoje e quando a chave expira; usa a chave guardada, que nunca volta). Handler `src/ipc/handlers/aiOpenrouter.js`, carregado **antes** de `analysis.js` (publica `ctx.aiOpenrouter`) |
| sources | `sources:state`, `sources:setSettings`, `sources:pickFolder`, `sources:obsDetect`, `sources:obsList`, `sources:probe`, `sources:fetchVod`, `sources:refreshMeta`, `sources:partial`, `sources:discardPartial`, `sources:download`, `sources:chat`, `sources:cancel`, `sources:originFor`, `sources:chatCheck` |
| prefs | `prefs:schema`, `prefs:resolve`, `prefs:get`, `prefs:set`, `prefs:unset`, `prefs:list`, `prefs:names`, `prefs:observe`, `prefs:learned`, `prefs:learnedSet`, `prefs:learning`, `prefs:history`, `prefs:revert`, `prefs:forget`, `prefs:inspect` |

A lista acima foi conferida contra o `ctx.channels` real (criando o `ctx` com um Electron falso e carregando todos os `handlers/*.js`: 12 arquivos, nenhum falhou); o e2e da base confere que `BF.state.loadErrors` fica vazio no app de verdade. Formato de canal: `/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/`; respostas `{ ok:true, … }` ou `{ ok:false, code, message, details? }` com mensagem em português (causa e solução).

### 5.14 Ambiente, scripts e testes

**Scripts do `package.json`**

| Comando | O que faz |
|---|---|
| `npm start` | abre o app (`electron .`) |
| `npm test` | `node --test --test-concurrency=2 "tests/**/*.test.js"`: unitários e integração com ffmpeg real (de 6 a 8 minutos nesta máquina). Rede real e desempenho longo ficam **desligados** (abaixo); o único teste que baixa algo (Whisper, ~40 MB) pula com `BF_SKIP_NETWORK_TESTS=1` |
| `npm run test:e2e` | `scripts/run-e2e.js`: roda `tests/e2e/*.e2e.js` (menos `helpers.js`) em sequência, com resumo e tempo por arquivo; código de saída ≠ 0 se algum falhar. Filtros: `npm run test:e2e -- export queue` (nome exato ou trecho); `--list`; `--bail`; `BF_E2E_PARALLEL=n` (n ao mesmo tempo, saída guardada e impressa por arquivo); `BF_E2E_TIMEOUT_MS` (prazo por arquivo, padrão 15 min) |
| `npm run test:network` | `scripts/run-network-tests.js`: liga `BF_NETWORK_TESTS=1` e roda `tests/sources-network.test.js`, `tests/subtitles-whisper.test.js` e `tests/ai-openrouter-network.test.js` (releases do GitHub, yt-dlp real, "Me at the zoo", motor e modelo do Whisper, catálogo público do OpenRouter). Os testes de rede real **com chave** (`tests/ai-real-network.test.js` e `tests/ai-openrouter-real.test.js`) ficam fora: só rodam com `BF_AI_TEST_KEY` (abaixo) |
| `npm run test:perf` | `scripts/run-perf-tests.js`: liga `BF_PERF_TESTS=1` e roda `tests/analysis-perf.test.js` (inclui o vídeo de 20 minutos) |
| `npm run lint` | `eslint . --ignore-pattern ".tmp/**"` |

Sem `cross-env`: quem precisa de variável de ambiente usa um script de `scripts/` (Windows e Linux iguais). `--test-concurrency=2` existe porque a análise roda com prioridade abaixo do normal e, com muitos arquivos de teste ao mesmo tempo, os prazos estouravam por lentidão e não por defeito.

**Variáveis de ambiente**

| Variável | Quem lê | Efeito |
|---|---|---|
| `CORTE_FFMPEG`, `CORTE_FFPROBE` | base (`resolveTools`) | caminho do ffmpeg/ffprobe (antes do PATH) |
| `CORTE_YTDLP`, `CORTE_WHISPER`, `CORTE_TWITCHDOWNLOADER` | base | caminho da ferramenta (depois da instalada pelo app, antes do PATH) |
| `CORTE_DENO` | sources | caminho do Deno do sistema (só para o aviso/uso no yt-dlp) |
| `BF_TEST_TOOL_ENTRIES` | `tools/catalog.js` | entradas de ferramenta de TESTE (só com `NODE_ENV=test`, app não empacotado, URLs de loopback) |
| `BF_TEST_QUEUE_RUNNER` | `handlers/queue.js` | executor de teste da fila (só com `NODE_ENV=test` e app não empacotado) |
| `BF_E2E_SHOTDIR`, `BF_E2E_SHOT` | e2e | pasta de capturas da janela / arquivo da captura final do `app.e2e` |
| `BF_E2E_OFFLINE=1` | `sources.e2e` | pula a parte de rede real |
| `BF_E2E_PARALLEL`, `BF_E2E_TIMEOUT_MS`, `BF_E2E_RETRIES` | `scripts/run-e2e.js` | paralelismo, prazo por arquivo e repetições (0 a 3, padrão 0; quem só passa na repetição aparece como **instável** no resumo) |
| `BF_NETWORK_TESTS=1` | `sources-network.test.js` | liga os testes de rede real (o `npm run test:network` já liga) |
| `BF_NETWORK_TOOLS_ALL=1` | `sources-network.test.js` | também instala TwitchDownloaderCLI (52 MB) e Deno (42 MB) |
| `BF_SKIP_NETWORK_TESTS=1` | `subtitles-whisper.test.js` | pula o teste que baixa o Whisper (~40 MB) sem tentar a rede |
| `BF_REQUIRE_NETWORK=1` | `subtitles-whisper.test.js` | sem internet o teste FALHA (em vez de pular) |
| `BF_SUBTITLES_TEST_CACHE=<pasta>` | `subtitles-whisper.test.js` | reaproveita motor/modelo já instalados (só desenvolvimento) |
| `BF_PERF_TESTS=1` | `analysis-perf.test.js` | liga a versão longa (20 min); sem ela roda só a de 3 min |
| `BF_AI_TEST_KEY`, `BF_AI_TEST_URL`, `BF_AI_TEST_MODEL` | `ai-real-network.test.js`, `ai-openrouter-real.test.js` | **opt-in**: chave, endereço e modelo de um provedor de verdade (sem `BF_AI_TEST_KEY` os dois PULAM). O do OpenRouter só aceita `openrouter.ai` (ou um servidor da própria máquina), usa dados sintéticos e faz no máximo 8 pedidos de conversa (a cota gratuita é de 50 por dia) |
| `BF_OPENROUTER_BASE_URL` | `handlers/aiOpenrouter.js` | **só testes**: aponta o serviço do OpenRouter para um servidor local; ignorada no app empacotado |
| `BF_VIDEOS_DIR` | `handlers/sources.js` | caminho absoluto que troca a pasta Vídeos do download de VODs; os e2e a apontam para uma pasta temporária, para nunca tocar nos vídeos do usuário |

**Convenções de teste.** Pastas temporárias sempre `bf-…` em `%TEMP%`, removidas no `finally`; nenhum teste deixa `.part` nem processo filho; e2e usam `launchApp` (porta de depuração dinâmica + perfil temporário) e terminam com `h.cleanupAll()`. Esperas são por **condição** (`waitFor`), com prazo generoso, nunca por tempo fixo curto: a análise roda com prioridade abaixo do normal e, com o computador saturado, ficou até ~240× mais lenta que em repouso (a mesma análise de 20 min de vídeo levou 550 s sob carga e 2,3 s em repouso), então prazos curtos viram falhas falsas. Pedido a quem escrever testes novos: contar **leituras/eventos** (ou esperar uma condição) em vez de "ler durante N ms". `launchApp` repete a leitura do `DevToolsActivePort` quando o arquivo está transitoriamente ocupado (EBUSY/EPERM).

### 5.15 Contradições resolvidas e pendências

**Resolvidas nesta consolidação** (o texto antigo continua nas seções 1 a 4 só quando ainda era verdadeiro; o que divergia foi corrigido lá e aqui):

- `BF.prefs`: o arquivo é `features/prefs.js` (não `preferences.js`) e a API completa está em 5.11.
- 3.3: `buildAudioFilter(audio)` → `buildAudioFilter(audio, { duration, offset? })` + `resolveAudio`; `prepareBurnIn` é síncrono, devolve `warnings` e `vfFilter` pode ser `null`; `runExportJob` devolve `skipped`, `encoder` e `sizeBytes`; seis códigos de erro novos (5.4).
- 3.4: o estado `paused` não existe por trabalho; `queue:recover`, `pause {interrupt?}`, `enqueue {force?}` e os campos novos de `queue:update` entraram (5.5).
- 3.6: `readChat`/`writeChat` são assíncronos (+`Sync`); `messagesPerWindow` aceita `durationSec` e devolve `number[]` (5.10).
- 5.1 (antigo "Resolução de ferramentas"): whisper e twitchDownloader não são mais `null`; vale instalada pelo app > `CORTE_*` > PATH (5.2).
- `export:warnings|run|cancel`: eram a exportação mínima da base; viraram canais legados, sem uso na interface (5.4).
- `project.history` (campo reservado): **não é usado**; o histórico da revisão vive em `userData/history/<projectId>.json` (5.8).
- `decision` `adjust` tem três formas (tempo do corte, áudio com `scope:'audio'`, legendas com `before.what === 'subtitles'`) e o consumidor precisa distinguir (5.12).
- docs/recursos/tools.md ("Problema conhecido: o painel lateral só aparece com vídeo"): resolvido pela base; o painel de abas aparece sempre e Início, Projetos, Novo projeto, Exportações, Preferências e Ferramentas funcionam sem projeto (5.1; conferido no `app.e2e`).
- `tests/e2e/app.e2e.js` usava a aba Exportar mínima (`#btnExport`, `#resolution`…) e a exportação direta; foi reescrito para o fluxo real (aba Exportar → Adicionar à fila → aba Fila → arquivo conferido com ffprobe) e agora também responde ao aviso "A fonte mudou desde a última análise" ao abrir um projeto v1 antigo.
- `tests/e2e/tools.e2e.js` esperava exatamente duas linhas de ferramentas quando o registro estava vazio; com as quatro entradas oficiais (`deno`, `twitchdownloader`, `whisper`, `ytdlp`) a verificação ficou **mais forte**: exige exatamente esses ids, origem oficial, ausência do selo de teste e que as entradas de teste só substituam `whisper` e `twitchdownloader`.

**Pendentes (nenhuma bloqueia o uso):**

- **`analysis.sensitivity`**: a chave ainda não existe no catálogo de preferências (`src/core/preferences/keys.js`) e a aba Análise não a lê (a sensibilidade é um controle por projeto, padrão 3). Dono: prefs + analysis.
- **`deno` no `ctx.tools`** (`TOOL_KEY_BY_ID`, `CORTE_DENO` no `resolveTools`): hoje o `sources` resolve o Deno sozinho (5.2). Dono: base.
- ~~**Faixas de duração**~~ (resolvida): as chaves `analysis.minDurationSec`/`maxDurationSec` agora aceitam as faixas da análise (3 a 120 e 5 a 180; `keys.js` as lê de `RANGES`, e `tests/prefs-keys.test.js` confere que continuam iguais).
- **Bitrate de projetos v1**: o bitrate do perfil legado (`project.profile.bitrateKbps`) é preservado no arquivo, mas a aba Exportar nova usa o perfil derivado (`profileId`) com o bitrate dele (ex.: v1 2160p H.265 com 30 Mbps abre como `vertical-2160-h265` a 10 Mbps). Decisão da base; a confirmar.
- **`source:probe { path }`** (ffprobe sem abrir) evitaria a medição dupla do `prefs:inspect`; e "abrir sem atualizar a fonte" não existe (recusar a comparação = não abrir). Dono: base.
- **Plataformas**: só Windows foi executado; o código de Linux/macOS existe e não foi testado.
- **Análise**: critérios provisórios, calibrados só com mídia sintética (`docs/recursos/analysis.md`; decisões a confirmar com a Liz em `docs/requisitos-e-etapas.md`, seção 3).
