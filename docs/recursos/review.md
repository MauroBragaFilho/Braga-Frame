# Revisão: central de cortes, timeline e histórico

Dono: **review**. Contrato geral em [`docs/arquitetura.md`](../arquitetura.md) (1.3 `BF.*`, 2.2 corte, 3.5 preferências). Este recurso substitui a aba **Cortes** mínima da base e a timeline vazia (`#timelineSlot`), mantendo as decisões e edições manuais já gravadas nos projetos.

## O que faz

**Aba Cortes** (`renderer/features/cuts.js`)

- Lista na **ordem cronológica da live** por padrão (`BF.prefs.get('review.defaultSort', 'chrono')`, lida ao abrir o vídeo) e alterna para **relevância** (sugeridos do mais para o menos relevante; manuais, sem relevância, depois, em ordem cronológica).
- Filtros: estado (chips Todos/Pendentes/Aprovados/Rejeitados com contagem) sempre visíveis; categoria, origem (sugeridos/manuais), "alterados desde a revisão" e "semelhantes" ficam recolhidos em **Mais filtros**.
- **Miniatura** de cada corte (96×54, à esquerda do título): um quadro do vídeo a até 2 s do início do corte, tirado neste computador com o ffmpeg do sistema pelo canal `export:sourceFrame` (o mesmo da prévia do enquadramento; nada de rede). Só as linhas à vista (ou quase) pedem o quadro, no máximo 2 pedidos juntos; fica em memória até outro vídeo abrir, então redesenhar a lista não pede de novo. Sem o quadro (sem ffmpeg, vídeo que não abre) a linha segue sem imagem, só com o ícone.
- Indicadores por corte: **Sugerido/Manual**, **Revisado: aprovado/rejeitado**, **Alterado** (o início ou o fim mudou depois da revisão) e **Semelhante · N** (clique abre o grupo). A categoria também aparece como etiqueta.
- Linha **Exportado** (clique mostra o arquivo na pasta): vale enquanto o início e o fim do corte são os da exportação (`cut.exports[]`, que a fila preenche com `start`/`end`/`revision`). Se o corte mudou depois, a linha passa a dizer **"Exportado (corte alterado depois)"** em cor de aviso, com os dois intervalos na dica; se o usuário voltar ao tempo exportado (por exemplo, desfazendo), ela volta ao normal. Considera só início/fim; áudio, legendas e enquadramento não entram nessa conta (exportar de novo é na aba Exportar).
- **Ajuste de tempo simples**: o corte aberto (o primeiro, até escolher outro; clicar na linha, entrar no título ou "Ver" abre outro) mostra sempre `-1 s`, `-0,1 s`, `+0,1 s`, `+1 s` para início e fim, o tempo editável (`m:ss.d`) e "aqui" (usa a posição do player). Cada mudança incrementa `cut.revision`; se o corte já estava revisado, passa a **Alterado**. A borda para no limite (0, fim do vídeo, ou o outro extremo +0,2 s) em vez de falhar. **Só a borda mexida é arredondada (centésimos) e limitada ao vídeo; a outra segue exatamente como está**, inclusive passando do fim do vídeo (isso é o selo "Fora da fonte", que o usuário resolve; nada é corrigido em silêncio). Se o corte inteiro está depois do fim do vídeo e o usuário mexe só no fim, o ajuste é **recusado com a causa** ("o início já está depois do fim do vídeo, ajuste o início primeiro") em vez de empurrar o início para os 0,2 s finais. A mensagem "limitado ao máximo possível" nomeia a borda realmente limitada. Em lote, "Deslocar" com 0 numa das bordas não toca naquela borda (0/0 não muda nada).
- Aprovar, rejeitar, redefinir, categorizar (livre, com sugestões de `BF.prefs.get('review.categories')` + as categorias já usadas), título, notas e remover (com `BF.ui.confirm`, mesma mensagem da versão da base).
- **Sugestões de título** geradas localmente (categoria, motivos da sugestão automática, jogo/canal do projeto e tempo; sem IA nem rede) em `cut.titleSuggestions[]`. O botão "Sugerir títulos" só guarda as sugestões; **nunca troca o título**. O título digitado pelo usuário é marcado `titleCustom: true` ("personalizado") e trocar por uma sugestão pede confirmação. Título automático (`Corte N`, `Sugestão m:ss` / `Sugestão h:mm:ss` que a análise gera, sugestão guardada ou corte sugerido nunca editado) troca no clique; aprovar ou ajustar o corte não faz esses títulos virarem "personalizado".
- **Cortes semelhantes** (sobreposição/IoU, proximidade e título parecido) com marca de grupo (cor), cabeçalho "N cortes parecidos · motivo" e ação **Manter um…**: escolhe qual manter (padrão: o já aprovado, depois o de maior relevância, depois o mais longo), opção "também aprovar o mantido" e rejeita os demais, tudo como lote com prévia.
- **Seleção** por caixas, **Shift** para intervalo e "selecionar os filtrados". **Lote**: aprovar, rejeitar, redefinir, categorizar, deslocar tempos e remover, **sempre com prévia** (lista antes → depois, o que não muda aparece apagado, avisos por corte), **confirmação** e aviso **Desfazer** (toast).
- **Desfazer / Refazer** globais (botões e, **com a aba Cortes à vista**, `Ctrl+Z` / `Ctrl+Y`; nas outras abas o atalho não mexe nas decisões da revisão: Áudio tem o próprio e Legendas não tem).
- **Digitar não é interrompido**: enquanto o foco está num campo de texto de um corte (título, categoria, notas, tempos) com texto que ainda não é o do corte, a lista **não é refeita** por eventos de fundo (exportação que termina, `cuts:changed` de outros recursos). O redesenho espera o usuário sair do campo (o texto é confirmado uma vez, com o conteúdo inteiro). `prefs:changed` só refaz a lista se trouxer alguma chave `review.*`.
- **Histórico** (recolhido): cada ação é uma entrada (o lote inteiro é uma só; várias criações seguidas de outro recurso também). **Restaurar** volta ao estado de ANTES daquela ação (e das seguintes), com prévia; a restauração vira entrada nova e pode ser desfeita. O histórico fica em `userData/history/<projectId>.json` e sobrevive ao reiniciar.

