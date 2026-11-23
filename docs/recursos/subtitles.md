# Legendas (recurso `subtitles`)

Contratos de referência: [`arquitetura.md`](../arquitetura.md) (2.2 corte, 3.3 job de exportação, 3.7 ferramentas). Este documento descreve o que o recurso faz, onde fica cada coisa, as decisões provisórias, os limites e os **pedidos de contrato**.

## O que faz

- **Legenda automática opcional, por corte.** Só o trecho do corte é processado: o ffmpeg extrai o áudio (WAV 16 kHz mono) e o `whisper-cli` (whisper.cpp, release oficial) transcreve. Idioma padrão **português**, selecionável (10 idiomas e "detectar automaticamente"); modelo selecionável, padrão **Pequeno**. Progresso real (áudio, silêncio, modelo, transcrição em %) e cancelamento.
- **Nunca inventa fala.** Sem faixa de áudio, em silêncio ou só com ruído/música o resultado é "nenhuma fala detectada", sem erro e sem falas (veja "Regras para não inventar fala").
- **Revisão do texto** numa lista editável: texto, início e fim de cada fala; dividir (no cursor do texto ou no ponto do player), juntar com a seguinte, excluir, adicionar (no ponto do player); **Desfazer** (30 passos por corte, só nesta sessão); marca ⚠ "revisar" nas falas de baixa confiança.
- **Sincronia:** deslocar tudo −1 s, −0,1 s, +0,1 s, +1 s (grosso e fino) e ajuste individual de início/fim por fala.
- **Intervalo do corte mudou?** As falas acompanham (deslocadas), as afetadas são marcadas para revisão e **nada é descartado nem recortado de forma permanente**: aparar o corte e desfazer devolve as falas com os tempos exatos (seção "Intervalo do corte").
- **Aparência:** fonte (só as que existem no computador), tamanho, cor, contorno (cor e espessura), fundo (nenhum, sombra ou caixa, com cor e opacidade), posição (inferior, centro, superior), negrito e máximo de caracteres por linha. **Prévia real sobre o player** (texto HTML sincronizado com o tempo do vídeo) e **a mesma aparência aplicada na exportação**.
- **Entrega:** incorporada ao vídeo (ASS pelo filtro `subtitles` do libass, sobre o quadro já enquadrado) e/ou arquivo separado SRT ou ASS ao lado do vídeo. Sem libass no FFmpeg a aba diz o motivo e a solução, e a opção incorporada fica desabilitada.
- **Extras:** usar uma legenda existente (`.srt`/`.ass` do vídeo inteiro: entram só as falas que caem no corte), aplicar a mesma aparência a todos os cortes (ou aos próximos vídeos), remover modelos baixados.

## Onde fica cada coisa

