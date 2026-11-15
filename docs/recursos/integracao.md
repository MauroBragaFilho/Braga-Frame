# Integração entre recursos (comportamento)

Dono: **integrador B**. Este documento registra o que foi verificado e corrigido quando os recursos passaram a funcionar **juntos** (cada um tinha sido testado só pelo próprio lado) e as mudanças de contrato que isso exigiu. Quem consolida o contrato (`arquitetura.md`) deve incorporar a seção "Pedidos de contrato". O contrato geral continua em [`../arquitetura.md`](../arquitetura.md).

## Resultado por ponto

| # | Ponto | Resultado |
|---|---|---|
| 1 | Aprendizado x eventos | **Corrigido.** `prefs.js` classifica cada `decision`: decisão do usuário (`learn`), `undo`/`redo`/`restore` (só corrige o que já era observado) ou nada. `adjust` de áudio (`scope`), de legendas (`what`) e `retitle` não contam; `create` de corte `origin:'auto'` não conta; `adjust` conta só com `start`/`end`. `cut.exports[].profile` chega como **objeto com `id`** (a fila grava o perfil efetivo do trabalho) e o aprendizado lê o `id` (texto também vale). |
| 2 | Preferências x recursos | **Corrigido em parte, resto verificado.** Chaves lidas conferem com o contrato. Faltava reagir à mudança: revisão (ordem padrão), exportação (perfil e enquadramento), fila (`queue.parallel`), análise (margens, durações, relevância, palavras-chave) e legendas (entrega e estilo) agora acompanham `prefs:changed`. A aba Preferências lista os perfis do usuário (`export:listProfiles`, relido a cada vez que a aba aparece). `subtitles.enabled` continua **não lido** (decisão antiga: a legenda é escolha explícita por corte). |
| 3 | Fontes x abertura | **Verificado ok** (ordem) **e corrigido** (`origin.duration`). `sources.js` carrega antes de `prefs.js` no `index.html`, então o `beforeOpen` de Fontes preenche `ctx.origin` antes da pergunta das Preferências; mesmo que a ordem fosse outra, as Preferências consultam `sources:originFor` quando a origem não veio (testado com só o gancho das Preferências) e o gancho das Fontes continua sendo o único que grava `ctx.origin` e guarda o chat/jogo/canal para o `afterOpen`. A comparação de fonte atualizada e a correspondência usam `source.origin.duration` quando falta a duração medida. |
| 4 | Revisão x prefs | **Corrigido.** Selo **"Fora da fonte"** na aba Cortes enquanto `project.ext.prefs.sourceChange` existir e não for dispensado. O `decision` real da revisão (`approve`/`reject`/`reset`/`retitle`/`recategorize`/`adjust {start,end}`/`create`/`remove`, mais `reviewGroup`, `source`, `label`) é o que as Preferências e o histórico esperam; `undo`/`redo`/`restore` não contaminam o aprendizado (ponto 1). |
| 5 | Análise x chat | **Corrigido.** A análise lê pelo `readChat` real e conta mensagens por segundo com `messagesPerWindow(chat, 1, n)` real (síncrona, devolve `number[]`). Testado com um `bf-chat-1` gravado pelo `writeChat` do recurso Fontes. |
| 6 | Exportação x áudio x legendas x fila | **Corrigido (mono).** Fluxo real no app, conferido por fora (ffprobe, volumedetect, pixels). Achado e corrigido: fonte **mono** saía 3 dB mais baixa (o `-ac 2` do ffmpeg duplica o canal com -3 dB), então +6 dB valia +3 dB. |
| 7 | QC x legendas | **Verificado ok**, com um ajuste. Falta de revisão/falas fora do corte são **avisos** (`SUBTITLES_WARNING`, nunca bloqueiam). Sem o libass no FFmpeg a entrega incorporada é **erro** `CODEC_UNSUPPORTED` com causa e solução (a exportação realmente não consegue incorporar; só bloqueia aquele corte), e agora só quando há falas **visíveis** no corte. Arquivo separado nunca depende do libass. |
| 8 | Gravações concorrentes | **Corrigido** (4 problemas reais, abaixo). |
| 9 | Ferramentas x uso | **Verificado ok.** yt-dlp, TwitchDownloaderCLI e whisper registram uso enquanto o processo roda (`tools:remove` e `tools:install {force}` respondem `TOOL_IN_USE`) e liberam no fim. Ordem instalada > `CORTE_*` > PATH vale para as três. |
| 10 | Console limpo | **Verificado ok.** Zero erros e zero avisos de console nas 9 abas, com e sem projeto; nenhum botão visível sem ação; sem projeto só Novo projeto (a antiga Fontes), Exportações, Preferências e Ferramentas funcionam. |