**Timeline detalhada** (`renderer/features/timeline.js`, botão **Timeline** da aba Cortes; opcional, começa oculta)

- Desenha em `#timelineSlot`: **forma de onda real** (ffmpeg decodifica o PCM; IPC `review:waveform`), régua de tempo, cortes como regiões (manual em azul, **sugerido em roxo**, rejeitado em cinza, aprovado com barra verde embaixo), cabeça de reprodução e uma **visão geral** do vídeo todo para rolar.
- **Zoom/rolagem**: botões − / + / Tudo / Corte, `Ctrl` + roda faz zoom, roda rola, clicar/arrastar a visão geral move a janela. Ao aproximar, a onda é recalculada em alta resolução (detalhe).
- **Clique posiciona** o player (arrastar no vazio faz "scrub"). **Arrastar as bordas** de um corte muda início/fim (valor provisório na tela, grava ao soltar; `Esc` cancela). Passa pelo mesmo caminho dos botões: histórico, revisão (+1), "alterado" e desfazer.
- Sem áudio, sem ffmpeg ou erro: a timeline explica o motivo na própria faixa, continua mostrando as regiões e arrastando bordas.

**Atalhos** (documentados também na aba, em "Atalhos do teclado"): `I` / `O` marcam início e fim na barra do player (clicam nos botões da base); `Espaço` toca/pausa (só com o foco fora de campos, botões e do próprio vídeo); `Ctrl+Z` / `Ctrl+Y` (ou `Ctrl+Shift+Z`) desfazem/refazem **só com a aba Cortes à vista** (painel `#tabpanel-cuts` não escondido). **`J`/`K`/`L` não foram implementados**: o `<video>` do Chromium não tem avanço/retrocesso por tecla confiável e inventar um comportamento aproximado seria pior que não ter.