| Arquivo | Papel |
|---|---|
| `src/core/subtitles/shared.js` | Lógica pura **universal** (CommonJS no main e `window.BFSubtitles` no renderer): estilo, operações sobre as falas, quebra de linhas, `rebaseSubtitles`, `visibleCues`, `importCuesForCut` |
| `src/core/subtitles/formats.js` | Gerar e ler SRT e ASS (`cuesToSrt/Ass`, `parseSrt/Ass`, cores, escape de `{ } \`) |
| `src/core/subtitles/burnIn.js` | **`prepareBurnIn(cut, { tmpDir, width, height })`** (contrato 3.3), `detectBurnInSupport`, escape do filtro, avisos |
| `src/core/subtitles/generate.js` | Geração de um corte: extrair áudio, silêncio, whisper, regras anti-alucinação, falas |
| `src/core/subtitles/silence.js` | `silencedetect`, corte do silêncio no WAV, mapa de tempo (adaptado do `silenceTrim.js` do BDS) |
| `src/core/subtitles/hallucinations.js` | Anotações, frases decoradas, repetição, confiança |
| `src/core/subtitles/whisperOutput.js`, `cueBuilder.js` | JSON do `whisper-cli -ojf` e agrupamento de palavras em falas (adaptados do BDS), com a confiança por palavra |
| `src/core/subtitles/models.js` | Catálogo de modelos e `ModelManager` (instala pelo `ToolInstaller`) |
| `src/core/subtitles/fonts.js`, `proc.js`, `errors.js` | Fontes que existem no Windows, execução de processos com cancelamento, `SubtitlesError` |
| `src/core/tools/entries/whisper.js` | Entrada oficial do motor (id `whisper`; alimenta `ctx.tools.whisper`) |
| `src/ipc/handlers/subtitles.js` | Canais `subtitles:*` |
| `renderer/features/subtitles.js` / `.css` | Aba **Legendas** (ordem 40) e a prévia sobre o player |
| `tests/subtitles-*.test.js`, `tests/subtitles-helpers.js`, `tests/e2e/subtitles.e2e.js`, `tests/e2e/subtitles-ui.e2e.js` | Testes |

## Dados: `cut.subtitles` (contrato 2.2, com os detalhes escolhidos)

```js
cut.subtitles = {
  enabled: true,                       // aplicar na exportação
  basedOn: { start, end, revision },   // intervalo do corte para o qual as falas valem
  cues: [{ start, end, text, needsReview? }],
  style: { fontFamily, fontSize, bold, color, outlineColor, outlineWidth,
           background: 'none'|'shadow'|'box', backgroundColor, backgroundOpacity,
           position: 'bottom'|'center'|'top', maxCharsPerLine },
  mode: 'burn' | 'sidecar' | 'both',   // incorporada | arquivo separado | os dois
  sidecarFormat: 'srt' | 'ass',        // extra: formato do arquivo separado
  generated?: { at, language, model, modelLabel, start, end, noSpeech }  // extra: da última geração automática (start/end = tempo da ORIGEM)
}
```

- **Tempos das falas são em segundos RELATIVOS AO INÍCIO DO CORTE** (0 = `cut.start`), os mesmos do vídeo exportado. É o que `prepareBurnIn`, o SRT/ASS e a prévia usam. *(Decisão provisória; veja "Pedidos de contrato".)*
- `needsReview` (contrato) marca fala de baixa confiança ou afetada por mudança do corte. Editar o texto ou os tempos, ou clicar no ⚠, marca como revisada. As falas marcadas **entram** na exportação (`subtitleWarnings` só avisa; nada bloqueia).
- `mode` aceita também `srt`, `ass`, `burn+srt`, `burn+ass` na leitura (normalizados em `shared.normalizeMode`).
- O estilo é guardado **no corte** (a exportação só recebe o corte): ao criar a legenda de um corte vale o último estilo usado no projeto (`project.ext.subtitles.style`), depois `BF.prefs.get('subtitles.style')`, depois o padrão. "Usar esta aparência em todos os cortes" copia o estilo.
- Escolhas do projeto em `project.ext.subtitles` (`language`, `modelId`, `mode`, `sidecarFormat`, `style`). Idioma e modelo também ficam lembrados neste computador (`localStorage`, só conveniência).
- Tamanhos do estilo (`fontSize`, `outlineWidth`) são em **pixels de um quadro de referência de 1080 px de lado menor** e valem proporcionalmente na saída (1080x1920 → 1×; 1440x2560 → 1,33×; 2160x3840 → 2×; horizontal 1920x1080 → 1×). A margem vertical é percentual da altura (vertical: inferior 14%, superior 9%, para ficar fora dos botões do Shorts; horizontal: 7% e 6%).

## Geração automática

1. **Áudio:** `ffmpeg -ss <início> -i <vídeo> -t <duração> -map 0:a:0 … pcm_s16le 16 kHz mono` numa pasta de trabalho em `<userData>/cache/subtitles/sub-*` (apagada sempre, inclusive ao cancelar). Usa a **primeira faixa de áudio**. Sem faixa → "este trecho do vídeo não tem áudio" (resultado, não erro).
2. **Silêncio:** `silencedetect` (−50 dB, 1 s, folga de 0,3 s: limiares conservadores, fala baixa nunca é silêncio). Áudio todo em silêncio → "nenhuma fala detectada" **sem chamar o whisper**. Silêncio que dê ao menos 1,5 s (e 15%) sai do WAV antes da transcrição e os tempos voltam ao original depois.
3. **Whisper:** `-bs 1 -bo 1 -mc 0 -nth 0.6 -lpt -1.0 -et 2.4 -dtw <modelo> -nfa -ojf` (configuração validada no BDS; `-nth/-lpt/-et` são os limiares de sem-fala e de decodificação ruim do próprio whisper.cpp, explícitos de propósito), threads = metade dos núcleos. **Não usa `-sns`**: com ruído ele forçava texto inventado ("gression no mio") em vez da anotação `[Música]`. O `whisper-cli.exe` não aceita acentos nos argumentos: roda com a pasta de trabalho como diretório atual e só recebe nomes relativos em ASCII (se o caminho do modelo não for ASCII, usa atalho/cópia na pasta de trabalho).
4. **Regras para não inventar fala** (`hallucinations.js`), trecho a trecho:
   - descartado **com o motivo registrado** (a aba mostra "Ver o que foi descartado"): anotação de áudio (`[Música]`, `(risos)`, `[BLANK_AUDIO]`, `♪`), crédito de legenda decorado (`amara.org`, `Legendas pela comunidade…`), frase comum de alucinação ("Obrigado.", "Tchau", "Thanks for watching", "Inscreva-se no canal") **só** em trecho sem fala ou com confiança < 0,6, trecho dentro de silêncio detectado, repetição em laço (3 ou mais iguais seguidos; fica a primeira, marcada), confiança < 0,28;
   - **mantido e marcado `needsReview`** (nunca escondido): confiança entre 0,28 e 0,55.
5. **Falas:** palavras com tempo por DTW agrupadas pelas regras do BDS (pausa > 1 s, fim de frase, máx. 6 s, caracteres por linha do estilo, evita terminar em "de", "o", "que"…).

Resultado de `subtitles:generate`: `{ cues, noSpeech, reason: 'no-audio'|'silence'|'no-speech'|null, message, discarded:[{start,end,text,reason}], language, durationSec, speechSec, trimmedSec, device:'GPU'|'CPU', deviceName, deviceLabel, fellBack, fallbackReason, deviceNote, memoryAdvice, transcribeMs, audioSec, speed, elapsedMs, modelId, modelLabel }`. `speed` = segundos de áudio transcritos por segundo de relógio (inclui carregar o modelo); `deviceNote` explica por que a placa não foi usada quando o usuário precisa saber (placa falhou antes, modelo não cabe, motor da placa não instalado).

## Transcrição pela placa de vídeo (GPU NVIDIA)

- **Detecção** (`src/core/subtitles/gpu.js`): roda o `nvidia-smi` de verdade (`--query-gpu=name,memory.total,driver_version`, prazo de 4 s, sem janela), com cache (10 min se achou a placa, 1 min se não) e uma consulta por vez. Sem `nvidia-smi` (sem driver), no Windows só confirma pelo sistema que existe uma placa NVIDIA e diz que falta o driver. Driver antigo (< 527) = placa não utilizável, com o motivo. Várias placas: a de mais memória. Nunca lança: qualquer falha vira "sem placa" com o motivo. Exposta em `subtitles:hardware` e em `subtitles:status.hardware`.
- **Motor CUDA**: entrada `src/core/tools/entries/whisper-cuda.js` (id `whisper-cuda`), release **oficial** `b5130` do whisper.cpp, o **mesmo pacote que o BDS usa**: `whisper-cublas-12.4.0-bin-x64.zip`, **674 539 285 bytes**, SHA-256 `af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7` (conferidos no campo `digest` da API oficial `GET /repos/ggml-org/whisper.cpp/releases/tags/b5130` e no índice do zip, lido do fim do arquivo sem baixar tudo: tudo dentro de `Release/`, com `whisper-cli.exe`, `ggml-cuda.dll`, cublas/cudart/nvrtc e as DLLs de CPU). Só Windows x64 (não existe pacote CUDA oficial para Linux/macOS). **É grande** (~643 MB, bem mais depois de extraído): só é baixado quando o usuário pede (cartão **Transcrição** da aba Ferramentas ou, com um corte escolhido, aba Legendas > Motor de transcrição), com confirmação que mostra o tamanho, barra de progresso e Cancelar do `ToolInstaller`. Só é oferecido se a placa NVIDIA foi detectada. Não alimenta `ctx.tools.whisper` (que continua sendo o motor de CPU).
- **Tipo do motor** (`engineKindOf`): é CUDA se a pasta do executável tem `ggml-cuda.dll` (`libggml-cuda.so`); vale para o motor instalado aqui, o do sistema e o que o hospedeiro fornece. O pacote CUDA traz as DLLs de CPU, então roda sem placa com `-ng`.
- **Escolha** (`planDevice`): `engine: 'auto'` (padrão) | `'gpu'` | `'cpu'` em `subtitles:generate` (guardado em `project.ext.subtitles.engine`). Automático: placa se há NVIDIA utilizável **e** motor CUDA, o modelo cabe na memória da placa e ela não falhou antes com esse motor/modelo; senão processador. `gpu` tenta a placa mesmo assim (inclusive depois de uma falha lembrada); `cpu` roda o motor CUDA com `-ng` (ou o motor de CPU, se houver).
- **Fallback**: se a placa falha (programa sai com erro: driver, memória, erro do CUDA), a geração é repetida no processador (motor de CPU se houver, senão o mesmo com `-ng`), o resultado traz `fellBack: true` + `fallbackReason`, a interface avisa "A placa falhou: usando o processador" e a falha é lembrada (`GpuFailureMemory`, por motor + modelo): o automático não insiste; "Placa (GPU)" tenta de novo. Cancelar nunca repete; erro do processador não é mascarado.
- **Memória (4 GB)**: estimativa = arquivo do modelo x 1,15 + 0,5 GB. Mais de 92% da memória = "provavelmente não cabe" (o automático vai direto ao processador e avisa); mais de 75% = "usa quase toda a memória" (tenta a placa, o fallback cobre). Na GTX 1650 (4 GB) todos os modelos do catálogo cabem, inclusive o Large v3 Turbo q5_0 (574 MB); um modelo completo grande (ex.: `ggml-large-v3.bin`, 3,1 GB) não caberia.
- **Módulo embutido**: o `whisper-cli` do BDS (CUDA se ele tem a aceleração NVIDIA instalada, senão o de CPU; `frameModule.js`) chega por `options.tools.whisper`; o Braga Frame descobre o tipo pela pasta, usa com a mesma lógica (automático + fallback) e **não baixa motor próprio** (`whisper-cuda` some da aba Ferramentas e `tools:install` dele dá `HOST_PROVIDED`). A aba mostra "motor do BDS · GPU" ou "· CPU".
- **Medido neste computador** (GTX 1650 4 GB, driver 617.42, 8 núcleos lógicos, Large v3 Turbo q5_0, 24,9 s de áudio de fala sintetizada, `tests/subtitles-gpu-real.test.js`): **GPU 7,0 s (3,6x o tempo real; 8,9 s = 2,8x na primeira vez, com o CUDA iniciando) x CPU 55,1 s (0,5x)**: a placa foi ~7,9x mais rápida; a memória da placa foi de 509 para 1636 MB só no modo placa. Com o Tiny (mesmo áudio): GPU 11 a 14x o tempo real, CPU ~8x (ganho pequeno: modelos pequenos já são rápidos no processador). A primeira geração depois de abrir o app pode demorar mais por causa do início do CUDA.
- **Não verificado**: falha real do CUDA (memória esgotada de verdade, driver quebrado) com a placa: o fallback foi provado com motor simulado e com um programa que sai com erro de verdade, mas não forçamos um erro do CUDA; placas AMD/Intel (não há suporte: usam o processador); Linux/macOS.

## Intervalo do corte (`rebaseSubtitles`)

Quando `cut.start/end` diferem de `subtitles.basedOn` (o início, o fim ou a `revision` mudaram):

- o tempo das falas é relativo ao início: se o início mudou, **todas são deslocadas** pela diferença (exato, não é sinalizado);
- fala **parcialmente fora** do novo intervalo **não é recortada no que fica guardado**: mantém o tempo deslocado (pode começar antes de 0 ou terminar depois da duração; a lista mostra "parte fora"), marcada `needsReview`. Quem mostra ou exporta recorta (`visibleCues`, `rangeState`), então só a parte de dentro aparece no player e no vídeo. Por isso **aparar o corte e desfazer (Ctrl+Z na aba Cortes) devolve as falas com os tempos exatos de antes** (antes, o recorte era permanente e o Ctrl+Z não devolvia nada);
- fala **totalmente fora** **não é apagada**: fica com o tempo deslocado (fora de `0..duração`, a lista mostra "fora do corte"), marcada `needsReview`, não aparece nem é exportada, e **volta sozinha** se o corte voltar a cobri-la;
- a marca `needsReview` (⚠) das afetadas **fica depois de desfazer** até o usuário revisar (um clique no ⚠ ou editar a fala): a marca não diz de onde veio e pode ser de baixa confiança, então não é tirada sozinha;
- só a `revision` mudou: atualiza `basedOn`;
- `generated.start/end` guardam o intervalo da origem que foi transcrito: se o corte ganhou trecho depois da geração, a aba avisa "trecho sem transcrição" (aviso, não bloqueia).

A aba reconcilia ao abrir o projeto, em `cuts:changed` (de outros recursos) e ao mostrar a aba, e grava pelo `BF.project.update`. **`prepareBurnIn` aplica a mesma regra em memória**: mesmo que o usuário exporte sem abrir a aba, as falas saem alinhadas.

## Exportação (`prepareBurnIn`)

`prepareBurnIn(cut, { tmpDir, width, height, ffmpegPath?, support?, fontsDir? })` → `null | { vfFilter, sidecars:[{ path, ext }], warnings:[string] }`. É **síncrono** (o jobRunner pode chamar com ou sem `await`).

- `null`: legenda desligada, sem falas ou nenhuma fala visível no corte. **Ligada e sem nenhuma fala visível não é silêncio:** `subtitleWarnings` devolve o aviso `EMPTY_WARNING` ("A legenda está ligada, mas nenhuma fala aparece neste corte: o vídeo sai sem legenda…"), o `qc.preflight` o mostra como `SUBTITLES_WARNING` (aviso, não bloqueia) e, quando `prepareBurnIn` devolve `null`, o `jobRunner` repassa os `subtitleWarnings` do corte no resultado do job (a Fila mostra).
- `vfFilter`: `subtitles=filename=<ASS escapado>[:fontsdir=<fontes do Windows>]`, a ser acrescentado **depois** do enquadramento (o `buildVideoGraph` do exportEngine já faz isso). `null` quando a entrega é só arquivo separado. O ASS é gravado em `tmpDir` com `PlayResX/Y` = tamanho do quadro de saída (1 unidade = 1 pixel), então a fonte acompanha a resolução.
- `sidecars`: `legenda-arquivo.srt|ass` em `tmpDir`; o jobRunner copia para `<nome do vídeo>.<ext>` sem sobrescrever (já faz).
- Escape do caminho: os dois níveis do FFmpeg (opção do filtro e descrição do grafo) com `/` no lugar de `\`; testado com espaço, vírgula, aspas, colchetes, `;`, acentos, `#`, `%`, `&`, `=`, `` ` `` e `$` na pasta temporária, dentro de `-filter_complex` como o exportEngine monta.
- Lança `SubtitlesError('BURNIN_UNSUPPORTED')` (mensagem com causa e solução) se a entrega pede legenda incorporada e o FFmpeg não tem o filtro `subtitles` (libass); `INVALID_SIZE` e `NO_TMPDIR` para uso incorreto. Entrega só em arquivo separado nunca depende do libass.
- `subtitleWarnings(cut)` (também exportada) devolve os avisos: legenda ligada sem falas visíveis, falas para revisar, falas fora do corte e fonte que não existe no computador. Não bloqueiam.
- **Linhas em branco no texto da fala** (Enter duas vezes): no vídeo (ASS, `\N\N`) e no `.ass` separado a linha em branco fica; no **`.srt` separado** ela é removida (`formats.srtText`), porque uma linha vazia encerra o bloco do SRT e o resto da fala ficaria sem tempo (os players o ignoram). O texto da fala, no projeto, não é alterado.

## Motor e modelos (fontes oficiais)

**Motor:** `src/core/tools/entries/whisper.js` (id `whisper`), release **oficial** `b5130` de https://github.com/ggml-org/whisper.cpp (tags `bNNNN`; as `vX.Y.Z` não trazem binários), a mesma validada no BDS. Valores conferidos na API oficial (`GET /repos/ggml-org/whisper.cpp/releases`, campo `digest`) **e** baixando os pacotes:

| Pacote | Tamanho | SHA-256 | Situação |
|---|---|---|---|
| `whisper-bin-x64.zip` (Windows x64) | 8 573 270 | `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c` | instalado e executado nos testes |
| `whisper-bin-win-cpu-arm64.zip` | 4 361 895 | `799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc` | hash e conteúdo conferidos, **não executado** |
| `whisper-bin-ubuntu-x64.tar.gz` | 9 793 438 | `53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32` | hash e conteúdo conferidos, **não executado** |
| `whisper-bin-ubuntu-arm64.tar.gz` | 4 605 905 | `93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6` | hash e conteúdo conferidos, **não executado** |

Todos trazem uma pasta única na raiz (`Release/` ou `whisper-bin-ubuntu-<arq>/`): `stripComponents: 1`. macOS: a release só traz um xcframework (sem `whisper-cli`): a interface mostra "indisponível neste sistema". O pacote CUDA oficial (675 MB) é a entrada separada `whisper-cuda` (veja "Transcrição pela placa de vídeo"). Existem builds mais novos (`b5454`, pré-lançamento de 2026-10-06); a versão só deve mudar trocando versão, URL, tamanho e SHA-256 juntos e rodando `node --test tests/subtitles-ipc.test.js tests/tools-registry.test.js` mais o teste real.

**Modelos:** repositório oficial `ggerganov/whisper.cpp` no Hugging Face, versões quantizadas (q5): Tiny (31 MB), Base (57 MB), **Pequeno** (181 MB, padrão), Médio (514 MB) e Large v3 Turbo (548 MB). Como o motor, **cada modelo tem revisão, tamanho e SHA-256 FIXADOS no código** (`src/core/subtitles/models.js`); o app não consulta a API da fonte para saber hash nenhum. O `ModelManager` monta a entrada a partir do catálogo e usa o `ToolInstaller` (download em `.part`, tamanho + SHA-256 conferidos contra o catálogo, publicação atômica, progresso, cancelamento): um arquivo trocado no repositório, ou no caminho, é recusado com `CHECKSUM_MISMATCH`. A URL do download traz a **revisão** fixada (`resolve/<revisão>/<arquivo>`). `installed()` só aceita o modelo instalado a partir do SHA-256 que o catálogo fixa hoje; um modelo de outro hash (versão antiga do app) deixa de valer e a instalação seguinte o troca (só fica uma versão por modelo). Pasta: `<userData>/models/whisper-<id>/r<revisão>/<arquivo>.bin`.

| Modelo | Arquivo | Tamanho | SHA-256 |
|---|---|---|---|
| Tiny | `ggml-tiny-q5_1.bin` | 32 152 673 | `818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7` |
| Base | `ggml-base-q5_1.bin` | 59 707 625 | `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898` |
| Pequeno | `ggml-small-q5_1.bin` | 190 085 487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` |
| Médio | `ggml-medium-q5_0.bin` | 539 212 467 | `19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f` |
| Large v3 Turbo | `ggml-large-v3-turbo-q5_0.bin` | 574 041 195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |

Revisão do repositório: `5359861c739e955e79d9a303bcbc70fb988958b1` (último commit em 2024-10-29, licença MIT). Valores lidos da API oficial (`GET /api/models/ggerganov/whisper.cpp?blobs=true`, campos `sha`, `size` e `lfs.sha256`) em 2026-10-21; o download real do **Tiny** foi conferido pelo teste `tests/subtitles-whisper.test.js` (instala pelas rotas do app, com o SHA-256 fixado). Os outros quatro modelos têm tamanho e hash conferidos só na API da fonte (**não foram baixados**). Para atualizar um modelo: troque `revision`, `sizeBytes` e `sha256` **juntos**, rode `node --test tests/subtitles-models.test.js` e o teste real.

## IPC

| Canal | Payload | Resposta |
|---|---|---|
| `subtitles:hardware` | `{ refresh? }` | `{ gpu:{available,name,memoryMb,driver,driverOk,source,reason,summary}, engineKind:'cuda'\|'cpu'\|null, canUseGpu, gpuFailure }` |
| `subtitles:status` | — | `{ engine:{installed,path,origin,kind:'cuda'\|'cpu',version,sizeBytes,available,unavailableReason,source,cuda:{available,installed,path,sizeBytes,version,managedByHost,unavailableReason}}, hardware, ffmpeg:{found}, models:[{id,label,description,sizeBytes,installed,installedSizeBytes,busy,recommended,gpuFit:{level,message}}], defaultModel, languages, fonts:[{name,available}], burnIn:{supported,reason}, generating:[cutId], limits }` |
| `subtitles:installModel` | `{ id }` | `{ id, installed, sizeBytes, revision, alreadyInstalled }`; evento `subtitles:modelProgress { id, phase, percent, received, total, speedBps, message }` |
| `subtitles:cancelModel` / `subtitles:removeModel` | `{ id }` | `{ cancelled }` / `{ id, removed }` |
| `subtitles:generate` | `{ cutId, input, start, end, language?, modelId?, maxChars?, engine?: 'auto'\|'gpu'\|'cpu' }` | resultado acima; evento `subtitles:progress { cutId, phase, percent, message }` |
| `subtitles:cancel` | `{ cutId }` | `{ cancelled }` |
| `subtitles:importFile` | `{ defaultDir? }` | `{ canceled }` ou `{ name, format, cues }` (UTF-8, UTF-16 com BOM ou Windows-1252; até 5 MB e 20 000 falas) |

**O canal `subtitles:generate` só lê os campos da tabela.** Qualquer outro campo do pedido (em especial `silence`, os limiares do `silencedetect`, que são um gancho de teste de `generateSubtitles`) é ignorado: o renderer não consegue mexer no `-af` do ffmpeg. Os limiares também são validados em `silence.silenceFilter` (só números: ruído −90..0 dB, duração 0,1..10 s, folga 0..2 s; o resto volta ao padrão).

Códigos de erro (mensagem em português com causa e solução): `NO_FFMPEG`, `NO_ENGINE`, `NO_MODEL`, `UNKNOWN_MODEL`, `INPUT_MISSING`, `INVALID_RANGE` (início ou fim inválido, início negativo, corte curto demais, corte de mais de 30 min e **corte que começa depois do fim do vídeo**, cada um com a sua mensagem), `INVALID_ARGS`, `BUSY` (uma geração por vez), `MODEL_IN_USE`, `CANCELLED`, `ENGINE_FAILED`, os do instalador dos modelos (`CHECKSUM_MISMATCH`, `SIZE_MISMATCH`, `HTTP_xxx`, `NETWORK`, `DISK_SPACE`…), `BAD_FORMAT`, `EMPTY`, `TOO_BIG` (arquivo de mais de 5 MB ou com mais de 20 000 falas).

Importar: o BOM manda (UTF-16 LE/BE, UTF-8 com BOM); sem BOM vale UTF-8 e, se não for válido, Windows-1252. O arquivo vem da internet e é lido no processo principal: as marcas HTML do SRT (`<i>`, `<font ...>`) e os comandos `{...}` do ASS saem em tempo linear (um texto com milhares de `<a` ou `{` soltos, ou de espaços seguidos, não trava o app).

Uso da ferramenta: enquanto uma geração roda o handler registra o uso em `ctx.toolUsage` ("a geração de legendas está rodando"), então a aba Ferramentas não remove nem atualiza o motor no meio. O app fechando (`before-quit`) cancela geração e downloads.

## Interface (aba Legendas)

Corte (seletor; com um corte só ele já vem escolhido) → **o que falta** (motor e modelo, com tamanho e fonte; Instalar/Baixar e Cancelar, barra de progresso real; sem vídeo, sem corte ou sem corte escolhido, o aviso **"Falta instalar a transcrição"** com o botão **Instalar a transcrição**, que leva ao cartão da aba Ferramentas) → "Legendar este corte na exportação" + Entrega → **Gerar legenda automática** (Idioma, Modelo; embaixo, discreta, a linha "GPU NVIDIA GeForce GTX 1650 · 4 GB — a transcrição pode usar a placa" e o ajuste **Motor de transcrição**, recolhido: Automático / Placa (GPU) / Processador (CPU), motor em uso "motor do BDS · GPU", aviso de falha lembrada ou de modelo que não cabe e o botão de baixar o motor da placa com o tamanho) → avisos curtos (**"Transcrito na placa (…) em 7,0 s · 3,6× o tempo real"**, "A placa falhou: usando o processador",  avisos curtos (para revisar, fora do corte, trecho sem transcrição, descartados) → lista de falas (os botões de cada fala aparecem ao passar o mouse ou focar) → Adicionar fala e Sincronia. Recolhidos: **Aparência** e **Mais opções** (formato do arquivo separado, usar legenda existente, aparência para todos os cortes, aparência como padrão dos próximos vídeos, modelos baixados). A **prévia** desenha o texto sobre o player dentro de um quadro de saída (9:16 ou a proporção do perfil do projeto), tracejado enquanto a aba está aberta; com a Aparência aberta e sem fala no ar mostra um exemplo. O texto da prévia **quebra a linha** (`white-space: pre-wrap`) quando passa da largura do quadro menos as margens de 6% (as mesmas do ASS), como o libass faz na exportação: com fonte grande (140) o texto ocupa 4 linhas na prévia e no vídeo, em vez de ser cortado.

**Preferências que a aba lê** (Preferências > Legendas): `subtitles.enabled` é o ponto de partida de "Legendar este corte na exportação" nos cortes que **ainda não têm legenda** (a caixa já aparece marcada; nada é gravado no corte até o usuário mexer; o usuário decide corte a corte); `subtitles.mode` e `subtitles.style` são a entrega e a aparência com que a legenda de um corte nasce. O botão **"Usar esta aparência nos próximos vídeos"** (Mais opções) grava `subtitles.style` (escopo geral); sem ele a preferência de estilo não podia ser definida pela interface. Dentro de um projeto vale o último estilo usado nele (`project.ext.subtitles.style`).

Decisões do usuário viram `decision` tipo **`adjust`** com `before`/`after` do formato `{ what:'subtitles', … }`: `{ action:'shift', seconds }` (sincronia), `{ enabled }`, `{ mode }` e `{ style }`.

## Decisões provisórias

- Tempos das falas relativos ao início do corte (acima).
- Estilo por corte, com "último usado" como padrão dos próximos (acima). **Decisão provisória** (a confirmar com a Liz): `subtitles.enabled` das Preferências é só o ponto de partida da caixa "Legendar este corte na exportação" nos cortes sem legenda (não gera legenda sozinho: gerar exige o motor e leva tempo, então segue explícito por corte; antes a preferência não era lida e a caixa de Preferências não fazia nada). `subtitles.style` ganhou o botão "Usar esta aparência nos próximos vídeos" para poder ser definida.
- **Decisão provisória:** o texto guardado na fala nunca é "limpo" (linhas em branco, espaços); só os formatos de saída adaptam (o `.srt` sem linhas vazias).
- **Decisão provisória:** `maxCharsPerLine` vale em **largura de letra latina**: caractere de largura total (japonês, chinês e hangul) conta 2 (`shared.textWidth`), então 22 = 22 letras latinas ou 11 caracteres japoneses por linha. O hangul entra na conta de largura (o coreano tem espaços e quebra por palavra), mas só japonês e chinês quebram entre caracteres.
- Modelo padrão **Pequeno** (o pedido diz "padrão pequeno"); idioma padrão português.
- Fator `CSS_FONT_FACTOR = 0,89` da prévia (tamanho do ASS → `font-size` do CSS), medido contra o libass com Arial: no e2e a largura do texto da prévia difere do vídeo exportado em ~2% (posição vertical em 0,4%). Outras fontes podem diferir um pouco mais. Com fonte grande (a partir de ~100) o texto passa da largura do quadro e a prévia quebra a linha de forma gulosa (enche a linha e passa para a seguinte), enquanto o libass equilibra as linhas: o número de linhas e a altura do texto batem (medido com tamanho 140: 0,298 do quadro na prévia, 0,280 no vídeo), mas a largura de cada linha pode diferir.
- Limiares de confiança (0,28 descarta; 0,55 marca) calibrados com o modelo tiny. Modelos maiores são mais confiantes; os limiares podem ser ajustados em `hallucinations.js` (`DISCARD_BELOW`, `REVIEW_BELOW`).

## Limites conhecidos

- **Japonês e chinês (oferecidos no seletor): NÃO verificados com o motor real.** O conserto (cada token com ideograma ou kana vira uma palavra, `glue` junta sem espaço, a linha quebra entre caracteres e conta largura 2) foi validado com JSON no formato do whisper.cpp (`-ojf`, bytes UTF-8 soltos, caractere dividido entre tokens), não com uma fala em japonês de verdade: este computador não tem voz japonesa para sintetizar nem corpus. A precisão do tempo por DTW nesses idiomas é a do motor. Coreano, tailandês e outros idiomas sem espaço (além de ja/zh) seguem pela regra antiga.

- **A confiança do modelo não é garantia de acerto.** Em teste com fala muito baixa passada por `loudnorm`, o tiny devolveu texto errado com confiança 0,95. O app não consegue provar que o texto está certo: por isso a revisão humana existe e as falas "para revisar" avisam, mas só as de confiança baixa.
- Fala **muito baixa que passa por AAC** (pico abaixo de ~−25 dBFS no vídeo original) pode virar `[Música]` e resultar em "nenhuma fala detectada": o AAC destrói o sinal antes do app (o mesmo áudio em WAV é reconhecido até a −35 dB). O app não trata isso como silêncio, mas não consegue recuperar a fala.
- **No processador, o modelo padrão não é rápido.** Com placa NVIDIA e o motor CUDA instalado (opcional, 675 MB) a transcrição é bem mais rápida (veja "Transcrição pela placa de vídeo"). Medido neste computador, só com o processador (8 núcleos lógicos, ocupado com outros processos, então os números são só indicativos): **Tiny ≈ 1,3 s para 10 s de áudio**; **Pequeno ≈ 10 a 20 s para 12 s de áudio** (4 threads); com o idioma em "detectar automaticamente" o Pequeno levou ≈ 53 s (detecta o idioma antes de transcrever). Para cortes de Shorts (até 60 s) o Pequeno leva de alguns segundos a mais de um minuto; Tiny e Base são bem mais rápidos, com menos precisão. A barra de progresso mostra o andamento real e dá para cancelar.
- Usa a **primeira faixa de áudio** do vídeo (gravações do OBS com várias faixas: a faixa 1 costuma ser a mistura).
- Corte de até 30 minutos; uma geração por vez.
- A prévia mostra o texto no quadro de saída, **não** o enquadramento do vídeo (isso é do exportEngine); a posição e o tamanho do texto são os da exportação.
- Linux/macOS: o código está escrito mas **não foi executado** (desenvolvimento no Windows); macOS não tem pacote oficial do motor. Fontes: fora do Windows a lista é só por nome (sem checar se existe).
- O ASS usa `\{`, `\}` e `\\` como escapes (aceitos pelo libass); outros programas que leem o ASS separado podem mostrar essas barras.
- `fs.cpSync` do Node 24 no Windows não copia nada, sem erro, quando o destino tem caracteres fora do ASCII (afeta só os testes, que usam `H.copyDir`).

## Serviço do motor para a transcrição do vídeo inteiro

`handlers/subtitles.js` expõe `ctx.transcription` (`prepareRun`, `releaseRun`, `describeRun`, `readiness`) para a aba Análise gerar a transcrição de um vídeo inteiro (src/core/analysis/transcript/): o mesmo motor, o mesmo modelo, a mesma escolha entre placa NVIDIA e processador, o mesmo fallback e a mesma regra de "uma geração por vez" das legendas dos cortes (gerar a legenda de um corte durante a transcrição responde `BUSY`, e o motor/modelo em uso não podem ser removidos). Cada pedaço de 10 minutos passa por `generateSubtitles` (silêncio cortado, anti-alucinação). `subtitles:generate` usa o mesmo `prepareRun`; o comportamento dele não mudou.

## Pedidos de contrato (para `arquitetura.md`)

Quem consolida o contrato deve incorporar:

1. **2.2 (corte):** `subtitles.cues[].start/end` são **relativos ao início do corte**; `subtitles.mode` ∈ `burn | sidecar | both`; campos extras permitidos: `sidecarFormat` (`srt` | `ass`) e `generated` (`{ at, language, model, modelLabel, start, end, noSpeech }`); `style` tem o formato de `shared.DEFAULT_STYLE` (11 campos, validado por `shared.normalizeStyle`).
2. **1.3 (`decision`):** o tipo `adjust` também é emitido por Legendas com `before`/`after` = `{ what:'subtitles', … }` (nunca `start`/`end` do corte); quem consome `adjust` para aprender tempos de corte deve ignorar `what:'subtitles'`.
3. **3.3 (job):** `prepareBurnIn` devolve também `warnings:[string]`, devolve `vfFilter: null` quando a entrega é só arquivo separado, é síncrono e pode lançar `SubtitlesError` (`code` `BURNIN_UNSUPPORTED`, `INVALID_SIZE`, `NO_TMPDIR`). Sugestão ao `qc.preflight` do exportEngine: chamar `subtitleWarnings(cut)` e `detectBurnInSupport(ffmpegPath)` (ambos em `src/core/subtitles/burnIn.js`) para avisar **antes** de enfileirar que a legenda incorporada não é suportada por este FFmpeg (hoje só falha na hora do job, com mensagem clara).
4. **3.5 (prefs):** `subtitles.style` deve seguir `shared.normalizeStyle`; a aba lê `BF.prefs.get('subtitles.style', null)`, `BF.prefs.get('subtitles.mode', 'burn')` e **`BF.prefs.get('subtitles.enabled', false)`** (ponto de partida da caixa "Legendar este corte na exportação" nos cortes sem legenda) e **grava** `subtitles.style` pelo botão "Usar esta aparência nos próximos vídeos" (`BF.prefs.set`, escopo geral). Os textos em `src/core/preferences/keys.js` (dono: prefs; este recurso não os altera) já descrevem isso: "Ligar a legenda nos cortes novos" para `subtitles.enabled` e a dica "Defina na aba Legendas, em Mais opções" para `subtitles.style`.
5. **3.7 (ferramentas):** a entrada `whisper` usa `stripComponents: 1`; os **modelos não entram no registro** (revisão, tamanho e SHA-256 ficam fixados em `src/core/subtitles/models.js`): o cartão **Transcrição** da aba Ferramentas os lista e baixa (`subtitles:installModel`, `cancelModel`, `removeModel`; veja "Instalação da transcrição" abaixo). **Atualização para `arquitetura.md` 5.2 e 5.7:** onde diz que o tamanho e o SHA-256 dos modelos são "lidos da fonte oficial na hora de instalar" / "o hash é lido da fonte na hora de instalar", o correto agora é "fixados no catálogo do código (como o motor)".
6. **Base (`index.html`):** a feature carrega `src/core/subtitles/shared.js` por `<script>` criado dinamicamente (a CSP aceita). Se a base preferir, pode acrescentar `<script src="../src/core/subtitles/shared.js"></script>` antes de `features/subtitles.js`; a feature funciona nos dois casos.
7. **Review (`cuts.js`/timeline):** ao mudar `start`/`end`, incremente `revision` e emita `cuts:changed` (como no contrato); a aba reconcilia as legendas por esses eventos e, na exportação, por `prepareBurnIn` (que confere pelos valores de início/fim, não só pela `revision`).
8. **3.3 (job) e `export/jobRunner.js` (dono: exportEngine, mudança mínima feita aqui):** quando `prepareBurnIn` devolve `null` com a legenda ligada, o `jobRunner` agora repassa `subtitleWarnings(cut)` (código `SUBTITLES_WARNING`) nos `warnings` do resultado do job, para a Fila mostrar que o vídeo saiu sem legenda; `qc.preflight` já mostrava os mesmos textos antes de enfileirar (nenhuma mudança nele). `subtitleWarnings` ganhou o aviso de "ligada, mas sem nenhuma fala visível".
9. **`shared.rebaseSubtitles` (contrato 5.7, "Intervalo do corte"):** a fala parcialmente fora do corte **não é mais recortada** no que fica guardado (só marcada `needsReview`; o recorte é feito por quem mostra ou exporta). Onde `arquitetura.md` 5.7 diz "deslocadas e recortadas", leia "deslocadas e marcadas; o recorte vale só na exibição e na exportação".
10. **Linhas em branco:** `cuesToSrt` remove as linhas vazias do texto (o `.ass` e o vídeo as mantêm). `subtitles:importFile` aceita UTF-16 com BOM e recusa arquivo com mais de 20 000 falas (`TOO_BIG`).

## Legenda do corte a partir da transcrição do vídeo

A transcrição do vídeo inteiro (aba Análise: gerada pelo Whisper ou importada de um .srt/.vtt) fica guardada por projeto. Com ela válida para o arquivo (mesmo caminho, tamanho e duração), a aba Legendas mostra **Usar a transcrição do vídeo** no corte (instantâneo, **sem rodar o Whisper**) e, em Mais opções, **Legendar os cortes com a transcrição do vídeo** (em lote: os cortes aprovados sem legenda; sem nenhum aprovado, todos; quem já tem falas não muda). As falas que caem no corte ficam relativas a ele (`shared.importCuesForCut`, a mesma conta de "usar uma legenda existente"); as das bordas são recortadas e marcadas para revisão. O canal é `subtitles:transcript { projectId, path, size, duration, withCues? }` -> `{ exists, stale?, count?, cues? }` (de outro arquivo: `stale`, sem falas). A transcrição do vídeo só tem o tempo por fala, não por palavra; o Whisper de corte continua valendo para vídeos sem transcrição ou para refazer um corte. Testes: `tests/subtitles-ipc.test.js` e `tests/e2e/subtitles-transcript.e2e.js`.

## Instalação da transcrição (cartão da aba Ferramentas)

Quem começa sem nada não tinha onde instalar: o motor ficava na aba Ferramentas, o modelo só na aba Legendas, e ela exige um vídeo com um corte escolhido. Agora o cartão **Transcrição (legendas automáticas)** da aba Ferramentas (`renderer/features/transcription.js`, `BF.transcription`) instala tudo, sem projeto aberto, no desenho do módulo de transcrição do BDS:

- **Dados**: `subtitles:status` (motor, modelos, placa). O motor ganhou `cuda.fromApp` (o pacote CUDA foi instalado pelo app? só então ele pode removê-lo; um motor CUDA do sistema ou do hospedeiro não é dele). A prontidão (`ctx.transcription.readiness`, usada pela Análise) devolve também `needs: { ffmpeg, engine, model }` (o que falta) e os textos apontam a aba **Ferramentas**.
- **Instalar**: `tools:install { id: 'whisper' }` e `subtitles:installModel { id }`, um depois do outro; progresso em `tools:progress` e `subtitles:modelProgress`; cancelar em `tools:cancel` e `subtitles:cancelModel`. O que falta é calculado por `planOf` (motor, o modelo pedido ou o recomendado quando nenhum está baixado) e a confirmação só fala do que falta.
- **Quem chama**: o cartão da aba Ferramentas, o cartão da transcrição da aba **Análise** ("Instalar a transcrição", com o modelo que o projeto usa) e o aviso da aba **Legendas** sem vídeo, sem corte ou sem corte escolhido. `BF.transcription.install({ modelId })` pergunta, leva à aba Ferramentas e, ao terminar, devolve o usuário à tela de onde saiu (só se ele ainda estiver nas Ferramentas).
- **Teste**: `BF_TEST_MODELS` (catálogo e servidor falsos dos modelos, só e2e; veja `docs/recursos/tools.md`). O e2e `tests/e2e/transcription.e2e.js` percorre o fluxo no app de verdade com o motor e os modelos servidos por HTTP local (nada é baixado da internet).

## Testes

```bash
node --test tests/subtitles-shared.test.js tests/subtitles-formats.test.js tests/subtitles-burnin.test.js tests/subtitles-pipeline.test.js tests/subtitles-generate.test.js tests/subtitles-models.test.js tests/subtitles-ipc.test.js tests/transcription-ui.test.js
node --test tests/subtitles-whisper.test.js      # REAL: instala o motor oficial e o modelo tiny (internet), fala sintetizada pelo Windows
node --test tests/subtitles-gpu.test.js          # GPU sem placa e sem downloads (nvidia-smi falso, motor simulado, servidor local)
node --test tests/subtitles-gpu-real.test.js     # REAL com a placa: motor CUDA e modelo do BDS já instalados (BF_GPU_CUDA_DIR, BF_GPU_MODEL, BF_GPU_SKIP=1)
node tests/e2e/subtitles-gpu.e2e.js              # app Electron real: GPU detectada, motor em uso, resultado na placa e no processador (baixa só o modelo tiny, 32 MB)
node tests/e2e/subtitles.e2e.js                  # app Electron real, fluxo completo; BF_E2E_SHOTDIR=<pasta> guarda capturas
node tests/e2e/subtitles-ui.e2e.js               # app Electron real, SEM motor nem modelo (nada é baixado): preferências, aparar+desfazer, prévia com fonte grande, QC
npx eslint src/core/subtitles src/core/tools/entries/whisper.js src/ipc/handlers/subtitles.js renderer/features/subtitles.js tests/subtitles-*.js tests/e2e/subtitles.e2e.js tests/e2e/subtitles-ui.e2e.js
```

- `subtitles-shared` / `-formats`: estilo, operações sobre falas (dividir, juntar, deslocar, adicionar), rebase em todos os cenários (início mais cedo/tarde, fim mais cedo, ida e volta, só revisão), SRT/ASS (ida e volta, BOM, CRLF, colunas fora de ordem, escapes, proporção por resolução); **legenda importada hostil** (milhares de `<a`, `{`, espaços ou colunas: o parse responde em milissegundos, era de 7 s a minutos), limite de falas, **linha em branco no texto** (ida e volta do `.srt` sem perder o resto); **aparar o corte e desfazer devolve os tempos exatos**; japonês e chinês (largura, quebra entre caracteres, dividir e juntar falas).
- `subtitles-burnin` (ffmpeg real): `null`, erros, modos de entrega, sidecars, **aviso de legenda ligada sem falas** (`subtitleWarnings`, QC e `jobRunner` reais); **quadros com e sem legenda diferem na região esperada em 1080x1920 e 1440x2560** (inferior, centro, superior; antes e depois da fala iguais ao vídeo sem legenda; tamanho do texto 1,33×); cor, caixa de fundo e fonte; caminhos difíceis do Windows; **integração com o `jobRunner` real do exportEngine** (legenda queimada e `.srt` ao lado); **perfil horizontal 1920x1080 com corte longe do início da fonte (91-106 s) e fala acentuada perto do fim**: com a entrega `burn` o texto está no quadro, embaixo e centralizado, na hora da fala, e com `sidecar` o vídeo sai **sem texto** e o `.srt` vem ao lado (a entrega do corte, herdada do último corte do projeto, é o que decide).
- `subtitles-pipeline` / `-generate`: silêncio com áudio de verdade (e limiares hostis que não chegam ao ffmpeg), mapa de tempo, regras anti-alucinação, cues, JSON do whisper (inclusive UTF-8 dividido entre tokens e **japonês/chinês sem espaços**), geração de ponta a ponta com **motor simulado** (só o JSON do whisper é combinado) para provar remapeamento de tempo, descarte com motivo e revisão; **corte fora do vídeo, início negativo/inválido e corte no fim do vídeo** com a mensagem certa.
- `subtitles-models`: catálogo com revisão, tamanho e SHA-256 **fixados** e `ModelManager` contra um servidor HTTP local que imita a fonte (arquivo trocado, mesmo tamanho; troca que a própria fonte "confirmaria"; tamanho errado; 404 e fonte fora do ar; a API da fonte nunca é consultada; cancelamento, duas instalações, remoção, app atualizado com outro hash).
- `subtitles-ipc`: handler com `ctx` real, status, modelos, erros, importação de legendas (UTF-8, Windows-1252, **UTF-16 LE/BE com BOM**, legenda hostil de 200 KB) e **`silence` hostil no `subtitles:generate`** (o arquivo do usuário continua intacto).
- `subtitles-gpu`: detecção com `nvidia-smi` falso (placa boa, driver antigo, várias placas, sem driver, erro/prazo) e uma consulta real ao driver; tipo do motor pela pasta; aviso de memória; matriz de `planDevice`; memória de falhas; log do whisper-cli; geração na placa/processador/fallback com motor simulado (inclui `-ng` e cancelamento); IPC com `ctx` real (automático, CPU forçada, falha lembrada, sem NVIDIA, só motor de CPU, memória de 1 GB, motor do hospedeiro CUDA e CPU sem baixar motor próprio); entrada oficial `whisper-cuda` e instalação de um zip `Release/` de mentira por servidor HTTP local (o pacote de 675 MB nunca é baixado nos testes).
- `subtitles-gpu-real` (**real, com a placa**): reutiliza o motor CUDA e o modelo que o BDS já tem instalados (nada é baixado), sintetiza fala, transcreve na placa e no processador, confere o texto, a memória da placa no `nvidia-smi` durante a execução, falha real do programa com fallback, e imprime as velocidades. Pula com o motivo sem placa/motor/modelo/voz.
- `subtitles-whisper` (**real**): motor oficial b5130 e modelo tiny instalados pelas rotas do app; fala pt-BR e en-US sintetizadas pelo Windows transcritas, com tempos relativos ao corte; fala baixa; silêncio (o whisper nem é chamado), ruído, tom e vídeo sem áudio resultam em nenhuma fala; cancelamento sem processo nem pasta sobrando; caminho com acentos. Sem internet o teste é pulado com o motivo (`BF_REQUIRE_NETWORK=1` faz falhar; `BF_SKIP_NETWORK_TESTS=1` pula sem tentar baixar; o `npm test` inteiro roda este arquivo e baixa ~40 MB). `BF_SUBTITLES_TEST_CACHE=<pasta>` reaproveita motor e modelo já instalados (só desenvolvimento).
- `e2e/subtitles`: o que falta → instalar pela aba (downloads reais) → gerar → revisar → intervalo do corte muda → aparência → prévia **bate com o vídeo exportado** (posição e tamanho) → exportação real → sem libass → reabrir o app → remover modelo → nada sobrou no disco.
- `e2e/subtitles-ui` (sem downloads): Preferências "Gerar legendas" liga a caixa dos cortes novos; "Usar esta aparência nos próximos vídeos" define `subtitles.style` e um projeto novo abre com ela; aparar o corte (`BF.review.adjust`) e desfazer (`BF.review.engine.undo`) devolve as falas exatas; texto com linha em branco gera `.srt` inteiro; fonte 140: a prévia quebra a linha dentro das margens e a altura bate com o vídeo exportado pelo libass; legenda ligada sem falas: o QC da aba Exportar avisa e não bloqueia.
