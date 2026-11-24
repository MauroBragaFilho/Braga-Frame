# Exportação (exportEngine): perfis, enquadramento, codificadores e controle de qualidade

Contratos: [`arquitetura.md`](../arquitetura.md) 3.1 (perfil), 3.2 (enquadramento) e 3.3 (Job, `runExportJob`, `preflight`). Este recurso **monta** os Jobs e **executa/confere** cada um; quem os guarda e agenda é a Fila (`docs/recursos/queue.md`). Exportar só gera arquivos locais: a publicação é manual.

**Novo (layouts do canal):** o exportador aplica o `layout` de cada corte (`conversa` | `jogo`, que a análise guarda) como enquadramento e deixa o usuário escolher se mantém ou faz diferente; há também um detector local, pela imagem. Veja "Layouts do canal" e "Detector local de layout" abaixo.

## O que faz

- **Perfis**: 12 embutidos (9:16 e 16:9 em 1080/1440/2160 x H.264/H.265) e os do usuário (`userData/profiles.json`).
- **Enquadramento**: centro, fundo desfocado, webcam + jogo e retângulo livre, por projeto e por corte, com prévia gerada pelo **mesmo filtro** da exportação.
- **Layouts do canal**: dois presets editáveis (Conversa e Jogo, com prévia real) aplicados aos cortes pelo layout sugerido ou escolhido, com a origem de cada enquadramento à vista (`sugerido: Jogo`, `escolhido: Conversa`, `personalizado`, `padrão`), troca de layout por corte e em lote, e presets que podem virar padrão do canal, do jogo ou geral (preferências por escopo).
- **Detector local de layout** (opcional): olha 3 quadros de cada corte e os compara com quadros de referência que o usuário escolhe; conservador, só decide quando tem certeza.
- **Codificadores**: software (libx264/libx265) ou placa NVIDIA (NVENC, testado de verdade), com queda para software e aviso.
- **QC** (`qc.js`): erros que bloqueiam só aquele trabalho (com causa e solução) e avisos que nunca bloqueiam.
- **Execução** (`jobRunner.js`): grava em `.part`, só renomeia ao concluir, trata conflito de nome, cancela limpando o `.part`.
- **Aba Exportar**: perfil, enquadramento com prévia, cortes a exportar, destino, conferência e um único botão "Adicionar à fila".

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/export/profiles.js` | Perfis embutidos, `validateProfile`, `ProfileStore` (perfis do usuário, gravação atômica) |
| `src/core/export/framing.js` | `resolveFraming`, `normalizeFraming`, `mergeLayers`, `buildVideoGraph` (grafo `-filter_complex`), `framingUpscale`, `centerWindow`. **Universal**: CommonJS no main e `window.BFFraming` no renderer (a aba usa as mesmas regras da exportação) |
| `src/core/export/layouts.js` | **Fonte única** da precedência e da origem do enquadramento por layout: presets de fábrica, `composePresets`, `resolveCutFraming`, `cameraProblems`. **Universal** (`window.BFLayouts`) |
| `src/core/export/layoutDetector.js` | Detector local de layout por quadros de referência (miniaturas 64x36, só ffmpeg e Node) |
| `src/core/export/encoders.js` | Argumentos de libx264/libx265/h264_nvenc/hevc_nvenc, `detectEncoders` (mini-encode + cache de 24 h), `chooseEncoder` |
| `src/core/export/qc.js` | `preflight(job, { tools })` |
| `src/core/export/jobRunner.js` | `runExportJob`, `ExportError`, conflito de nome, publicação atômica, classificação de erros |
| `src/core/export/jobs.js` | `buildJobs`: Jobs (3.3) a partir do projeto e das escolhas da aba |
| `src/core/export/preview.js` | Quadro da fonte (JPEG) e quadro enquadrado (PNG) |
| `src/core/export/naming.js` | Modelo de nome (`{fonte} - corte {n} - {titulo}`) e limpeza para o Windows |
| `src/core/export/optional.js` | Carrega `audioFilter` e `burnIn` (de outros recursos) se existirem |
| `src/core/export/legacy.js` | Compatibilidade com o perfil `{ resolution, codec }` da exportação mínima da base |
| `src/ipc/handlers/export.js` | Canais `export:*` |
| `renderer/features/export.js` / `.css` | Aba Exportar |

`cutExporter.js` e `exportProfile.js` (da base) foram **aposentados**: o que faziam está em `jobRunner.js`, `profiles.js` e `qc.js`.

## IPC (`src/ipc/handlers/export.js`)

| Canal | Payload | Resposta |
|---|---|---|
| `export:pickDir` | — | `{ path }` ou `{ canceled }` |
| `export:listProfiles` | — | `{ profiles:[Profile + builtin], defaultId, warning? }`; se `profiles.json` não puder ser lido (permissão, pasta no lugar do arquivo…), responde `ok` com os 12 embutidos e `warning` em português (a aba mostra o aviso e segue utilizável) |
| `export:saveProfile` | `{ profile }` (sem `id` cria; com o `id` de um perfil do usuário atualiza) | `{ profile, profiles }`; erros `INVALID_PROFILE`, `PROFILE_BUILTIN`, `PROFILE_NAME_EXISTS`, `PROFILE_STORE_FAILED` |
| `export:deleteProfile` | `{ id }` | `{ id, profiles }`; erros `PROFILE_BUILTIN`, `PROFILE_NOT_FOUND` |
| `export:encoders` | `{ force? }` | `{ ffmpeg, detection:{ software:{h264,h265}, nvenc:{h264:{available,reason?,detail?},h265:{…}}, checkedAt, cached } }`; `reason` é um texto curto **em português** (cabe em "…indisponível (motivo)"), `detail` é a linha técnica do ffmpeg (só diagnóstico, a interface não mostra) |
| `export:framePreview` | `{ sourcePath, timeSec, profile, framing, maxSide?=640 (0 = tamanho real), key? }` | `{ dataUrl (PNG), width, height, graph }` |
| `export:sourceFrame` | `{ sourcePath, timeSec, maxWidth?=960, key? }` | `{ dataUrl (JPEG), width, height }` |
| `export:prepare` | `{ project, info, cutIds, profile, framing, layouts?, outputDir, nameTemplate }` — `layouts = { presets, useSuggested, refsDigest }` aplica o layout de cada corte (sem ele, tudo segue o padrão) | `{ jobs, missing, reports:[{ jobId, cutId, title, errors, warnings }] }`; cada Job traz `framingSource` |
| `export:layoutRef` | `{ sourcePath, timeSec }` | `{ thumb (base64 de 64x36 cinza), w, h, timeSec }`; erros `NO_FFMPEG`, `INPUT_MISSING`, `NO_FRAME` |
| `export:detectLayouts` | `{ sourcePath, cuts:[{ id, start, end }], refs:{ conversa:[base64], jogo:[base64] } }` | `{ refsDigest, model, tookMs, results:[{ cutId, layout \| null, confidence, reason, key, at, samples:[{ t, layout }] }] }`; erros `BAD_REFS` (com `details.problems`), `INVALID_ARGS`, `CANCELLED`; evento `export:detectProgress { done, total }` |
| `export:detectCancel` | — | `{}` (uma detecção por vez: pedir outra também cancela a anterior) |
| `export:preflight` | `{ jobs }` | `{ reports }` |
| `export:warnings`, `export:run`, `export:cancel` | formato da exportação mínima | **legado** (a aba nova não usa; mantidos porque `tests/ipc-base.test.js`, da base, os cobre) |

- `key` em `framePreview`/`sourceFrame`: um pedido novo com a mesma `key` cancela o anterior (que responde `{ ok:false, code:'SUPERSEDED' }`, a interface ignora).
- A prévia é reduzida no fim (`maxSide`) só para ficar leve; o grafo antes disso é o da exportação. `maxSide: 0` devolve as medidas exatas do perfil.
- Nos últimos instantes do vídeo (o controle da prévia vai até o fim do corte, que pode ser o fim do arquivo) o `-ss` pode cair depois do último quadro: `framePreview` e `sourceFrame` tentam de novo 0,5 s antes, em vez de responder `NO_FRAME`. Bem depois do fim continua `NO_FRAME`.
- Erros comuns: `NO_FFMPEG`, `INPUT_MISSING`, `INVALID_PROFILE`, `NO_FRAME` (não há quadro nesse ponto), `INVALID_PROJECT`, `INVALID_ARGS`, `OUTPUT_NOT_WRITABLE`.

## Perfis

`Profile = { id, name, kind, width, height, resolutionLabel, codec, bitrateKbps, encoder, fps, container, framing?, builtin? }`

- Embutidos: `vertical-<1080|1440|2160>-<h264|h265>` (1080x1920, 1440x2560, 2160x3840, **10 000 kbps** em todos) e `horizontal-…` (1920x1080, 2560x1440, 3840x2160; 10 000, 16 000 e 35 000 kbps). O padrão obrigatório do produto é `vertical-1080-h264`. Nunca são editados nem excluídos (`PROFILE_BUILTIN`).
- Do usuário (`kind: 'custom'`): `userData/profiles.json` (`{ version:1, profiles }`), gravação atômica (arquivo temporário + `fsync` + rename). Valem para todos os projetos. Nome único (sem diferenciar maiúsculas), até 60 caracteres. Arquivo corrompido é preservado como `profiles.json.corrupt-<hora>` e a lista recomeça vazia. Entradas que este app não aceita (codec desconhecido de uma versão nova, id repetido, valores inválidos) **não aparecem na lista, mas continuam no arquivo** quando ele é regravado por um `save`/`remove`; a `version` e os outros campos do arquivo também são mantidos, e um arquivo de versão maior que a deste app ganha antes uma cópia `profiles.json.v<N>.bak` (uma vez). Se o arquivo não puder ser lido, `export:listProfiles` devolve os embutidos com um aviso (salvar/excluir continuam recusando com `PROFILE_STORE_FAILED`).
- Validação (`validateProfile`): largura e altura inteiras, **pares**, de 2 a 7680; bitrate de 500 a 150 000 kbps; codec `h264|h265`; encoder `auto|software|nvenc`; fps `source` ou 1 a 240; container `mp4`. As mensagens dizem o que corrigir.
- `framing` (opcional) é o enquadramento inicial do perfil (veja abaixo).

## Enquadramento

`Framing = { mode, focusX, focusY, zoom, blur:{strength}, stack:{webcamRect, gameRect, webcamHeightPct, webcamPosition}, custom:{x,y,w,h} }` (retângulos em fração da fonte).

| Modo | Resultado |
|---|---|
| `center` | Recorte que preenche o quadro. `zoom` (1 a 3) aproxima; `focusX`/`focusY` (0 a 1) escolhem a janela |
| `blur` | A imagem inteira da gameplay sobre o próprio vídeo desfocado (fundo em 1/4 da resolução, ampliado; `strength` 1 a 80, proporcional à largura de saída). `zoom`/`focus` aproximam o primeiro plano |
| `stack` | Webcam e gameplay empilhadas; cada uma preenche a sua faixa (corte central); a webcam ocupa `webcamHeightPct` % (10 a 60) da altura, em cima ou embaixo |
| `custom` | Um retângulo livre da fonte, escalado para preencher o quadro (corte central se a proporção não bater) |

- **Camadas** (`resolveFraming(cut, profile, projectDefaults)`): padrão do app < `profile.framing` < padrão do projeto < `cut.framing`. Nenhuma camada é alterada por outra; ajustar um corte nunca muda o perfil nem o padrão. O resultado é completo e idempotente (o Job guarda o enquadramento já resolvido em `job.framing`, e o runner o resolve de novo com o mesmo resultado). **Com layouts** o preset do layout do corte entra entre o padrão do projeto e o corte (`layouts.js`; seção "Layouts do canal"): quem monta os Jobs passa o preset como parte do "padrão do projeto" desta função e o resultado continua completo e idempotente.
- Valores fora da faixa são ajustados (clamp) em `normalizeFraming`; retângulos incompletos são ignorados.
- Funciona com qualquer largura x altura par (verificado de 2x2 a 7680; `stack` com altura < 4 vira `center`).
- O filtro usa expressões do ffmpeg (`iw`, `ih`), então não depende de conhecer as medidas da fonte. Termina sempre em `setsar=1`, filtros extras (legenda queimada) e `format=yuv420p`.
- `framingUpscale` calcula quanto a fonte é ampliada (usado pelo QC); `centerWindow` dá a janela da fonte que aparece (a interface desenha a sobreposição com a mesma conta, em `renderer/features/export.js`).

## Layouts do canal (Conversa | Jogo)

A análise por IA guarda em cada corte um `layout` (`conversa` ou `jogo`). Hoje ele vem de uma IA que **só lê texto**: é um **palpite** (a interface o chama de "palpite da IA"). O exportador aplica esse layout como enquadramento e **o usuário decide**: pode manter, trocar o layout do corte, personalizar o enquadramento dele, ou desligar tudo.

### Precedência (fonte única: `src/core/export/layouts.js`, com testes)

```
cut.framing (explícito do corte)
  > enquadramento do layout do corte
      layout do corte = cut.layoutChoice ('conversa' | 'jogo' | 'padrao', escolha do usuário)
                      > sugestão, SÓ com o interruptor ligado: detector local (resultado válido) > cut.layout (palpite da IA) > nenhuma
  > padrão do projeto (ext.export.framing) > perfil > app
