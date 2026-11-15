# Áudio (ajustes manuais por corte)

Contrato: [`docs/arquitetura.md` 3.3 e 1.4](../arquitetura.md). Dono: **audio**.

## O que faz

Só **ajuste manual** do áudio de cada corte: ganho em dB (-30 a +20, passo de 0,1), mudo e fade in/out em segundos (cada fade até a metade da duração do corte). **Não existe tratamento automático**: nada de normalização, redução de ruído, compressor ou melhoria de voz (um teste varre o recurso e falha se aparecer qualquer filtro desse tipo).

- **Não destrutivo.** O áudio da fonte nunca é tocado. Os ajustes ficam em `cut.audio` e só valem na exportação.
- **Comparar.** Na aba Áudio, "Original" × "Ajustado" alterna ouvindo o trecho do corte no player. O áudio do `<video>` passa por um `GainNode` da Web Audio API (ganho, mudo e fades de verdade, agendados no relógio do áudio); o arquivo nunca muda. A troca de modo no meio do som usa uma rampa de 15 ms (sem estalo). **O ajuste só soa com a aba Áudio à vista**: nas outras abas (Cortes, "Ver", Legendas…) o player toca o áudio da fonte, para que um corte mudo ou com ganho não pareça um vídeo sem som para quem está revisando.
- **Desfazer/refazer, histórico por corte, restaurar uma entrada e "Voltar ao original"** (que também fica no histórico e se desfaz). Com a aba Áudio à vista, **Ctrl+Z**, **Ctrl+Y** e **Ctrl+Shift+Z** (Cmd no macOS) valem para o ajuste de áudio do corte escolhido; em campo de texto vale o desfazer do próprio campo e, sem nada a desfazer, a barra de status diz isso (o atalho nunca "escorrega" para a revisão). A barra de status conta o que aconteceu: "Desfeito: Ganho +6 dB.", "Refeito: …", "Restaurado: …".
- **Informações, nunca bloqueios.** Medição real do trecho (`audio:measure`, ffmpeg `volumedetect`: pico e média em dB) e avisos: possível distorção quando ganho + pico passa de 0 dB; fonte sem faixa de áudio; valor limitado (ganho fora de -30..+20, fade maior que a metade do corte). O app **não corrige nada sozinho**: o valor gravado é o que o usuário digitou; o limite só é aplicado (e avisado) na exportação. Todo texto da tela é pt-BR, com vírgula decimal ("O fade in de 0,5 s passa da metade do corte; a exportação usa 0,15 s.").
- **Medição só com a aba à vista, sempre do corte certo.** A aba só pede a medição ao ffmpeg quando está aberta (selecionar cortes ou ajustar tempos pela aba Cortes não chama o ffmpeg; ao abrir a aba mede o corte atual). A medição guardada na tela tem a chave "arquivo + início + fim": ao trocar de corte (ou o trecho mudar) o valor do corte anterior some na hora e dá lugar a "Medindo o trecho…"; uma resposta que chega depois que o usuário já está em outro corte é ignorada na tela (fica no cache em memória, para quando ele voltar).
- **Tela limpa.** Seletor de corte, Original/Ajustado + "Ouvir trecho", ganho (controle deslizante + campo), mudo, dois fades, linha de medição, Desfazer/Refazer/Voltar ao original. Histórico e "Como será exportado" (o filtro do FFmpeg) ficam recolhidos em `<details>`. Sem corte selecionado a aba diz o que fazer (e, sem cortes no projeto, também).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/audio/audioFilter.js` | **Universal** (CommonJS no main; `window.BFAudioFilter` no renderer). `buildAudioFilter`, `resolveAudio`, `normalizeAudio`, `maxFadeSec`, `LIMITS`, `envelopeAt`/`envelopePoints` e `previewPlan` (a mesma matemática do filtro serve a prévia) |
| `src/core/audio/audioHistory.js` | **Universal** (`window.BFAudioHistory`). Histórico puro: `applyChange` (com junção de mexidas contínuas), `undo`, `redo`, `restoreEntry`, `resetToOriginal`, `historyOf`/`redoOf`, `canUndo`/`canRedo` |
| `src/core/audio/measure.js` | `measureAudio({ ffmpeg, sourcePath, start, end, signal?, timeoutMs? })` (somente leitura; sem arquivo de saída); `describeReadFailure`/`describeStartFailure` (causa e solução em português das falhas do ffmpeg) |
| `src/ipc/handlers/audio.js` | Canal `audio:measure` (com cache em memória por arquivo+tamanho+data+trecho) |
| `renderer/features/audio.js` / `.css` | A aba |
| `tests/audio-*.test.js`, `tests/audio-fixtures.js`, `tests/audio-tab-fixtures.js`, `tests/e2e/audio.e2e.js` | Testes (ffmpeg e Electron de verdade; `audio-tab-*` roda a aba real num contexto isolado com DOM, Web Audio e relógio falsos) |

A aba carrega `audioFilter.js` e `audioHistory.js` sozinha (injeta dois `<script>` em tempo de execução, aceitos pela CSP porque são do próprio app). Se a base preferir, pode acrescentar os dois `<script src="../src/core/audio/...">` ao `index.html` antes de `features/audio.js`: o carregador pula o que já estiver carregado.

## Contrato com a exportação (3.3)

```js
const { buildAudioFilter, resolveAudio } = require('../audio/audioFilter');
const af = buildAudioFilter(cut.audio, { duration: cut.end - cut.start });   // string | null
const { warnings } = resolveAudio(cut.audio, { duration });                   // limites aplicados -> avisos
```

| Ajuste | Filtro |
|---|---|
| nenhum | `null` (sem `-af`) |
| mudo | `volume=0` (ganho e fades são ignorados) |
| ganho | `volume=<dB>dB` |
| fade in | `afade=t=in:st=0:d=<s>` |
| fade out | `afade=t=out:st=<duração - s>:d=<s>` |

- `duration` é **obrigatório para o fade out** (sem ele, o fade out é omitido com o aviso `FADE_OUT_NEEDS_DURATION`).
- O filtro supõe que o áudio do corte começa em t=0 (`-ss <início>` **antes** do `-i`, como a exportação faz). Se um dia o corte for feito depois da entrada, passe `offset: cut.start`.
- Códigos de aviso de `resolveAudio`: `GAIN_LIMITED`, `FADE_IN_LIMITED`, `FADE_OUT_LIMITED`, `FADE_OUT_NEEDS_DURATION`.
- A exportação atual (`src/core/export/jobRunner.js`) já usa exatamente isso; o teste "áudio real" dela passa com este módulo.
- A medição usa a primeira faixa de áudio (`-map 0:a:0?`), a mesma que a exportação mapeia.

## Dados no projeto

```js
cut.audio = {
  gainDb, mute, fadeInSec, fadeOutSec,                 // valores em vigor
  history: [{ at, label, before, after }],             // aplicadas, da mais antiga à mais nova (máx. 50)
  redo: [{ at, label, before, after }]                 // desfeitas (campo extra; some quando vazio)
}
```

`before`/`after` são os quatro valores. `redo` é um campo extra dentro de `cut.audio`: o `normalizeCut` já preserva campos desconhecidos. Mexidas seguidas no **mesmo** campo em até 1,2 s (arrastar o controle, setas do teclado) viram uma entrada só; se a mexida volta ao ponto de partida, a entrada some. Uma mudança nova descarta o `redo`. Restaurar uma entrada cria uma entrada nova ("Restaurado: …"), então também se desfaz.

Eventos: cada mudança (inclusive desfazer/refazer/restaurar/voltar ao original) chama `BF.project.update` (`reason: 'audio:adjust'`), emite `cuts:changed { ids, from: 'audio:adjust' }` e `decision { cutId, type: 'adjust', scope: 'audio', before, after }`, com `before`/`after` = `{ gainDb, mute, fadeInSec, fadeOutSec }`.

## IPC

| Canal | Payload | Resposta |
|---|---|---|
| `audio:measure` | `{ sourcePath, start, end }` | `{ ok, hasAudio, peakDb, meanDb, samples, start, end, cached }` |

`peakDb` é o pico de amostra (`max_volume`), não o "true peak": picos entre amostras podem ser um pouco maiores. `hasAudio:false` (fonte sem faixa de áudio) e `peakDb/meanDb:null` (trecho depois do fim do áudio) são resultados normais, não erros. Erros (`{ ok:false, code, message, details? }`, em português com a solução): `NO_FFMPEG`, `INVALID_PATH`, `INVALID_RANGE`, `INPUT_MISSING` (só aceita arquivo local existente), `MEASURE_FAILED`, `MEASURE_TIMEOUT` (5 min), `CANCELLED`. O ffmpeg em andamento é encerrado em `before-quit`.

`MEASURE_FAILED` nunca mostra o texto cru do ffmpeg (inglês) na tela: a `message` traz a causa provável e o que fazer (arquivo corrompido ou incompleto, sem permissão/em uso, arquivo que sumiu, formato de áudio que o ffmpeg não reconhece, ou o ffmpeg que não inicia), por exemplo "O ffmpeg não conseguiu ler o áudio deste trecho: o arquivo parece corrompido ou incompleto (…). Confira se ele abre no player; …". O texto original fica em `details` (`{ exitCode, ffmpeg (última linha), stderr }`, ou `{ cause }` quando o processo não iniciou). A medição não tem canal de cancelamento: trocar de corte não interrompe o ffmpeg em andamento (ele termina sozinho; a tela ignora a resposta e o resultado fica no cache do handler e da aba).

## Prévia (Web Audio)

- O `GainNode` é criado **sob demanda** (ao ouvir o trecho, ao gravar um ajuste ou ao escolher um corte que já tem ajuste **com a aba Áudio à vista**; selecionar um corte ajustado pela aba Cortes não mexe no áudio do player) e liga `MediaElementSource(video) → GainNode → AnalyserNode → destino`. A ligação não se desfaz: depois dela o elemento soa pelo grafo (volume e mudo nativos do player continuam funcionando). Sem Web Audio, o botão Original/Ajustado fica desabilitado com o motivo, e a exportação segue aplicando os ajustes.
- Dentro do corte vale o envelope; fora dele, no modo "Original" e **com outra aba aberta** o som passa como está. Ao sair da aba o ganho volta a 1 na hora (um observador do atributo `hidden` do painel; se ele não existir, o próximo `timeupdate`/`playing` do player faz o mesmo). Depois do fim do corte o último valor é mantido por 0,3 s (o player para um pouco depois do fim; sem isso o som cheio vazaria num estalo).
- `BF.audioPreview = { state(), level(), setMode(mode), nodes() }`: `state()` informa `usesGainNode`, `gain` atual e `contextState`; `level()` lê o nível real (RMS/pico, dBFS) do que sai do player. Um `<video>` só aceita **um** `MediaElementSource`: quem precisar do áudio do player deve reutilizar `BF.audioPreview.nodes()`.

## Decisões provisórias

- Passo de 0,1 dB no ganho e nos fades; limites -30..+20 dB e metade da duração por fade (do briefing da tarefa).
- "Voltar ao original" zera os quatro valores (não apaga o histórico).
- O histórico mostra só entradas aplicadas; o que foi desfeito fica no `redo` (acessível por Refazer).
- A medição não é gravada no projeto (só em memória) para não ficar velha quando o trecho mudar.
- **Prévia ajustada só na aba Áudio (provisório).** Antes, um corte mudo ou com ganho tocava ajustado em qualquer aba, sem nenhuma indicação, e quem revisava pelo "Ver" achava o vídeo sem som. O comportamento mais seguro foi escolhido: fora da aba Áudio o player toca a fonte. A alternativa (ajustado em todo lugar com um selo "Áudio ajustado"/"Mudo" perto do player) exigiria mexer na aba Cortes e no player, que são de outros donos; a decidir com a Liz.
- **Ctrl+Z / Ctrl+Y na aba Áudio sempre são do áudio (provisório).** Mesmo sem nada a desfazer o atalho é consumido (com um aviso na barra de status): assim ele nunca desfaz uma decisão da revisão que está escondida. A aba Cortes também só trata o atalho quando está à vista (correção do dono da revisão); as duas proteções se somam.

## Limites conhecidos

- **Várias faixas de áudio** (OBS com faixas separadas de jogo e microfone): medição e exportação usam só a primeira faixa; a prévia toca o que o Chromium decodifica do arquivo (normalmente também a primeira). Escolher a faixa fica para uma etapa futura.
- A prévia usa o decodificador do Chromium: se o vídeo não toca no player (ex.: alguns HEVC/MKV), não há prévia; a medição e a exportação (ffmpeg) funcionam.
- Os fades da prévia são agendados no relógio do áudio e ressincronizados se o vídeo sair do passo (mais de ~0,12 s); entre o vídeo e o som pode haver uma diferença de algumas dezenas de ms (latência do dispositivo), sem efeito na exportação.
- Nenhum teste automático ouve o som: o e2e lê o nível real de um `AnalyserNode` (e roda com `--mute-audio`, que silencia só a saída). A impressão auditiva (estalos, naturalidade dos fades) não pôde ser verificada por ouvido.
- A medição de um corte muito longo (centenas de MB) ocupa o ffmpeg até o fim mesmo que o usuário já tenha trocado de corte (sem canal de cancelamento, veja IPC); o limite é de 5 min por medição.
- Linux/macOS não foram executados (desenvolvimento em Windows). O teste que cancela o ffmpeg de verdade no meio da leitura usa um named pipe do Windows e é pulado nos outros sistemas.

## Pedidos de contrato (para `arquitetura.md`)

1. **3.3**: a assinatura real é `buildAudioFilter(audio, { duration, offset? })` (o texto atual diz `buildAudioFilter(audio)`). O módulo também exporta `resolveAudio(audio, { duration })` (avisos de limites), que a exportação já usa.
2. **2.2**: `cut.audio` pode ter o campo extra `redo` (pilha de refazer, mesmo formato de `history`). Quem copia/normaliza cortes deve preservar campos desconhecidos (o `normalizeCut` já faz).
3. **1.3 / eventos**: `decision` com `type: 'adjust'` também é emitido pelo áudio, com `scope: 'audio'` e `before`/`after` = `{ gainDb, mute, fadeInSec, fadeOutSec }`. O módulo de revisão/aprendizado (que usa `adjust` para ajuste temporal, com `start`/`end`) precisa checar `scope` ou ignorar `before.start === undefined`.
4. **1.3**: `BF.audioPreview` (acima) e a regra "um `<video>` só aceita um `MediaElementSource`".
5. **1.1**: canal `audio:measure` e seus códigos de erro.
6. **Opcional (base)**: acrescentar ao `index.html`, antes de `features/audio.js`, `<script src="../src/core/audio/audioFilter.js">` e `<script src="../src/core/audio/audioHistory.js">` (hoje a aba os carrega sozinha).
7. **5.8 / 5.6 (atalhos)**: com a aba Áudio à vista, `Ctrl+Z`, `Ctrl+Y` e `Ctrl+Shift+Z` (Cmd no macOS) são do áudio: a aba registra um ouvinte de `keydown` na captura do `document` que chama `preventDefault()`, e o atalho da revisão (`cuts.js`) já respeita `event.defaultPrevented` e também só age com a aba Cortes à vista. Quem criar atalhos globais novos deve conferir `defaultPrevented` e a aba à vista.
8. **1.3 (`BF.audioPreview`)**: `state().gain` e o som do player só refletem o ajuste com a aba Áudio à vista; nas outras abas o ganho do grafo é 1 (o grafo só é criado ao usar a aba Áudio).
9. **5.5 (fila)**: a chave "não repetir concluído" não pode depender de `cut.audio.history` nem de `cut.audio.redo` (desfazer/refazer mexem nos dois sem mudar o som). Hoje a chave usa o filtro de áudio (`buildAudioFilter`); `tests/audio-queue-key.test.js` guarda isso com o histórico real.
10. **1.1 (`audio:measure`)**: respostas de erro podem trazer `details` (`{ exitCode, ffmpeg, stderr }` ou `{ cause }`), só para diagnóstico; a `message` já é pt-BR com a solução.

## Testes

```bash
node --test tests/audio-filter.test.js tests/audio-measure.test.js tests/audio-history.test.js tests/audio-ipc.test.js tests/audio-renderer.test.js tests/audio-tab.test.js tests/audio-queue-key.test.js
node tests/e2e/audio.e2e.js            # abre o app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
npx eslint src/core/audio src/ipc/handlers/audio.js renderer/features/audio.js tests/audio-*.js tests/e2e/audio.e2e.js
```

- `audio-filter`: texto do filtro (limites, fades, mudo, offset, duração ausente) e **ffmpeg real**: +6 dB mede +6 dB, -10 dB, +2,5 dB, mudo abaixo de -80 dB, fade in/out (início e fim ~19 dB abaixo do platô), fades acima do limite cortados na metade, corte depois da entrada com `offset`, MP4+AAC; hash da fonte igual depois de tudo; plano de automação da prévia simulado contra o envelope (inclusive mutação conferida).
- `audio-measure`: pico/média reais, trecho depois do fim, sem áudio, caminho com acento, várias faixas, tempo limite; erros em português com causa e solução (arquivo que não é mídia, MP4 truncado, arquivo que sumiu, ffmpeg que não inicia, cada causa classificada) sem nenhuma palavra do inglês do ffmpeg na mensagem; **cancelamento no meio da leitura com o ffmpeg de verdade** (fonte num named pipe do Windows que para de responder: `CANCELLED` e o processo termina).
- `audio-history`: entradas `{at,label,before,after}`, junção de mexidas, desfazer/refazer, limite de 50, restaurar, voltar ao original, lixo no arquivo, round-trip pelo `normalizeCut`.
- `audio-ipc`: handler com `ctx` de verdade (validações, cache, troca de arquivo invalida, fonte sem áudio, fonte intocada); `before-quit` com uma medição em andamento (processo de mentira que nunca termina): os pedidos respondem `CANCELLED` e o processo morre (sem o `abort` o teste falha).
- `audio-renderer`: contratos da aba (id/ordem, CSP, só BF.*), carregamento dos arquivos universais como `<script>` comum, varredura contra tratamento automático e contra escrita em disco.
- `audio-tab` (+ `audio-tab-fixtures.js`): a aba real (`renderer/features/audio.js`) num contexto `vm` com as regras reais, DOM/Web Audio/relógio falsos: medição de um corte nunca aparece em outro (resposta atrasada, cache, trecho que mudou, falha), nenhum ffmpeg com a aba escondida, prévia ajustada só com a aba à vista (corte mudo), Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z, textos da barra de status.
- `audio-queue-key`: o histórico real (`undo`/`redo`) não muda a chave da fila quando o som exportado é o mesmo.
- `e2e/audio`: aba pela interface (sem projeto, sem cortes, sem seleção, seletor), medição na tela = ffmpeg, ganho (arrastar não grava; soltar grava), `GainNode` real com níveis lidos do `AnalyserNode` (Original × Ajustado = +6 dB, mudo = silêncio, fades subindo/descendo), aviso de distorção, limites, histórico/desfazer/refazer/restaurar/voltar ao original, 50 entradas, o mesmo filtro aplicado pelo ffmpeg = prévia, **Ctrl+Z/Ctrl+Y reais** (teclas enviadas ao app), textos da barra de status, persistência após reiniciar, **exportação pelo fluxo real (aba Exportar → Fila) com o arquivo medido** e reenfileirar depois de desfazer (a fila pula o que já foi exportado), **corte mudo tocado pela aba Cortes soa como a fonte**, **nenhuma medição com a aba Cortes aberta**, **medição de cada corte sem mistura mesmo com uma resposta retida e entregue depois** (fonte de dois níveis), fonte sem áudio, hash da fonte, nenhum erro de console.