## Cabeçalho do editor (item Cortes do menu)

No item Cortes o cabeçalho (`renderer/features/shell.js`) troca o título e o caminho do arquivo por **"‹ Projetos › nome do projeto"** e o **estado do projeto** (Novo, Em revisão, Pronto para exportar, Exportado: o mesmo cálculo e os mesmos textos da lista de Projetos, `BF.projects.stateOf`), que acompanha as decisões e exportações. "Projetos" volta à lista; o nome é o do projeto (a dica traz o caminho do arquivo); o título "Cortes" continua no cabeçalho só para o leitor de tela. O botão **Exportar** é a ação principal e abre a aba Exportar (some quando já se está nela; "Abrir vídeo" fica de contorno enquanto ele existe). **Não há botão "Salvar" nem de atualizar**, que o desenho tem: o app salva sozinho a cada mudança. Em janela até 1000 px o "Projetos" vira só a seta, para o nome caber. Testes: `tests/e2e/editor.e2e.js`.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/review/core.js` | Tempos (limites, passos), campos revisáveis, `applyFields`, `reviewState` (revisado/alterado), `exportState` (última exportação e se ficou defasada). **Universal** (Node e renderer) |
| `src/core/review/order.js` | Ordenação cronológica/relevância e filtros. Universal |
| `src/core/review/similarity.js` | IoU, proximidade, título parecido, grupos, `bestToKeep`. Universal |
| `src/core/review/titles.js` | Sugestões locais, `isCustomTitle`, `mergeSuggestions`. Universal |
| `src/core/review/batch.js` | Itens de mudança, planos em lote, descrição antes → depois. Universal |
| `src/core/review/engine.js` | Aplica tudo de forma única (`commit`), eventos, desfazer/refazer, restaurar, coalescência de decisões externas. Universal, sem DOM |
| `src/core/history/log.js` | Grupos/itens do histórico, inversão, plano de restauração. Universal |
| `src/core/history/store.js` | Arquivo `userData/history/<projectId>.json` (só Node): atômico, só acrescenta, `.corrupt`, limite |
| `src/core/review/waveform.js` | Forma de onda com ffmpeg + cache (só Node) |
| `src/ipc/handlers/review.js` | Canais `review:*` |
| `renderer/features/cuts.js` / `.css` | Aba Cortes (interface) |
| `renderer/features/timeline.js` / `.css` | Timeline |
| `tests/review-*.test.js`, `tests/history-store.test.js`, `tests/e2e/review.e2e.js` | Testes |

Os módulos "universais" seguem o desenho de `projects/model.js` (CommonJS no Node, globais `window.BFReview.<módulo>` no navegador). Como o `index.html` é da base, o **`cuts.js` carrega esses arquivos por `<script>` dinâmico** (lista `LOGIC`, na ordem). Se a base passar a incluí-los no `index.html`, o `cuts.js` detecta `window.BFReview.engine` e não carrega de novo. Um teste (`review-renderer.test.js`) garante que a lista cobre todo módulo universal e que eles funcionam sem `module`/`require`.

## Dados e eventos

**Campos que a revisão acrescenta ao corte** (o `normalizeCut` os preserva):

- `titleCustom` (`true` = digitado pelo usuário, `false` = veio de uma sugestão, ausente = desconhecido);
- `reviewedRange` (`[início, fim]` quando foi aprovado/rejeitado; **Alterado** = o tempo atual difere desse). Cortes já revisados antes desta versão ganham a referência na primeira mudança de tempo.

`cut.titleSuggestions` (contrato) guarda até 12 sugestões; `cut.notes`, `category`, `status`, `reviewedAt`, `revision` seguem o contrato. `project.history` (reservado) **não é usado**: o histórico vive em arquivo próprio.

**Eventos `BF.bus`** (todos pelo `engine.commit`, um `cuts:changed` por ação, mesmo em lote):

- `decision { cutId, type, before, after }` com `type` em `approve|reject|reset` (before/after = status), `retitle` (título), `recategorize` (categoria), **`adjust` (before/after = `{ start, end }`)**, `remove` (before = cópia do corte, after `null`), `create` (before `null`, after = cópia). Campos extras, só informativos: `reviewGroup` (id do grupo: todas as decisões de um lote compartilham), `source` (`user`, `batch`, `undo`, `redo`, `restore`) e `label`.
- Desfazer/refazer/restaurar também emitem `decision` (com `source` `undo`/`redo`/`restore`), com o tipo do **resultado** (ex.: desfazer uma aprovação emite `reset`). `create` também sai ao desfazer uma remoção.
- `cuts:changed { ids, from: 'review' }` (ou `'review:inline'` para notas/sugestões).
- `cut:selected { id }` ao abrir um corte (clique na linha, "Ver", entrar no título, clique na etiqueta da timeline); também depois de ajustar um corte, para a barra de marcação do player mostrar o tempo novo.
- Escuta: `decision` de outros recursos (ex.: o `create` de "Salvar corte" da base) vira entrada de histórico e pode ser desfeita; `project:loaded`, `cuts:changed`, `prefs:changed` (se a aba de preferências emitir).
- `review:timeline { open }` (interno: liga o botão Timeline).

`BF.review` (namespace do recurso, usado pela timeline e para testes): `ready`, `engine`, `adjust(id, {start?, end?})`, `select(id, {seek})`, `activeId()`, `history.flush()`, `timeline.{toggle, open, close, isOpen, info, edgePoint, timeToX}`.

## IPC (`src/ipc/handlers/review.js`)

| Canal | Payload | Resposta |
|---|---|---|
| `review:waveform` | `{ sourcePath, buckets?=1000, start?, end?, durationHint? }` | `{ duration, start, end, buckets, secPerBucket, peaks:[0..255], cached, partial, masterPps }` |
| `review:waveformCancel` | `{ sourcePath }` | `{ cancelled }` |
| `review:historyLoad` | `{ projectId }` | `{ groups, dropped, recovered? }` |
| `review:historyAppend` | `{ projectId, groups }` | `{ count, dropped }` |
| `review:historyCopy` | `{ fromProjectId, toProjectId }` | `{ copied, count, reason? }` (nunca sobrescreve) |

Evento do main: `review:waveformProgress { sourcePath, p }`. Erros (`{ ok:false, code, message }`, mensagens em português com causa e solução): `INVALID_ARGS`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_AUDIO`, `WAVEFORM_FAILED`, `CANCELLED`, `HISTORY_WRITE_FAILED`.