```

- As camadas se juntam campo a campo (`blur` e `stack` por campo; retângulos inteiros) e **nenhuma é alterada por outra**: ajustar um corte nunca muda o perfil, os presets nem o padrão do projeto (teste com ffmpeg real e comparação pixel a pixel).
- A **escolha do usuário** (`layoutChoice`) vale mesmo com o interruptor desligado; o interruptor só desliga a **sugestão**. Escolher o que já valeria sem escolha (a sugestão, ou o padrão se nada é sugerido) só tira a escolha anterior: o corte volta a seguir a sugestão. A escolha de layout não apaga o enquadramento próprio do corte (ele continua por cima do layout).
- O resolvedor devolve também a **origem**: `{ kind: 'custom'|'chosen'|'suggested'|'default', layout, via: 'ia'|'detector'|null, base, label, preset:{ from, ref }, camera, confidence }` com `label` = `personalizado` | `escolhido: Conversa|Jogo` | `sugerido: Conversa|Jogo` | `padrão`. Num corte `personalizado` o layout que está por baixo continua registrado (`layout`, `base`). Sem presets (chamadores antigos de `buildJobs`) nenhum layout se aplica e a origem é `padrão`: nunca afirma um layout que não aplicou.
- **O Job grava a origem** em `job.framingSource` (auditoria: `kind`, `layout`, `via`, `base`, `label`, `preset:{ from, ref }`, `camera`, `confidence`). A fila guarda o campo no job (`queue.json`) e o devolve na lista; o runner e o QC dos Jobs que a fila reenvia só olham `job.framing`.
- **Chave do job / "já exportado"**: a chave (`src/core/queue/jobKey.js`) já inclui `job.framing` (o enquadramento **resolvido**, que contém o layout) e `cut.framing`. Logo: mudar o layout, o preset ou o interruptor muda o enquadramento efetivo e a chave, e um corte já exportado no padrão **não** é pulado por engano; repetir o mesmo enquadramento é pulado; e a origem sozinha (`sugerido: Jogo` × `escolhido: Jogo`, o mesmo arquivo) **não** muda a chave. Testes: `tests/export-layouts.test.js` ("chave da fila" e um `QueueManager` de verdade).

### Presets

- **De fábrica** (`defaultPresets()`), medidos em quadros reais da live de teste (2560×1440, 16:9):
  - **Conversa**: `center`, `focusX 0,63`, `focusY 0,5`, `zoom 1`. O rosto fica em 53% a 68% da largura (centro ≈ 58%); a janela 9:16 cobre de 43% a 75%: rosto inteiro, **sem o chat** (a partir de 77%) **nem o QR code**. O briefing sugeria `focusX ≈ 0,47`; com os quadros reais ele cortava o rosto em vários momentos, então o padrão é 0,63. O zoom fica em 1 (a janela mais larga: com zoom a cabeça encostaria nas bordas).
  - **Jogo**: `stack`, câmera em cima. A câmera é uma caixa **16:9 de 783×440 px** no canto superior esquerdo (medida em resolução total em 10 instantes: borda direita em x = 783 e inferior em y = 440, em todos): 30,6% × 30,6% da tela. O briefing falava em ≈ 0–0,23 × 0–0,26, que cortaria o lado direito e a base da câmera; o preset usa a caixa inteira com 3 px de folga (`webcamRect {0, 0, 0,3047, 0,3028}`), a faixa dela com 31% da altura (quase a proporção da câmera) e o jogo começando logo depois da câmera (`gameRect {0,306, 0, 0,459, 1}`) para a câmera não aparecer de novo na faixa de baixo.
- **Camadas do preset**: fábrica < herdado das preferências (**canal > jogo > geral**, pelo sistema de preferências por escopo) < deste projeto (`ext.export.layouts`, guardado como camada parcial). Um preset guardado é `{ framing (parcial), ref:{ w, h } }`; `ref` é o tamanho da fonte em que foi medido (o QC usa para avisar quando a proporção é outra).
- **Salvar como padrão do canal/jogo/geral**: grava o preset em vigor (e os quadros de referência, se houver) nas chaves `export.layout.conversa`, `export.layout.jogo` e `export.layout.refs` do escopo escolhido; **novos projetos do mesmo canal herdam** sem copiar. Se o valor herdado passa a ser igual ao do projeto, o projeto volta a herdá-lo (some o "deste projeto"). Para remover um padrão salvo: **Limpar** em Preferências, Mais ajustes (as três chaves aparecem lá como "definido na aba Exportar").

### Na aba Exportar

- **Interruptor** "Usar o enquadramento sugerido pela análise" (`#exp-suggest`; ligado por padrão; guardado em `ext.export.useSuggestedLayout`, só quando o usuário mexe) com uma frase de quantos cortes têm layout sugerido e por quem ("3 pela IA, 2 pela imagem"; "o palpite da IA vem só do texto: ela não vê a imagem").
- **Cada corte** mostra um chip de origem (`sugerido: Jogo`, `escolhido: Conversa`, `personalizado`, `padrão`) e, na linha de apoio, de quem sugeriu (`palpite da IA`, `detectado pela imagem`, `layout incerto`); a dica do chip explica em frase inteira. Com um corte escolhido na lista aparece **"Layout deste corte" (Conversa | Jogo | Padrão)** e a mesma explicação; o link **"Restaurar para o sugerido"** (ou "Restaurar padrão" se nada é sugerido) descarta a escolha e o enquadramento próprio do corte.
- **Ação em lote** "Definir layout dos cortes selecionados" (um seletor acima da lista, vale para os cortes marcados): Conversa, Jogo, Padrão (sem layout) ou **Voltar ao sugerido** (pede confirmação antes de descartar enquadramentos próprios).
- **"Layouts do canal"** (recolhido): as duas linhas Conversa e Jogo (de onde vem cada preset e quantos cortes usam), o botão para ajustar cada preset **no mesmo editor de cima, com prévia real** (mesmo filtro da exportação; a prévia usa um corte com esse layout ou o quadro do player: "Usar o quadro do player"), "Voltar ao padrão do canal/app", o seletor de escopo com **Salvar como padrão** e, recolhida, a detecção pela imagem. Em perfil horizontal um aviso diz que os layouts foram feitos para 9:16.