## O que mudou no código

### Aprendizado (ponto 1)
- `renderer/features/prefs.js`: `classifyDecision(ev)`. `learn` = decisão do usuário (`approve`, `reject`, `reset`, `recategorize`, `remove`, `create` manual, `adjust` de tempo); `resync` = `source` `undo`/`redo`/`restore`; o resto é ignorado. Na janela de ~0,4 s, o que o usuário decidiu vale mais que o que foi desfeito/restaurado no mesmo corte.
- `prefs:observe` aceita `onlyKnown: true` (`Preferences.observe`, `LearnedStore.apply`): só atualiza ou retira cortes que **já estavam** observados e nunca cria evidência. Limite conhecido: desfazer a **remoção** de um corte aprovado não devolve a evidência dele (a decisão antiga foi retirada quando o corte saiu).
- `src/core/history/log.js` `itemFromEvent`: `adjust` com `scope`/`what` ou sem `start`/`end` devolve `null`. Antes, cada ganho de áudio ou mudança de legenda virava uma entrada vazia "Ajustou…" no histórico da revisão e ocupava o `Ctrl+Z`.

### Preferências (ponto 2)
- `prefs.js`: lista de `export.profileId` vem de `export:listProfiles` (inclui `user-…`), relida em cada `refreshAll`; cai para a lista do esquema se o canal falhar.
- `cuts.js`: `prefs:changed` com `review.defaultSort` troca a ordem na hora; as categorias sugeridas são relidas a cada desenho.
- `export.js`: `prefs:changed` atualiza perfil e enquadramento enquanto o projeto **não tiver escolha própria** (a escolha do projeto manda).
- `queue.js`: `prefs:changed` com `queue.parallel` chama a sincronização com o processo principal (antes só ao abrir o app, carregar projeto e mostrar a aba).
- `analysis.js`: a tela acompanha `analysis.*`; as palavras-chave só vão para `project.ext.analysis.settings` quando **diferem** das que valem (antes qualquer ajuste congelava a lista e a preferência nunca mais chegava); a nota mostra o valor que a análise usa de fato quando a análise limita a preferência à própria faixa (por exemplo, duração máxima de 300 s vira 180 s) e avisa.
- `subtitles.js`: um corte **sem legenda ainda** mostra (e a legenda nasce com) a entrega e o estilo das Preferências (`defaultSubs()`); antes a tela mostrava sempre "Incorporada" e o estilo padrão até o usuário ligar a legenda.

### Fontes x abertura (ponto 3)
- `src/core/projects/compare.js` exporta `knownDuration(source)` (medida; senão `origin.duration`) e a usa na comparação; `matcher.js` e o cálculo de "chat novo" (`handlers/prefs.js`) também.
- `sources.js` `afterOpen`: depois da conferência do chat, confere que o projeto aberto ainda é o mesmo antes de gravar jogo/canal/chat (um vídeo aberto nesse meio tempo recebia os dados do VOD anterior).

### Revisão (pontos 4 e 8)
- `cuts.js`: selo "Fora da fonte" (`outsideSource(cut)`: `end` passa da duração da fonte + 0,05 s, com `sourceChange` não dispensado), redesenho em `project:changed` com `reason` `prefs:*`.
- `src/core/review/engine.js`: (a) remover um corte leva a cópia **de agora** (não a do evento antigo); (b) desfazer uma **criação** atualiza a cópia guardada no grupo original, para o "refazer" devolver o corte com as legendas, o áudio e as exportações que ele ganhou depois. Antes, Ctrl+Z e Ctrl+Y logo depois de "Salvar corte" devolviam um corte vazio.