**Forma de onda**: `ffmpeg -map 0:a:0 -af aresample=async=1:first_pts=0 -ac 1 -ar 8000 -f s16le` (o filtro põe silêncio no começo quando o áudio só começa depois do vídeo — `start_time` > 0 —, para a onda cair no mesmo eixo de tempo do player; medido: áudio que começa em 2,976 s aparece em 2,98 a 3,99 s) → pico (máximo absoluto, 0..255) a cada 10 ms ("mestre" de 100 picos/s; reduzido por máximo se passar de 3 milhões). Guardado em `userData/cache/waveform/wf-<hash>.bfwf` (chave = caminho + tamanho + data; assinatura `BFW2`: caches antigos `BFW1`, sem o alinhamento, são descartados e refeitos; no máximo 60 arquivos, os mais antigos saem: é só cache). `durationHint` só dimensiona o buffer e o progresso: fora de 0 a 7 dias (ou não numérico) é **ignorado**, sem erro, e o buffer inicial é limitado e criado antes de iniciar o ffmpeg (nada de `RangeError` nem processo órfão). Cada pedido recebe o trecho/resolução pedidos por redução de máximo. Um só cálculo por vídeo mesmo com pedidos repetidos; cancelável; sem resposta do ffmpeg por 2 min = erro. Medido aqui: vídeo de 2 h com áudio AAC (arquivo de 64 MB) em ~5 s, cache de 0,7 MB.

## Decisões provisórias (a confirmar)