### QC da câmera (`CAMERA_RECT`, só aviso)

Para um corte cujo enquadramento vem de um layout de "webcam + jogo", o QC avisa (sem bloquear) quando o retângulo da câmera **sai da fonte**: (1) o retângulo, como foi guardado, passa da borda do vídeo (o filtro o encosta na borda e pode cortar a câmera); (2) a fonte tem **outra proporção** da usada para definir o layout (`ref`, 3% de tolerância); (3) a fonte é **pequena** demais (a câmera ficaria com menos de 240×135 px). É conta com medidas conhecidas: **não procura a câmera na imagem**. Um Job sem `framingSource` (como o que a fila reenvia ao QC) não gera esse aviso.

## Detector local de layout

O `layout` da análise é um palpite feito só com o texto. O detector (`src/core/export/layoutDetector.js`) olha a **imagem**: é local (ffmpeg + Node, sem rede e sem dependências), **explicável** e **conservador**: na dúvida devolve "incerto" e o corte segue o palpite da IA (ou o padrão). **Nunca chuta.**

### Como o usuário usa

Em **Layouts do canal > Detectar o layout pela imagem**: com o player num momento de Conversa (depois de Jogo) clica em **"Usar o quadro atual do player"**, de **2 a 4 quadros de cada layout, de momentos diferentes** (um quadro repetido é recusado). Depois **"Detectar o layout dos cortes"** (todos os cortes que não foram rejeitados; progresso e **Cancelar**). O resultado fica em `cut.layoutLocal = { layout|null, confidence, reason, key, at, samples }` e aparece no chip (`sugerido: Jogo`, "detectado pela imagem"). Quem não teve certeza fica `layout incerto` e segue o palpite da IA. Os quadros de referência ficam no projeto (`ext.export.layoutRefs`, texto base64 de 3 KB cada) e podem ir junto com o padrão do canal (`export.layout.refs`).

**Precedência entre as fontes da sugestão**: detector local (com referências e resultado **válido**) > palpite da IA > nenhuma. O resultado do detector só vale para **as mesmas referências e o mesmo trecho do corte** (a `key` é `<digest das referências>:<início>-<fim>`): trocar uma referência ou mexer no início/fim do corte o deixa "desatualizado" (a interface avisa "detecte de novo") e volta a valer o palpite da IA.

### Como funciona

1. De cada quadro: miniatura **64×36 em tons de cinza** (`scale=64:36:flags=area,format=gray`, lendo o vídeo; nada é escrito ao lado dele) e um **mapa de bordas** (|dx| + |dy|). Bordas descrevem o cenário do OBS (moldura da câmera, QR code, painel do chat, barra de itens) e não dependem do brilho da cena.
2. Com as referências de cada layout acha-se o **cenário fixo** dele: as células que **têm borda** (média ≥ 0,04), com bordas **parecidas entre as referências do mesmo layout** (desvio ≤ 0,03) e **diferentes das de todas as referências do outro** (≥ 0,06). Só **blocos conexos** de pelo menos 10 células contam (células soltas que ficaram parecidas por acaso saem), e o layout precisa de pelo menos 20 células. Referências que não servem são recusadas com a causa em português: `FEW_REFS` (menos de 2), `SIMILAR_REFS` (dois quadros do mesmo layout quase iguais: média < 0,02 de diferença) e `NO_SCENERY` (nenhuma parte fixa que distinga os layouts).
3. Um quadro novo é comparado ao cenário fixo de cada layout por correlação (**pontuação = 1 − NCC**, 0 = igual, ~1 = sem relação).
4. **Decide** só se o melhor layout tem pontuação ≤ **0,35** e o outro é pelo menos **3×** pior; senão o quadro é "incerto". A confiança do quadro é `1 − melhor/outro` (a mínima para decidir é 0,67).
5. **Corte** = 3 quadros (20%, 50% e 80%): vale o layout se **ao menos 2 quadros decidem e nenhum discorda**; um quadro que discorda, ou menos de 2 quadros decididos, deixa o corte incerto. A confiança do corte é a do pior quadro que decidiu.

Custo: ~0,5 a 2 s por quadro num 1440p VP9 de 12,5 GB (3 quadros por corte, 3 leituras em paralelo); a detecção é cancelável.

### Medição com dados reais (fora do repositório)