### Análise (ponto 5)
- `src/core/analysis/chatSignal.js`: `perSecondCounts(messages, n)` usa `messagesPerWindow(…, 1, n)` do recurso Fontes (cai na contagem própria só se o módulo não existir).

### Exportação (pontos 6 e 7)
- `src/core/export/jobRunner.js`: fonte **mono** passa por `pan=stereo|c0=c0|c1=c0` antes do filtro de áudio (consulta o `ffprobe` do job). Estéreo e outros layouts seguem como sempre.
- `src/core/export/qc.js`: o erro de falta do libass só vale com falas visíveis (`shared.visibleCues`).

### Gravações concorrentes (ponto 8)
1. **Troca de vídeo** (`renderer/features/shell.js`): `BF.openSource` faz `flush()` antes do `source:open` e o projeto novo só assume depois da resposta. O que fosse editado no projeto antigo nesse intervalo (exportação que termina, legenda pronta, um clique) ficava só em memória e se perdia. O `shell.js` lembra o projeto que estava aberto quando a abertura começa e, se ele mudou e foi trocado por outro, grava de novo (`project:save`). Provado com o e2e (sem o patch, a aprovação feita no meio da troca some do arquivo).
2. **Desfazer/refazer de corte criado/removido** (acima, `engine.js`): perdia legendas, áudio e exportações do corte.
3. **Exportação concluída enquanto o corte estava removido** (`queue.js`): a anotação em `cut.exports` não tinha onde cair e só voltava ao reabrir o projeto. Agora a fila reanota (idempotente) a cada `cuts:changed` vindo da revisão.
4. **Abrir um VOD das Fontes e outro vídeo no meio da conferência do chat** (`sources.js`, `afterOpen`): jogo, canal e chat do VOD anterior eram gravados no projeto que acabou de abrir. Agora o gancho confere que o projeto continua o mesmo depois do `await`.

Não houve perda no ciclo normal de gravação: `BF.project.update` muta na mesma volta do laço de eventos, `project:save` é sequencial e o e2e confere que, depois de uma tempestade de 160 operações misturadas (revisão, fila, análise, áudio), o arquivo em disco é idêntico à memória.

## Pedidos de contrato (para `arquitetura.md`)

1. **1.3, `decision`**: `adjust` é **só** ajuste de tempo do corte quando `before`/`after` têm `start`/`end`; Áudio usa `scope:'audio'` e Legendas usa `before.what`/`after.what:'subtitles'`. Campos extras opcionais: `reviewGroup`, `source` (`user`, `batch`, `undo`, `redo`, `restore`), `label`. Quem aprende (prefs) trata `undo`/`redo`/`restore` como correção do que já foi observado, nunca como decisão. `create` com `after.origin:'auto'` (sugestão da análise) não é decisão do usuário.
2. **1.3, `BF.bus`**: `prefs:changed { reason, keys }` é o evento que **todo** consumidor de preferência deve ouvir (revisão, exportação, fila, análise e legendas já ouvem).
3. **2.1, `source.origin.duration`** (extra do tipo `vod`): quando falta `source.duration` medida, vale como duração conhecida na comparação de fonte e na correspondência de lives.
4. **2.2, `exports[].profile`**: é o **perfil efetivo do trabalho** (objeto com `id`, e `name` "… (ajustado)" quando houve ajuste no projeto), não só o id.
5. **3.3, `runExportJob`**: fonte mono sai estéreo com o canal duplicado sem perda (+6 dB pedido = +6 dB no arquivo). `qc.preflight`: o erro de libass só aparece com legenda incorporada **e** fala visível no corte.
6. **3.5, `analysis.*`**: a análise limita cada valor à sua faixa (`analysis:defaults.ranges`); o que está fora da faixa (por exemplo, duração máxima acima de 180 s) a tela avisa. Sugestão ao dono das Preferências: alinhar os limites de `keys.js` aos da análise.
7. **IPC**: `prefs:observe` aceita `onlyKnown` (opcional, booleano).
8. **Base (`app.js`)**: `BF.openSource` deveria repetir `await BF.project.flush()` depois do `source:open` e antes de trocar `BF.state.project` (a rede de segurança do `shell.js` cobre o caso, mas a correção certa é lá). Com o mesmo projeto reaberto (mesmo `id`), uma edição feita nesse intervalo ainda se perde: o projeto vindo do disco substitui o da memória.
9. **1.3, ganchos**: `ctx.origin` de `beforeOpen` é preenchido pelo recurso Fontes (só quando o chamador não informou a origem); quem só precisa **ler** a origem (Preferências) não depende da ordem dos scripts, porque consulta `sources:originFor` quando ela ainda não veio. Quem **grava** `ctx.origin` deve ser só o gancho das Fontes.