- **Critério de "semelhante"** (pendência de produto, à espera da Liz): sobreposição com IoU ≥ 0,4 **ou** o trecho em comum cobre ≥ 70% do menor; **ou** (a ≤ 5 s de distância **e** ≥ 50% das palavras do título em comum, ignorando os títulos que o app gera, "Corte N" e "Sugestão m:ss", que só dizem onde o corte está). Parâmetros em `similarity.DEFAULTS`. Transitivo (A~B e B~C = um grupo).
- **Duração mínima de um corte**: 0,2 s (`core.MIN_LENGTH`).
- **Quem é o "título personalizado" sem a marca** (cortes antigos): título que não é "Corte N" nem "Sugestão m:ss" (os que o próprio app gera), nem sugestão guardada, nem de corte sugerido nunca editado, é tratado como do usuário (prudência). **Decisão provisória:** outro título automático vindo de fora desta lista, depois de o corte ser mexido (aprovado, ajustado), passa a valer como "personalizado" (o seguro: nunca trocar sem perguntar); hoje a análise só gera "Sugestão m:ss".
- **"Manter um"** não aprova o mantido, a menos que a caixa seja marcada.
- **Restaurar** = voltar ao estado de **antes** da ação escolhida (e das posteriores), não só desfazer aquela ação isolada.
- A pilha de desfazer/refazer é **só da sessão**; o histórico em disco é para navegar e restaurar. O histórico guarda no máximo 5000 grupos (os mais antigos saem do arquivo e a interface avisa quantos).
- Notas e sugestões de título **não são decisões** (não geram evento nem histórico).

## Limites conhecidos

- O alinhamento da onda usa o `start_time` do áudio que o ffmpeg informa (relativo ao início do arquivo, como o player). Trecho de áudio mais curto que o vídeo não é preenchido no fim (a onda só termina onde o áudio termina). Verificado só com um MP4 sintético de áudio atrasado (2,976 s); não medido em gravações reais do OBS nem em MKV/TS. O mesmo filtro (`async=1`) também preenche com silêncio buracos de timestamp maiores que 0,1 s no meio do áudio, que é como o player os reproduz; isso não foi testado com um arquivo que tenha buraco.
- A forma de onda usa **a primeira faixa de áudio**. Em gravações do OBS com várias faixas, a faixa 1 costuma ter a mistura; não há seleção de faixa.
- Revisão de lives de muitas horas: o primeiro cálculo lê o arquivo inteiro (depende do disco); depois vem do cache. Não medi com um arquivo real de vários GB (só 2 h sintéticas).
- Desfazer não "refaz" `revision` para baixo (só sobe), de propósito: legendas e exportações usam esse número.
- Dois cortes sobrepostos na timeline: as etiquetas ficam em até 3 linhas; mais que isso se empilham na última.
- Arrastar bordas só alcança bordas visíveis na janela da timeline (aproxime ou role).
- O seletor de ordem não grava a preferência (isso é da aba Preferências).
- Não testado em tela de alta densidade (DPI > 1) nem em Linux/macOS (desenvolvimento em Windows).

## Pedidos de contrato (para `arquitetura.md`)