Vídeo da live de teste (NtadPdBszjk, 3 h, 2560×1440 VP9, **somente leitura**, quadros extraídos com o ffmpeg para fora do repositório). **135 quadros rotulados olhando as imagens**: 46 conversa, 87 jogo e 2 de uma terceira cena (menu do jogo com a câmera no canto superior **direito**, aos 9:20 e 10:20: não é nenhum dos dois layouts). Vieram do meio dos 15 cortes do gabarito, de 3 quadros (20/50/80%) de cada um desses cortes, dos 7 instantes já conhecidos, de 30 instantes aleatórios (semente fixa) e de 38 instantes em torno das conversas (a cada 60 s de 0 a 15 min e de 44 a 58 min, a cada 40 s nos últimos 5 min).

| Referências | Quadros | Cortes do gabarito (15) |
|---|---|---|
| As do dono: 2 de conversa (49:20, 53:45) e 4 de jogo (84:32, 121:22, 128:55, 149:50) | **124 de 127 certos, 0 errados, 3 incertos**; os 2 da terceira cena foram recusados | **15 de 15 certos** |
| Mínimo: 2 de conversa (49:20, 53:45) e 2 de jogo (84:32, 121:22) | 117 de 129 certos, 0 errados, 12 incertos | **15 de 15 certos** |
| Outras 2+2 (um quadro de 0:20 e um de 49:00; dois de jogo) | 88 certos, 0 errados, 41 incertos | 10 certos, 5 incertos, 0 errados |
| **1000 sorteios** de 2 a 4 referências por layout (25 recusados por referências quase iguais) | **88,7% certos, 0 errados em 123 810 decisões, 11,3% incertos** (6% com 4+4 referências; 17% com 2+2) | **91,1% certos, 0 errados, 8,9% incertos** em 14 625 decisões (3,7% com 4+4; 15% com 2+2) |

**Pelo caminho do produto** (`grabThumb` + `detectCuts`, extração real com o ffmpeg direto do vídeo de 12,5 GB, com as referências do dono): **15 de 15 cortes certos**, confiança de 0,85 a 0,99 e os 3 quadros de cada corte concordando; 27 s para os 15 cortes (45 quadros) e 4,6 s para os 6 quadros de referência. As miniaturas extraídas pelo módulo são idênticas, byte a byte, às usadas na medição (14 instantes conferidos, 0 diferenças).

A terceira cena foi aceita **0 de 1 950** vezes nos sorteios. **Nenhum quadro foi trocado de layout em nenhuma configuração.** Quem escolhe poucas referências, ou todas muito parecidas, vê mais cortes "incertos" (o detector se retrai em vez de errar).

**Negativos derivados dos quadros reais** (400 sorteios; o que o detector aceitaria como Conversa ou Jogo sem ser nenhum dos dois): espelho horizontal 0,01%, vertical 0,02%, deslocados em 6 células (≈ 10% da largura) 0,2 a 0,5%, em 4 células na vertical 0,1%, ampliado 1,2× 0,07%, reduzido 0%, quadro liso (preto, cinza, branco) e ruído **0%**. Duas fraquezas conhecidas (veja Limites): **transição entre os dois layouts** (mistura 50/50 de um quadro de jogo com um de conversa) aceita 38% e a **câmera trocada de canto com o resto do jogo (HUD) igual** aceita 16%.

> Os limiares (0,35, razão 3, piso de borda 0,04, estabilidade 0,03, distinção 0,06, 10 células) foram escolhidos varrendo **os mesmos** quadros; por isso os números acima podem estar um pouco otimistas para outras lives. Só uma live foi medida.

### Testes do repositório

`tests/export-detector.test.js`: miniaturas fabricadas (cenário fixo + conteúdo que muda) para o modelo, a decisão por quadro e por corte (incluindo as regras de 2 de 3, discordância e incerteza), recusas com a causa em português; **ffmpeg real** em um vídeo sintético de dois layouts (plasma que muda a cada quadro + cenário fixo) mais uma terceira cena (`grabThumb`, `detectCuts`, progresso, cancelamento, o vídeo nunca é alterado); os canais `export:layoutRef` e `export:detectLayouts` (chave por referências e trecho, progresso por evento, `BAD_REFS`, cancelamento). A medição com quadros reais é feita fora do repositório (conteúdo de terceiros).

## Codificadores

- Argumentos (`buildEncoderArgs`): `-b:v` alvo, `-maxrate` = 1,2x, `-bufsize` = 2x, `-pix_fmt yuv420p`, `-tag:v hvc1` no H.265, `-movflags +faststart`. libx264/libx265: `-preset medium` (x264 `-profile:v high`; x265 `-x265-params log-level=error`). NVENC: `-preset p5 -tune hq -rc vbr` (+ `-profile:v high` no H.264). **Sem `-spatial_aq`** (25/10/2026): o ffmpeg 9.x só aceita `-spatial-aq` e o antigo só `-spatial_aq`; com a opção desconhecida a placa recusava TODA exportação e o app caía para software (descoberto quando o teste de NVENC real passou a falhar com o ffmpeg 9.0.2). Áudio: AAC 192 kb/s, 48 kHz, estéreo.
- **Detecção real** (`detectEncoders`): lê `ffmpeg -encoders` e roda um **mini-encode de 1 quadro** com `h264_nvenc` e `hevc_nvenc`. O resultado fica **24 horas** em memória e em `userData/cache/encoders.json` (chave: caminho + tamanho + data do ffmpeg, então trocar o FFmpeg refaz). `export:encoders { force:true }` ignora o cache **e também a lista de codificadores e as falhas recentes** (link "Testar a placa de novo" nos Detalhes).
- **Falha momentânea não é guardada por 24 h**: se `ffmpeg -encoders` falhar (tempo esgotado, arquivo bloqueado pelo antivírus…), a lista não é guardada (`encoderListing` devolve `ok:false`, repetido só depois de 10 s), a detecção confere cada codificador por um mini-encode de verdade e o resultado vale só 10 s em memória, nunca vai para o disco. O QC não acusa `CODEC_UNSUPPORTED` por uma lista que não pôde ser lida (quem decide é a exportação).
- **Motivo da falha da placa em português** (`describeEncoderFailure`): sem placa compatível, driver ausente/antigo, sem memória ou limite de sessões, tamanho de vídeo que a placa não aceita, NVENC não compilado no FFmpeg; o resto vira "a placa não conseguiu iniciar a codificação". O texto cru do ffmpeg (inglês, com endereços de memória) fica só em `detail` e em `details.stderr` dos erros; o aviso de queda durante o trabalho (`ENCODER_FALLBACK`) usa a mesma tradução.
- `auto` usa a placa se ela funciona (senão software, sem aviso); `software` nunca usa a placa; `nvenc` sem placa cai para software **e avisa** (`ENCODER_FALLBACK`). Se a placa falhar **durante** a exportação (driver, limite de sessões, resolução acima do limite de 4096 do H.264…), o corte é refeito por software e o resultado traz o aviso.

## Controle de qualidade (`preflight`)

Síncrono (a fila pode chamar com ou sem `await`). `{ errors:[{code,message,solution}], warnings:[{code,message}] }`.

| Erro (bloqueia só o trabalho) | Quando |
|---|---|
| `NO_FFMPEG` | sem ffmpeg |
| `INVALID_PROFILE` | perfil inválido |
| `INPUT_MISSING` | vídeo ausente/ilegível |
| `INVALID_RANGE` | início/fim inválidos ou depois do fim do vídeo (tolerância de 0,25 s) |
| `OUTPUT_NOT_WRITABLE` | sem pasta, pasta impossível ou sem permissão (teste de gravação real) |
| `OUTPUT_IS_SOURCE` | o destino seria o próprio vídeo de origem |
| `NO_DISK_SPACE` | espaço livre menor que a estimativa (`(bitrate + 192 kb/s) x duração x 1,05`); só com `fs.statfs` informando |
| `CODEC_UNSUPPORTED` | o ffmpeg não tem o codificador (nem libx26x nem NVENC) ou não tem libass com legenda queimada pedida (a checagem do codec só vale se a lista de codificadores pôde ser lida) |