## Limites conhecidos e o que não foi verificado

- Desfazer a **remoção** de um corte aprovado não devolve a evidência dele ao aprendizado (veja o ponto 1).
- Mesmo projeto reaberto no meio de edições (mesmo `id`) ainda perde a edição feita entre o `flush` e a resposta do `source:open` (precisa da correção em `app.js`).
- Sem a placa NVIDIA o e2e de exportação usa o codificador por software; com a GTX 1650 o `auto` usou a placa nos testes que rodaram aqui.
- O whisper foi exercitado só com um programa de teste que imita o `whisper-cli` (não se baixou o motor oficial nesta etapa); o uso em `ctx.toolUsage` enquanto o processo roda foi conferido, a transcrição real continua coberta por `tests/subtitles-whisper.test.js` (rede).
- Fontes: a rede real (YouTube/Twitch/GitHub) não foi usada; os VODs e o registro de download do e2e são arquivos locais (`sources.json` escrito pelo teste).
- Linux/macOS não foram executados.

## Testes

```bash
node --test tests/integration-learning.test.js tests/integration-prefs-sources.test.js tests/integration-project-races.test.js tests/integration-analysis-chat.test.js tests/integration-export.test.js tests/integration-tools.test.js
node tests/e2e/integration-export.e2e.js     # app Electron: corte + enquadramento + ganho + legenda -> Fila -> arquivo conferido por fora
node tests/e2e/integration-flow.e2e.js       # app Electron: abas, aprendizado, preferências, Fontes x abertura, gravações concorrentes
npx eslint tests/integration-*.test.js tests/e2e/integration-*.e2e.js
```

- `integration-learning`: o `prefs.js` real ligado aos handlers reais; áudio/legendas/sugestões da análise/`undo`/`redo`/`restore`/tempo/perfil e a abertura de um VOD das Fontes só com o gancho das Preferências carregado (a ordem dos ganchos não importa).
- `integration-prefs-sources`: `knownDuration`, comparação, correspondência, `LearnedStore.onlyKnown`, `prefs:inspect` com ffprobe de verdade e a guarda do `afterOpen` de Fontes.
- `integration-project-races`: o motor de revisão real (criar/remover/desfazer/refazer sem perder dados dos outros recursos; `adjust` de áudio/legendas fora do histórico).
- `integration-analysis-chat`: `writeChat` -> `readChat`/`messagesPerWindow` -> `analyzeSource`.
- `integration-export`: ganho em fonte mono e estéreo com o ffmpeg real; QC de legendas (aviso x erro) com um FFmpeg "sem libass" de verdade (lançador que repassa tudo ao real e esconde o filtro).
- `integration-tools`: ordem de resolução das três ferramentas e `TOOL_IN_USE` com yt-dlp, TwitchDownloaderCLI e whisper (programas de teste, `ctx` e handlers reais).
- `e2e/integration-export`: um corte aprovado, enquadramento livre, +6 dB, legenda manual incorporada, enviado pela aba Exportar à Fila; ffprobe (1080x1920 h264, ~4 s), volumedetect (+6 dB), pixels (centro vindo do retângulo livre; texto branco só na região e no tempo da legenda); arquivo separado (`.srt` ao lado, vídeo sem texto, anterior intacto byte a byte); `.srt` que já existe não é sobrescrito; perfil horizontal (1920x1080); aviso de revisão no QC que não bloqueia.
- `e2e/integration-flow`: console sem erros/avisos e botões com ação em todas as abas (a auditoria usa `getEventListeners` e tem controle negativo); aprendizado com os eventos reais da revisão; preferências reagindo (UI das Preferências); VOD de Fontes reconhecido na abertura; fonte atualizada por `origin.duration`; selo "Fora da fonte"; tempestade de gravações; troca de vídeo; exportação concluída com o corte removido.