1. **Seção 1.3, `decision`**: registrar que `adjust` usa `before`/`after` = `{ start, end }`; que existem campos extras opcionais (`reviewGroup`, `source`, `label`) e que desfazer/refazer/restaurar emitem decisões com `source` diferente de `user`/`batch`. Quem aprende com as decisões (**prefs**) deve ignorar ou compensar `source` `undo`/`redo`/`restore` (uma aprovação desfeita não é preferência).
2. **Seção 2.2, corte**: campos opcionais `titleCustom` e `reviewedRange` (dono: review). Quem renomeia cortes (**analysis** ao reanalisar, **sources** ao adotar) **nunca deve trocar o título de um corte com `titleCustom === true`**.
3. **Seção 5 / adoção de projeto**: depois de `project:adopt`, quem adota (sources/prefs/shell) pode chamar `review:historyCopy { fromProjectId, toProjectId }` para levar o histórico (os ids dos cortes são os mesmos); não sobrescreve.
4. **`renderer/index.html` (base), opcional**: incluir `../src/core/review/{core,order,similarity,titles,batch}.js`, `../src/core/history/log.js` e `../src/core/review/engine.js` antes de `features/cuts.js` evita o carregamento dinâmico (o `cuts.js` já aceita os dois jeitos).
5. **Seção 1.3**: `BF.review` é um namespace novo do recurso (veja acima); `BF.prefs.get('review.categories')` deve devolver lista de textos (aceito também objetos com `name`/`label`).
6. **Seção 3.5 (prefs)**: se a aba Preferências mudar `review.defaultSort`/`review.categories` com a aba aberta, emitir `prefs:changed` no `BF.bus` (a revisão redesenha; sem o evento só vale ao reabrir o vídeo). **A revisão só reage a `prefs:changed` cujo `keys` contenha alguma chave `review.*`** (ou venha sem `keys`): quem emitir esse evento precisa manter `keys` correto.
7. **Seção 5.8 (atalhos)**: `Ctrl+Z` / `Ctrl+Y` da revisão valem só com a aba Cortes à vista (a 5.8 diz "Atalhos: … `Ctrl+Z`/`Ctrl+Y`" sem essa condição). `review:waveform`: `durationHint` inválido (fora de 0 a 7 dias) é ignorado.

## Testes

```bash
node --test tests/review-logic.test.js tests/review-engine.test.js tests/history-store.test.js tests/review-waveform.test.js tests/review-ipc.test.js tests/review-renderer.test.js
node tests/e2e/review.e2e.js        # abre o app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
npx eslint src/core/review src/core/history src/ipc/handlers/review.js renderer/features/cuts.js renderer/features/timeline.js tests/review-*.test.js tests/history-store.test.js tests/e2e/review.e2e.js
```

- `review-logic`: tempos e limites (inclusive "só a borda pedida é arredondada e limitada"), "alterado", ordenação, filtros, semelhança (IoU, proximidade, título, grupos, 2000 cortes, sugestões vizinhas da análise sem agrupar), sugestões de título (nunca trocam o personalizado; "Sugestão m:ss" continua automático depois de aprovar), planos em lote e prévias ("sem mudança" x "reconfirmado", deslocar 0/0), `exportState` (selo "Exportado" defasado).
- `review-engine`: aprovar/rejeitar/ajustar/categorizar/renomear/remover com eventos `decision`/`cuts:changed`, lote como grupo único, desfazer/refazer, decisões externas coalescidas, restaurar (inclusive cortes removidos/criados) e desfazer a restauração, histórico do disco.
- `history-store`: gravação atômica, concorrência, limite, `.corrupt`, ids perigosos, cópia.
- `review-waveform`: **ffmpeg real**: vídeo com bipes em instantes conhecidos; os picos aparecem no lugar certo (início/fim do bipe dentro de ~8 ms), áudio atrasado em relação ao vídeo (onda no eixo do player), `durationHint` absurdo, cache (inclusive o de formato antigo), cancelamento, sem áudio, sem ffmpeg.
- `review-ipc`: handlers com `ctx` de verdade e Electron falso.
- `review-renderer`: lista de módulos carregados pelo `cuts.js`, módulos rodando sem `module`/`require`, regras de CSP.
- `e2e/review`: app real, vídeo real: ordem (e `review.defaultSort`), filtros, indicadores, seleção (shift/filtrados), lote com prévia → cancelar/confirmar → **Desfazer** (um grupo e um `cuts:changed`), deslocar tempos, ajuste simples e "alterado" (e borda que não arrasta a outra), categorias/notas/títulos, títulos "Sugestão m:ss" da análise, "Exportado" defasado, semelhantes (manter um), remover, histórico e restaurar, atalhos (Ctrl+Z só na aba Cortes), texto digitado que sobrevive a redesenhos de fundo, timeline (onda real, zoom/rolagem, clique, **arrastar borda com o mouse**, vídeo sem áudio), persistência após reiniciar, e zero erros de console. Também prova que o clique em "Aprovar" não se perde ao digitar o título na mesma linha.