| Aviso (nunca bloqueia) | Quando |
|---|---|
| `NO_AUDIO` | fonte sem áudio |
| `AUDIO_TRACKS` | a fonte tem 2 ou mais faixas de áudio: **só a primeira entra no corte** (o app não mistura; típico de gravação do OBS com microfone em outra faixa) |
| `HDR_SOURCE` | a fonte é HDR (PQ ou HLG): o app não faz tone mapping, as cores podem sair apagadas |
| `NOT_9X16` / `NOT_16X9` | as medidas de um perfil `vertical`/`horizontal` deixaram de ter a proporção do tipo (por exemplo, o Vertical 9:16 ajustado para 1920×1080 nos Detalhes); perfis próprios (`custom`) não avisam |
| `UPSCALE` | o enquadramento amplia a fonte mais de 5 % (conta pelo enquadramento do corte) |
| `CAMERA_RECT` | layout "webcam + jogo": o retângulo da câmera passa da borda da fonte, a fonte tem outra proporção da usada no layout, ou é pequena demais para a câmera (só conta com medidas conhecidas; não procura a câmera na imagem). Só nos Jobs que trazem `framingSource` |
| `HEVC_COMPAT` | H.265 |
| `RES_COMPAT` | H.264 acima de 4096 px |
| `BITRATE_LOW` / `BITRATE_HIGH` | bits por pixel por quadro abaixo de 0,045 (0,03 em H.265) / acima de 0,6 (0,4); sugere um valor |
| `LONG_CUT` | corte com mais de 3 minutos (limite do Shorts) |
| `NAME_CONFLICT` | já existe o arquivo (informativo: a decisão é da fila) |
| `LOW_DISK` | espaço livre menor que 1,5x a estimativa |
| `ENCODER_FALLBACK` | NVENC pedido e indisponível (só se a detecção já foi feita) |
| `SUBTITLES_WARNING`, `SUBTITLES_UNAVAILABLE`, `AUDIO_UNAVAILABLE` e os `*_LIMITED` do áudio | vindos dos módulos de legendas e áudio |

## `runExportJob(job, { tools, onProgress, signal, tmpDir, onStart? })`

Resultado: `{ output, warnings:[{code,message}], skipped, encoder:{kind,name}|null, sizeBytes }`. `onStart({ pid })` é opcional (observação e testes).

1. Valida (perfil, intervalo, entrada, pasta). `onConflict` precisa vir resolvido (`rename|replace|skip|fail`; qualquer outro valor, inclusive `ask`, vale `fail`).
2. Reserva o destino (dois trabalhos do processo nunca gravam o mesmo arquivo): `rename` => "nome (2).mp4"…; `skip` => devolve `skipped: true` com o arquivo existente, sem rodar o ffmpeg; `replace` => grava no `.part` e **troca de forma atômica só depois do sucesso** (o original fica intacto até lá e, se falhar, continua intacto); `fail` => `OUTPUT_EXISTS`. Nunca escreve sobre o próprio vídeo de origem. Um `.part` sem dono (sobra de uma execução interrompida) é descartado.
3. Monta o filtro de vídeo, o de áudio (`buildAudioFilter(audio, { duration })`, `resolveAudio` gera avisos de limite) e as legendas (`prepareBurnIn(cut, { tmpDir, width, height, ffmpegPath })`, só se `cut.subtitles.enabled`; o filtro entra depois do enquadramento, na resolução de saída). Módulo ausente: avisa e segue. Módulo que falha: `SUBTITLES_FAILED`/`AUDIO_FAILED` (`BURNIN_UNSUPPORTED` vira `CODEC_UNSUPPORTED`).
4. Roda o ffmpeg (`-ss`/`-t` antes do `-i`, `-progress pipe:1`), com queda para software se a placa falhar.
5. Verifica o arquivo (não vazio; com ffprobe: dimensões exatas; duração fora de 5 % vira aviso), publica **sem sobrescrever** (link físico; sem suporte, confere e renomeia) e copia os `sidecars` ao lado do vídeo como `<nome do vídeo>.<ext>` sem sobrescrever (se já existe um diferente: aviso `SIDECAR_EXISTS`).
6. `finally`: apaga o `.part`, libera o destino. Cancelar (`signal`) mata o ffmpeg e lança `CANCELLED`; nada sobra.

Erros (`ExportError`, com `code`, `message`, `recoverable` e `details:{ solution, stderr (final), exitCode }`): recuperáveis `FFMPEG_START_FAILED`, `IO_BUSY`, `FFMPEG_CRASH`, `DISK_TRANSIENT`; não recuperáveis `INPUT_MISSING`, `INVALID_PROFILE`, `INVALID_RANGE`, `NO_DISK_SPACE`, `OUTPUT_EXISTS`, `CANCELLED`, `CODEC_UNSUPPORTED` e, **além do contrato**, `NO_FFMPEG`, `FFMPEG_FAILED`, `OUTPUT_NOT_WRITABLE`, `SUBTITLES_FAILED`, `AUDIO_FAILED`, `OUTPUT_INVALID`. A classificação sai do texto do stderr e do código de saída: **só sinal ou exceção do sistema (NTSTATUS `0xC000xxxx`, p. ex. `3221225477`) é `FFMPEG_CRASH`**. O ffmpeg do Windows sai com um AVERROR lido sem sinal (`4294967274` para "Invalid argument", `3015096584` para "filtro não encontrado"): é falha comum, `FFMPEG_FAILED`, que a fila não repete. Fonte sem faixa de vídeo ("Stream specifier… matches no streams") vira `FFMPEG_FAILED` com causa e solução próprias.

## Aba Exportar

Sem projeto aberto a aba fica desabilitada pela base e o painel mostra só uma orientação (não quebra).

- **Perfil**: seletor (Vertical 9:16, Horizontal 16:9, Meus perfis). "Detalhes" (recolhido; o resumo mostra resolução, codec e bitrate): largura/altura, codec, bitrate (barra em escala logarítmica de 0,5 a 150 Mbps, padrão 10), codificador (com o resultado real da detecção), quadros por segundo, "Salvar como meu perfil…", "Voltar aos valores do perfil" e "Excluir este perfil". Mudanças nos Detalhes valem **para este projeto** (`ext.export.overrides[perfil]`) até serem salvas como perfil. Se as medidas ajustadas mudam a proporção do perfil-base, o perfil efetivo (o que vai no Job e aparece na fila) passa a se chamar "Personalizado (largura×altura)" em vez de "<perfil> (ajustado)", uma dica abaixo do seletor explica e o QC avisa `NOT_9X16`/`NOT_16X9`. Se os perfis salvos não puderam ser lidos, um aviso aparece abaixo do seletor e os embutidos continuam utilizáveis.
- **Enquadramento**: quatro modos, vídeo de origem com retângulo(s) arrastáveis (mouse; setas do teclado com o retângulo focado; canto redimensiona mantendo a proporção do quadro de saída) ao lado da prévia final (atualiza com 260 ms de debounce), controles por modo e um ponto do corte para a prévia. O alvo da edição é "Padrão do projeto", um **layout** (preset de Conversa ou de Jogo, em "Layouts do canal") ou um corte (chip de origem em cada corte: "personalizado" nos que têm ajuste próprio); "Restaurar" limpa o ajuste do alvo (num corte, "Restaurar para o sugerido"; num preset, "Voltar ao padrão do canal/app"). Interruptor "Usar o enquadramento sugerido pela análise", troca de layout por corte, ação em lote e a detecção pela imagem: veja "Layouts do canal".
- **Cortes a exportar**: aprovados marcados por padrão; é possível marcar outros (pendentes) e desmarcar aprovados. A mesma lista escolhe de qual corte se edita o enquadramento.
- **Destino**: pasta (padrão `Cortes` ao lado do vídeo, `project.exportDir` se escolhida) e, recolhido, o modelo do nome (`{fonte}`, `{n}`, `{titulo}`, `{perfil}`).
- **Conferência**: roda `export:prepare` (Jobs + QC de cada um) sempre que algo muda (só com a aba visível). Erros ficam sempre visíveis, com "Como resolver"; os avisos ficam recolhidos ("N avisos (não impedem a exportação)"). Mensagens iguais de vários cortes são agrupadas. O rodapé fixo ("Adicionar à fila") fica acima dos retângulos de enquadramento (z-index) e tem fundo sólido.
- **Adicionar à fila (N)**: refaz o `export:prepare`, envia os Jobs **sem erro** por `BF.api('queue:enqueue', { jobs })` (os com erro ficam de fora e isso é dito) e leva para a tela Exportações (aba `queue`, a antiga Fila). Se a fila não existe ou recusa, mostra o motivo e **não** diz que enfileirou. Resposta `skipped` da fila ("já estava na fila/exportado") é informada.
- Respeita `BF.prefs.get('export.profileId')` e `BF.prefs.get('export.framing.mode')` para projetos que ainda não escolheram.

### Faixas de áudio e HDR da fonte

`buildJobs` copia para `job.sourceInfo`, **só quando valem um aviso**, `audioTracks` (2 ou mais faixas) e `hdr: true` (curva de cor `smpte2084` ou `arib-std-b67`); o Job comum continua com os cinco campos do contrato. Os dados vêm do `probeMedia` da base (`audioTracks`, `colorTransfer`). A exportação usa sempre a **primeira** faixa de áudio (assim como a medição do Áudio e a forma de onda); escolher a faixa ou mixar todas **não foi implementado** (decisão provisória: avisar).

### Dados no projeto

`project.ext.export = { profileId?, overrides?: { [perfil]: { width, height, codec, bitrateKbps, encoder, fps } }, framing?: <Framing parcial>, nameTemplate?, useSuggestedLayout?: boolean, layouts?: { conversa?, jogo? }, layoutRefs?: { conversa: [base64], jogo: [base64] } }`, mais `project.profileId` (campo do contrato 2.1) e, em cada corte, `cut.framing` (parcial), `cut.layoutChoice` (`'conversa' | 'jogo' | 'padrao'`, escolha do usuário; ausente = segue a sugestão) e `cut.layoutLocal` (resultado do detector: `{ layout|null, confidence, reason, key, at, samples }`). `cut.layout` (`'conversa' | 'jogo'`) continua sendo **só da análise** (o palpite da IA): o exportador nunca o altera. `useSuggestedLayout` só é gravado quando o usuário mexe no interruptor (ausente = ligado); `layouts.<layout>` = `{ framing (parcial), ref:{ w, h } }` (a camada deste projeto do preset); `layoutRefs` = até 4 miniaturas 64×36 em tons de cinza (3 072 caracteres base64 cada) por layout. Só o renderer grava o projeto.

Preferências novas (`src/core/preferences/keys.js`, tipo `object`, "Mais ajustes", herdadas por canal > jogo > geral): `export.layout.conversa`, `export.layout.jogo` (um preset cada) e `export.layout.refs` (`{ conversa:[…], jogo:[…] }`, até 32 KB; as outras chaves de objeto seguem em 4 KB). Elas aparecem em Preferências como "definido na aba Exportar" (`valueText` no catálogo) e podem ser removidas com "Limpar".

Job (contrato 3.3): ganha `framingSource` (origem do enquadramento; auditoria). Os cinco campos do Job comum continuam como antes.

## Decisões provisórias

- Bitrates dos horizontais: 10/16/35 Mbps (o briefing só fixa 10 Mbps para o 9:16). Faixas de aviso de bitrate por bits/pixel/quadro (0,045 e 0,6; 0,03 e 0,4 em H.265): a confirmar com a Liz.
- `auto` prefere a placa quando ela funciona (mais rápido; a qualidade por bitrate é um pouco menor que a do software). Quem prioriza qualidade escolhe "Software".
- Fundo desfocado em 1/4 da resolução; escala `lanczos`; `maxrate` 1,2x e `bufsize` 2x do bitrate.
- Corte longo: aviso acima de 180 s (limite atual do Shorts).
- Nome padrão do arquivo `{fonte} - corte {n} - {titulo}` (número com no mínimo 2 dígitos, pela ordem cronológica de todos os cortes do projeto).
- Layouts: o interruptor "Usar o enquadramento sugerido pela análise" vem **ligado** (decisão do dono); a escolha do usuário num corte vale mesmo com ele desligado. Presets de fábrica medidos numa live só (veja "Presets"); `focusX 0,63` e a câmera 0,3047×0,3028 **divergem** do briefing (0,47 e 0,23×0,26) porque os quadros reais não confirmaram os números do briefing.
- Detector: só decide com certeza (limiares conservadores) e só vale para as mesmas referências e o mesmo trecho; mínimo de 2 referências por layout (3 ou 4, variadas, dão bem menos "incertos").

## Limites conhecidos

- A prévia mostra **um quadro** sem legendas nem ajuste de áudio.
- Fontes HDR, com rotação ou pixel não quadrado não recebem tratamento especial (nem tone mapping); o HDR é avisado (`HDR_SOURCE`), rotação e pixel não quadrado não.
- **Só a primeira faixa de áudio** entra no corte (com `AUDIO_TRACKS` avisando quando há mais); o aviso não aparece nas abas Áudio e Legendas, que também usam a primeira faixa.
- No último 0,5 s do vídeo a prévia mostra o quadro de até 0,5 s antes (o ffmpeg não entrega quadro depois do último).
- NVENC controla o bitrate pior que o x264/x265 em conteúdo muito ruidoso e clipes curtos (nos testes chegou a ~1,45x o alvo); o teto `maxrate` é pedido, mas não é garantido pela placa.
- `profiles.json` não tem trava entre processos (o app abre uma janela só).
- Publicação sem sobrescrever usa link físico; em discos sem links (exFAT, rede) confere e renomeia, com uma janela minúscula de corrida.
- O `fs.statfs` pode não informar em alguns sistemas de arquivos: nesse caso o espaço não é conferido.
- **Detector**: medido com **uma** live (vídeo do dono; só leitura) e com os limiares escolhidos nesses mesmos quadros: pode ser menos preciso em outras cenas do OBS. Não distingue bem uma **transição** entre os dois layouts (38% dos quadros misturados 50/50 recebem um layout; o corte só decide se 2 de 3 quadros concordam) nem uma cena que **mantém o resto do jogo (HUD) e muda só a câmera de canto** (16% aceitos como Jogo): nesses casos o chip `sugerido` pode estar errado e a prévia do corte mostra o resultado. Não há um terceiro layout: uma cena que não é Conversa nem Jogo costuma sair "incerta", mas não é garantido. Os layouts de fábrica foram feitos para 9:16.
- Os layouts herdam por **escopo** (canal, jogo ou geral), como as outras preferências; mudar o padrão do canal muda os projetos que não têm ajuste próprio dele (os com "deste projeto" não mudam).
- Só foi testado no Windows (Node 24, ffmpeg "full" 2026-02-09, GTX 1650). Linux/macOS não foram executados.
- FFmpeg é só o do sistema (nunca baixado); este recurso não usa ferramenta instalada pelo app, então não registra nada em `ctx.toolUsage`.

## Pedidos de contrato (para `arquitetura.md`)

1. **3.2 `Framing`**: campo `focusY` (0..1, padrão 0,5), usado com zoom ou quando a fonte é mais estreita que o quadro.
2. **3.1 `Profile`**: campos opcionais `framing` (enquadramento inicial, parcial) e `builtin` (só leitura, devolvido por `export:listProfiles`); `fps` pode ser número.
3. **3.3 `runExportJob`**: o retorno acrescenta `skipped` (verdadeiro quando `onConflict: 'skip'` encontrou o arquivo; `output` é o arquivo existente), `encoder` e `sizeBytes`; o 2º argumento aceita `onStart({ pid })`. A fila já usa `skipped`.
4. **3.3 códigos de erro**: acrescentar (não recuperáveis) `NO_FFMPEG`, `FFMPEG_FAILED`, `OUTPUT_NOT_WRITABLE`, `SUBTITLES_FAILED`, `AUDIO_FAILED`, `OUTPUT_INVALID`; o `ExportError` traz `recoverable` e `details.solution` (a fila já lê `details.solution`). O QC também usa `OUTPUT_IS_SOURCE`.
5. **Seção 5 / IPC**: canais novos `export:listProfiles`, `saveProfile`, `deleteProfile`, `encoders`, `framePreview`, `sourceFrame`, `prepare`, `preflight`. `export:warnings`, `export:run` e `export:cancel` ficam **legados**: a base pode removê-los junto com os testes correspondentes de `tests/ipc-base.test.js` quando quiser.
6. **Base (`tests/e2e/app.e2e.js`)**: o trecho de exportação usa a aba mínima antiga (`#btnExport`, `#resolution`, `#codec`, `#bitrate`, `#dirLabel`, `#warnings`) e exportação direta; a aba nova usa a fila, então esse trecho precisa ser reescrito (o e2e da exportação agora é `tests/e2e/export.e2e.js`).
7. **prefs**: `export.profileId` pode guardar o id de um perfil do usuário (`user-…`); quem lista perfis na tela de Preferências deve usar `export:listProfiles`.
8. **Namespace do projeto**: `project.ext.export` (formato acima).
9. **3.3 `Job.sourceInfo`**: campos opcionais `audioTracks` (número, presente só com 2 ou mais faixas) e `hdr` (`true`, presente só em HDR).
10. **Base (`src/core/ffmpeg/probe.js`)**: `probeMedia` passa a devolver `audioTracks` (contagem de faixas de áudio) e `colorTransfer` (`video.color_transfer` ou `null`). Mudança aditiva, feita pelo exportEngine por pedido dos revisores; a base deve incorporá-la.
11. **Seção 5.4 / IPC**: `export:listProfiles` pode trazer `warning`; `export:encoders` → `detection.nvenc.<codec>.reason` é texto em português e `detail` é o texto técnico; `ExportError` `FFMPEG_CRASH` só para sinal ou NTSTATUS `0xC000xxxx` (qualquer outra saída ≠ 0 é `FFMPEG_FAILED`); avisos novos do QC `AUDIO_TRACKS`, `HDR_SOURCE`, `NOT_9X16`, `NOT_16X9`.
12. **3.3 `Job`**: campo opcional `framingSource` = `{ kind: 'custom'|'chosen'|'suggested'|'default', layout, via: 'ia'|'detector'|null, base, label, preset:{ from, ref }\|null, camera\|null, confidence\|null }` (de onde veio o enquadramento; só auditoria). **Alteração fora dos arquivos do exportEngine**: `QueueManager.enqueue` descartava os campos que não conhecia; foi acrescentada **uma linha** (`framingSource`) em `src/core/queue/QueueManager.js` para o campo chegar ao `queue.json` e à lista (nada mais da fila mudou; os testes da fila passam). O runner e a chave do job não o usam.
13. **3.2 `Framing` / 1.3 renderer**: `framing.js` passou a ser **universal** (CommonJS no main e `window.BFFraming` no renderer, carregado por `<script>` em `renderer/index.html` antes de `features/export.js`); novo `mergeLayers(...camadas)`. Novo módulo universal `src/core/export/layouts.js` (`window.BFLayouts`). `renderer/index.html` ganhou os dois `<script>`.
14. **2.2 Corte / 5.3**: campos extras do corte (preservados por `normalizeCut`): `layoutChoice` (`'conversa'|'jogo'|'padrao'`) e `layoutLocal` (resultado do detector). `cut.layout` segue sendo só da análise. **5.3 `ext.export`**: `useSuggestedLayout`, `layouts`, `layoutRefs` (formato em "Dados no projeto").
15. **3.5 / 5.11 Preferências**: chaves novas `export.layout.conversa`, `export.layout.jogo` e `export.layout.refs` (tipo `object`, herdadas por canal > jogo > geral; `refs` aceita até 32 KB). Mudanças mínimas fora do catálogo: `DEFS[].valueText` (texto do valor quando a chave é editada em outra aba) lido por `formatValue` (`keys.js`) e por `fmtValue` (`renderer/features/prefs.js`), e `DEFS[].maxLength` (tamanho máximo de um `object`).
16. **Seção 5 / IPC e eventos**: canais novos `export:layoutRef`, `export:detectLayouts`, `export:detectCancel`; `export:prepare` aceita `layouts`; evento do main `export:detectProgress { done, total }`. Códigos novos: `BAD_REFS` (com `details.problems` de `FEW_REFS`, `SIMILAR_REFS`, `NO_SCENERY`) e o aviso de QC `CAMERA_RECT`.
17. **Para a análise** (`docs/recursos/analise-ia.md`, fora deste recurso): o `layout` do corte agora **é aplicado** pelo exportador (§9 e §15, item 1, ficam desatualizados). Sugestão: o chip "Conversa"/"Jogo" do cartão da sugestão poderia dizer "palpite: Jogo", como a aba Exportar, já que a IA só lê o texto.

## Testes

```bash
node --test tests/export*.test.js
node tests/e2e/export.e2e.js            # abre o app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
node tests/e2e/export-layout.e2e.js     # layouts do canal e detector (capturas 1360x840 nos temas escuro e claro)
npx eslint src/core/export src/ipc/handlers/export.js renderer/features/export.js tests/export*.js tests/e2e/export.e2e.js tests/e2e/export-layout.e2e.js
```

- `export-profiles.test.js`: embutidos, validação, `ProfileStore` (atômico, arquivo corrompido, nomes), nomes de arquivo, `buildJobs`, compatibilidade legada.
- `export-framing.test.js`: camadas e imutabilidade; **ffmpeg real**: dimensões exatas (todos os perfis e perfis livres), e amostragem de pixels numa fonte codificada por posição (R = x, G = y) provando que focusX/focusY/zoom, blur (nitidez e imagem inteira), stack (faixas, ordem, altura em %), retângulo livre e `fps` mudam o conteúdo.
- `export-encoders.test.js`: argumentos, `chooseEncoder`, detecção real com cache de 24 h (memória, disco, corrompido, `force`, chamadas simultâneas); motivo da falha do NVENC em português (amostras reais de stderr e `-gpu 9` de verdade); `ffmpeg -encoders` que falha uma vez (um ffmpeg-lançador de verdade) sem envenenar o cache, com o QC sem bloquear à toa e `force`/validade curta recuperando.
- `export-qc.test.js`: cada erro e aviso com arquivos e disco reais (espaço simulado só para o limite), módulos de legenda/áudio reais e ausentes; faixas de áudio e HDR com arquivos reais (MKV com 2 faixas, vídeo marcado PQ/BT.2020), `NOT_9X16`/`NOT_16X9`.
- `export-jobrunner.test.js`: todos os perfis com ffprobe (codec, `hvc1`, faststart, áudio, progresso), software e NVENC (se existir, inclusive a queda por falha real), cache de 24 h, bitrate alvo, enquadramento no arquivo, cancelamento (processo morto, nada sobra), conflitos `fail/rename/skip/replace`, `.part` nunca vira resultado, trabalhos simultâneos, legendas e áudio reais (burnIn/audioFilter), módulos ausentes/quebrados, classificação de erros (inclusive o AVERROR sem sinal do Windows e a fonte só de áudio, que não é repetida), aviso de queda do NVENC em português.
- `export-ipc.test.js`: todos os canais com `createContext` e arquivos reais (prévias PNG/JPEG inclusive no último instante do vídeo, `prepare` com QC e faixas de áudio, Jobs rodando no runner, `listProfiles` com `profiles.json` ilegível).
- `tests/e2e/export.e2e.js`: a aba inteira (prévia real, arrasto com o mouse, rodapé por cima dos retângulos, nome "Personalizado" e aviso `NOT_9X16` ao mudar as medidas, QC, Jobs interceptados, fila ausente/recusando, **fila de verdade** gerando os arquivos, reinício, preferências, `profiles.json` ilegível).
- `export-layouts.test.js`: presets de fábrica e suas camadas, **precedência** (corte > layout do corte > padrão do projeto > perfil > app; escolha > sugestão; detector > palpite da IA; interruptor; entradas congeladas; idempotência com o runner), origem de cada Job (`framingSource`), **chave da fila** (`jobKey` e um `QueueManager` de verdade: um corte já exportado no padrão não é pulado quando o layout muda; repetir é pulado; a origem fica no `queue.json`), **ffmpeg real** com amostragem de pixels (Jogo = câmera em cima e jogo embaixo; Conversa = janela no rosto; ajuste de um corte não altera preset nem perfil nem os outros cortes, pixel a pixel; `runExportJob` gera os arquivos certos), o QC da câmera (`CAMERA_RECT`, aviso que nunca bloqueia) e `export:prepare` com `layouts` (inclusive pedido malformado).
- `export-detector.test.js`: o detector (miniaturas fabricadas, vídeo sintético com ffmpeg real, canais `export:layoutRef`/`export:detectLayouts`); a medição com quadros reais de uma live é feita fora do repositório e está em "Detector local de layout".
- `tests/e2e/export-layout.e2e.js`: o interruptor, os chips de origem, a prévia real de Jogo e de Conversa, trocar o layout do corte, personalizar e restaurar, a ação em lote (com a confirmação), "Layouts do canal" (preset com prévia, "deste projeto", voltar ao padrão, salvar como padrão do canal e **herdar em outro projeto do mesmo canal**), os Jobs enviados à fila com a origem, o aviso da câmera, as referências pelo player, a detecção por imagem (vence o palpite errado da IA; incerto não chuta; referências novas invalidam) e nenhum erro de console.

Os mocks ficam só onde o que é externo (espaço em disco; lista de codificadores do ffmpeg para testar "ffmpeg sem libx265"; módulos dos outros recursos para testar ausente/quebrado; resposta do `queue:enqueue` na interceptação).

## Etapa 3 (17/11/2026): pausa, retomada e checkpoints — o que foi investigado

**Pergunta**: dá para pausar e retomar uma exportação **no meio do arquivo**, e com que garantia? Nada foi prometido ao usuário: a tela continua dizendo "recomeça do início".

| Estratégia | Dá retomada exata? | O que exige | Decisão |
|---|---|---|---|
| **Suspender o processo** (`NtSuspendProcess` no Windows, `SIGSTOP`/`SIGCONT` nos outros) | Sim, pausa de verdade (o ffmpeg continua de onde estava, na mesma sessão) | O Node não tem essa chamada: no Windows exigiria PowerShell/P/Invoke ou um módulo nativo. Não sobrevive a fechar o app nem a uma queda. Memória e a sessão do NVENC ficam presas durante a pausa | **Não feito.** Possibilidade futura, só para "pausar por um tempo" |
| **Checkpoints por segmentos** (vídeo em pedaços com quadro-chave no começo de cada um, áudio em uma passada só, junção com `-c copy`) | Sim, **até o último pedaço completo**; sobrevive a queda e a fechar o app | Reescrever o executor: pedaços, áudio à parte, legendas gravadas no vídeo com tempos deslocados por pedaço, validação de cada pedaço (ffprobe) ao retomar, progresso somado, limpeza | **Viável, não feito** (veja abaixo por quê) |
| **Reiniciar** (o que existe) | Não: recomeça do início | Nada | **Mantido** |

**Experimento (ffmpeg real, 60 s de 1080p30 -> vertical 1080x1920, H.264 8 Mbps)**: vídeo em 4 pedaços de 15 s (cada um com quadro-chave no começo, `-force_key_frames expr:gte(t,0)`, `-video_track_timescale 90000`) + áudio AAC em uma passada + `concat -c copy` + mux. Resultado: **1800 quadros nos dois** (inteiro e segmentado), duração 60,000 s nos dois, tamanho +0,6% (60,7 -> 61,1 MB), tempo total sem diferença que importe (28,8 s inteiro; 22,5 s os 4 pedaços; a variação é do computador, não um ganho). Ou seja: **o corte em pedaços não custa qualidade nem sincronia mensuráveis**; o que custa é o código. Pontos de atenção que o experimento não cobriu: o controle de bitrate recomeça em cada pedaço (variação pequena nas emendas), legendas gravadas no vídeo e fades precisam dos tempos de cada pedaço, e o NVENC não foi testado nesse esquema.

**Por que não implementar agora**: os cortes do Braga Frame têm de 15 a 90 s e, no perfil de 1080p, exportam em segundos a poucos minutos; recomeçar do início custa pouco, e a fila já cuida de queda e fechamento (recupera, pergunta e refaz). Checkpoints só valem a pena para exportações longas (minutos a horas), que não são o foco do produto. **Recomendação**: manter o recomeço; se um dia entrarem exportações longas (VOD inteiro), fazer os checkpoints por segmentos, com o experimento acima como ponto de partida. A parte que rende hoje, e foi feita, é **controlar o consumo**: prioridade baixa do ffmpeg, limite de núcleos e espera por memória livre ([queue.md](queue.md), "Limites de processamento").

## Exportar para o editor de vídeo (24/11/2026)

O cartão **Exportar para o editor de vídeo**, no fim da aba Exportar, grava numa pasta escolhida: **XML** (Final Cut Pro 7, "xmeml" v4: o formato que o **Premiere** importa e que o **DaVinci Resolve** também aceita), **EDL** (CMX 3600), **lista de tempos** (`00:00:02.000 -> 00:00:10.500`, a entrada da janela de cortes do Resolve Free) e as **legendas alinhadas à timeline** (`.srt`, `.ass` e o estilo em `.json`). Cada corte (só os aprovados, ou todos menos os rejeitados) é um clipe do vídeo original, na ordem do vídeo e sem vãos, com o título do corte como nome; nada é recodificado e o vídeo não é tocado.

- Código: `src/core/export/timeline.js` (funções puras: plano em quadros, XML, EDL, tempos, legendas), canal `timeline:export` em `src/ipc/handlers/timeline.js`, tela em `renderer/features/export/editor.js`.
- Quadros por segundo, tamanho e áudio vêm do `ffprobe`; início e fim de cada corte vão para o quadro inteiro mais próximo (29,97 usa a base 30 com `ntsc TRUE`). Sem o fps, usa 30 e avisa.
- Legendas: as falas guardadas em cada corte (`cut.subtitles`) são relativas ao início do corte e vão para o tempo da timeline; se o corte mudou de borda depois de gerar a legenda, elas são deslocadas (`basedOn`) e aparadas ao clipe. Cortes sem legenda ficam sem texto, com aviso.
- **O estilo da legenda não viaja** no `.srt` nem no XML/EDL: fica no `.ass` e no `.json` para ser refeito no editor. Para o visual idêntico, a legenda incorporada no vídeo exportado.
- Nada é sobrescrito: se o nome já existe, o conjunto inteiro (e o título da timeline dentro dos arquivos) ganha " (2)", " (3)"…
- Ganho, mudo e fades de áudio de cada corte e o enquadramento vertical não vão para o XML/EDL (a timeline é do vídeo original, na proporção dele).
- Testes: `tests/export-timeline.test.js` (formatos, quadros, legendas), `tests/timeline-ipc.test.js` (gravação, nomes, erros), `tests/e2e/export-editor.e2e.js` (a tela e os arquivos reais).
- **Não verificado**: a importação no Premiere e no Resolve de verdade (não há como abri-los aqui). O XML foi conferido por um leitor de XML e segue a estrutura do xmeml v4 (sequência, trilhas de vídeo e de áudio com `link` entre vídeo e áudio, `file` declarado uma vez); se o editor reclamar, o EDL e a lista de tempos são o caminho alternativo.
