# Fila de exportação (recurso queue)

Contrato: [`docs/arquitetura.md` 3.3 e 3.4](../arquitetura.md). A fila recebe Jobs prontos (montados pelo exportEngine), executa o `runExportJob` real
(`src/core/export/jobRunner.js`), guarda o estado em disco e mostra tudo na tela **Exportações** (a aba `queue`, antes chamada Fila). Ela **não aplica** enquadramento, áudio nem legendas:
só entrega o Job ao executor (a chave de "já exportado" apenas lê esses campos, com as regras dos módulos de áudio e legendas, para saber se o resultado mudaria).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/queue/QueueManager.js` | O gerenciador: estados, concorrência, pausa, reordenação, tentativas, recuperação, conflito, pular concluído |
| `src/core/queue/queueStore.js` | `queue.json`: gravação atômica (tmp + fsync + rename, com repetição no Windows), arquivo corrompido preservado |
| `src/core/queue/jobKey.js` | Chave estável do job e previsão do arquivo de saída |
| `src/core/queue/errors.js` | Classificação (recuperável ou não) e texto em português com causa e solução |
| `src/ipc/handlers/queue.js` | Canais `queue:*`, eventos para o renderer e o `ctx.bus`, `before-quit` |
| `renderer/features/queue.js` / `.css` | A tela Exportações (aba `queue`, ordem 30) e a anotação de `cut.exports` |
| `tests/queue-*.test.js`, `tests/queue-helpers.js`, `tests/queue-e2e-runner.js`, `tests/e2e/queue.e2e.js` | Testes (veja "Testes") |

## Estados

`queued`, `running`, `done`, `failed`, `interrupted`, `cancelled`, `skipped`, `needsAction` (e `paused`, que o contrato lista mas **o job não usa**: a pausa é da fila inteira, veja abaixo).

| Estado | Significa | Como sai |
|---|---|---|
| `queued` | Espera a vez (ou a nova tentativa: `retryAt`) | começa a rodar |
| `running` | O executor está trabalhando (`phase`: `preflight` ou `encoding`) | termina, falha, é cancelado ou interrompido |
| `done` | Concluído; `output` é o arquivo gerado | "Exportar de novo" (explícito) |
| `failed` | Falhou de vez (`error`: `code`, `message`, `solution`, `technical`) | "Tentar de novo" |
| `interrupted` | Parou no meio (app fechado/caiu, ou "pausar e interromper"); **recomeça do início** | volta à fila ao retomar |
| `cancelled` | Cancelado pelo usuário (ou "Descartar" na recuperação) | "Tentar de novo" |
| `skipped` | Pulado, com o motivo em `skippedReason` e o tipo em `skippedCode` (`ALREADY_DONE`, `ALREADY_QUEUED`, `CONFLICT_SKIPPED`) | "Exportar de novo" |
| `needsAction` | Conflito de nome esperando decisão (`conflictPath`) | `queue:resolveConflict` |

## Canais

Todas as respostas seguem `{ ok:true, ... }` ou `{ ok:false, code, message, details? }` (mensagem em português, com causa).

| Canal | Payload | Resposta |
|---|---|---|
| `queue:enqueue` | `{ jobs, force? }` (cada job no formato 3.3; `job.force` também vale) | `{ jobs: [visão], ids: [id] }` na mesma ordem (já com `skipped` quando for o caso). Entrada estruturalmente inválida recusa **tudo** (`INVALID_JOB`). **O `id` do job só é aceito se for seguro** (`/^[A-Za-z0-9_-]{1,64}$/`, fora `all` e nomes reservados do Windows) e livre; senão a fila dá um id novo (use sempre o `id`/`ids` da resposta) |
| `queue:list` | — | `{ jobs, running, paused, parallel, active, blocked, recovery:{pending,jobs:[id]}, loadWarning, saveError, settings }` |
| `queue:pause` | `{ interrupt? }` | `{ paused, interrupting, running }` |
| `queue:resume` | — | `{ paused:false, requeued }` (com recuperação pendente equivale a `queue:recover {action:'resume'}`) |
| `queue:recover` | `{ action:'resume'\|'discard' }` | `{ action, count }` — **canal extra** (banner de recuperação) |
| `queue:cancel` | `{ id }` ou `{ all:true }` ou `{ id:'all' }` | `{ cancelled, stopping }` (`stopping` = em execução, sendo encerrados) |
| `queue:reorder` | `{ ids }` | `{ order }` — só queued/interrupted/needsAction mudam de lugar; ids não citados vão depois |
| `queue:remove` | `{ id }` | `{ removed }` (`JOB_RUNNING` se estiver em execução; nunca apaga o arquivo exportado) |
| `queue:retry` | `{ id }` | `{ job }` — failed/cancelled/skipped/done/interrupted; entra no fim da fila (interrupted mantém o lugar) |
| `queue:clearFinished` | `{ includeFailed? }` | `{ removed }` — remove done, skipped e cancelled; as **falhas ficam** (pedem atenção) |
| `queue:getSettings` / `queue:setSettings` | `{ parallel, retries, recovery, onConflict, defaultParallel? }` (parcial) | `{ settings }` |
| `queue:resolveConflict` | `{ id, action:'rename'\|'replace'\|'skip' }` | `{ job }` |

Eventos (também no `ctx.bus` do processo principal): `queue:update { jobs, running, paused, parallel, active, blocked, recovery, loadWarning, saveError, settings }`
(coalescido, ~40 ms), `queue:progress { id, p, etaSec }` (no máximo 4 por segundo por job), `queue:jobDone { job, output }`, `queue:conflict { job, path }`,
`queue:recovery { jobs }` (emitido ao abrir; pode chegar antes da janela existir: a interface lê `recovery` de `queue:list`).

**Uso pela exclusão de projeto** (aba Projetos; são métodos do gerenciador, não canais; o handler o publica como `ctx.queue`): `activeForProject({ projectId, sourcePath })` devolve os trabalhos do projeto que ainda vão rodar ou estão rodando (`queued`, `running`, `needsAction`, `interrupted`, `paused`) e é o que segura a exclusão (verificação "ocupado" em `ctx.busyChecks`); `forgetProject({ projectId, sourcePath, outputs })` tira da fila os trabalhos **já encerrados** do projeto e do registro de concluídos as entradas dos arquivos que a exclusão apagou (`outputs`), e devolve `{ removed, forgotten }`. Um trabalho é "do projeto" pelo `projectId` ou, na falta dele, pelo vídeo de origem.

**Visão do job** (o que viaja pelo IPC): todos os campos do Job + `key`, `state`, `phase`, `progress`, `etaSec`, `stopping` (`'cancel'|'interrupt'|null`), `runs`, `failures`,
`retryAt` (+ `retryDelayMs`), `output`, `warnings:[{code?,message}]`, `error`, `skippedCode/skippedReason`, `conflictPath`, `cancelReason`, `interruptedBy`, `enqueuedAt/startedAt/finishedAt`.
O `cut` vai **resumido** (`id, title, start, end, revision, category, status`): legendas e histórico de áudio ficam só no `queue.json` e no executor.

## Comportamento

- **Ordem e concorrência**: ordem de entrada; `parallel` de 1 a 4. O ajuste da fila pode ser `null` ("padrão das Preferências"): então vale `queue.parallel` de `BF.prefs` (que já aplica jogo/canal),
  que a aba envia ao main como `defaultParallel` ao abrir, ao carregar projeto e ao mostrar a aba. Baixar o limite não derruba o que roda; subir abre vagas na hora.
  Dois jobs que gravariam o **mesmo arquivo** nunca rodam juntos (o segundo espera; o executor também reserva o destino).
- **Pausa**: `queue:pause` impede novos inícios e o que roda continua até o fim. Com `interrupt:true` os em execução são encerrados (o executor mata o ffmpeg e limpa o `.part`), viram
  `interrupted` e voltam à fila ao retomar. **O ffmpeg não é suspenso: é reiniciado, o trabalho recomeça do início.** Na tela o botão se chama **Pausar fila** (com a dica "Nada novo começa; o que já está
  exportando vai até o fim") para não prometer o que a pausa não faz; os textos para o usuário dizem só "recomeça do início", sem citar o programa (decisão provisória, abaixo).
- **Tentativas automáticas**: `retries` de 0 a 5 (padrão 2 = até 3 execuções), **só** para `FFMPEG_START_FAILED`, `IO_BUSY`, `FFMPEG_CRASH` e `DISK_TRANSIENT`. Espera `2 s × 2^(n−1)`, no máximo 30 s
  (o job fica `queued` com `retryAt`; não ocupa vaga). Qualquer outro código (inclusive desconhecido) vai direto para `failed` com `message` e `solution` (a do executor, `details.solution`, tem prioridade; senão a tabela de `errors.js`).
  Códigos crus do sistema de arquivos são traduzidos (`ENOSPC` → `NO_DISK_SPACE`, `EBUSY`/`EAGAIN` → `IO_BUSY`).
- **Pré-verificação**: `src/core/export/qc.js` (`preflight`) roda antes de cada execução; **erro bloqueia só aquele job** (`failed`, sem nova tentativa) e **aviso não bloqueia** (vai em `warnings`).
  O aviso `NAME_CONFLICT` do QC é ignorado: a fila trata o conflito sozinha. Se o QC em si quebrar, vira aviso e a exportação segue. Antes do QC a fila confere ffmpeg (`NO_FFMPEG`) e o vídeo de origem (`INPUT_MISSING`).
- **Não repetir concluído**: chave (versão 2) = SHA-256 de fonte (caminho + duração + resolução) + início + fim + perfil (sem `name`/`resolutionLabel`) + enquadramento (do job e do corte) + **áudio pelo efeito**
  (o texto do filtro que o motor aplica, `buildAudioFilter(cut.audio, { duration })`: histórico, pilha de "refazer", mudo com ganhos diferentes e fades/ganho acima do limite não mudam a chave; desfazer um ajuste até os
  mesmos valores continua sendo "já exportado") + legendas (só se ligadas: **modo normalizado** — os nomes antigos `srt`/`burn+ass`… valem o mesmo —, estilo completo, texto/tempo dos trechos e, quando há arquivo
  separado, o **formato dele**: SRT e ASS são arquivos diferentes). A versão da chave subiu de 1 para 2: o que foi concluído por versões anteriores deixa de ser reconhecido (um novo envio cai no conflito de nome do arquivo que já existe, nunca sobrescreve).
  Se há concluído com a mesma chave, **na mesma pasta de destino**, e o arquivo ainda existe, o job entra como `skipped`/`ALREADY_DONE`.
  O histórico (`completed` no `queue.json`, até 5000) sobrevive a "Limpar concluídos" e a reabrir o app. Trabalho igual a outro ainda ativo entra como `skipped`/`ALREADY_QUEUED`.
  **"Substituir" invalida o registro do trabalho antigo**: quando um trabalho conclui num caminho que outro trabalho (outra chave) tinha concluído, a entrada do antigo sai de `completed` (o arquivo daquele nome já não é o resultado dele); pedir o trabalho antigo de novo cai no conflito de nome em vez de ser pulado como "Já exportado". Achado pelo teste de sistema (`docs/recursos/sistema.md`).
  "Exportar de novo" (`queue:retry` num pulado ou `force`) refaz de propósito — e, como o arquivo anterior existe, cai no conflito de nome (nada é sobrescrito em silêncio).
- **Conflito de nome**: a política vem de `job.onConflict`; `rename`, `replace`, `skip` e `fail` são obedecidos como vieram. Com `ask` (ou ausente) vale o ajuste **"Se o arquivo já existir"** da fila
  (padrão: perguntar; opções perguntar/outro nome/pular/falhar — **substituir nunca é padrão**, só escolha arquivo a arquivo). Em "perguntar", se o arquivo previsto existe, o job vai para `needsAction` **antes de ocupar vaga**,
  emite `queue:conflict` e espera `queue:resolveConflict`; se a previsão errar, o executor (que recebe `fail` no lugar de `ask`) devolve `OUTPUT_EXISTS` e o efeito é o mesmo. O executor nunca recebe `ask`.
- **Persistência**: `userData/queue.json` (`{ version, savedAt, settings, paused, recovery, completed, jobs }`), gravado a cada mudança de estado (coalescido por ciclo de eventos), de forma atômica com fsync.
  Arquivo ilegível ou de versão mais nova é **preservado** (`queue.json.<ts>.corrupt` / `.vN.bak`), a fila começa vazia e avisa (`loadWarning`). Erro ao gravar não derruba a fila (`saveError` na tela).
  Guarda no máximo 300 registros finalizados (done/skipped/cancelled); os mais antigos saem da lista, não do histórico de concluídos.
  **Arquivo legível, mas com registros ruins** (editado à mão ou de versão antiga) nunca derruba a fila nem o handler: um trabalho que ainda ia rodar e está incompleto (sem pasta de destino, nome, perfil, corte…) vira
  `failed` com `INVALID_STATE`, causa e solução ("Remova-o da lista e envie o corte para a fila de novo"), e `queue:retry` nele responde `INVALID_JOB`; um id que não é seguro é trocado por um novo; e se o conteúdo não puder ser
  interpretado de jeito nenhum, a fila sobe vazia, o arquivo é guardado como `.corrupt` e a tela avisa. Um trabalho com dados impossíveis que escape dessas conferências vira `failed` na hora de iniciar, sem parar o agendador.
- **Pasta de trabalho de cada job** (`<cache>/queue/<id>`): o id é conferido na entrada, ao ler o `queue.json` **e** de novo na hora de criar/apagar a pasta (que precisa ficar direto dentro de `<cache>/queue`);
  o contêiner do perfil não decide o nome do arquivo previsto (sempre `.mp4`, como o motor).
- **Recuperação**: ao abrir, `running` vira `interrupted` (`interruptedBy: 'crash'|'shutdown'`). Se a fila **não** estava pausada pelo usuário: `recovery: 'ask'` (padrão) deixa a fila em espera e mostra o banner
  (Retomar / Descartar); `'resume'` volta tudo à fila sozinho; `'discard'` cancela só o interrompido e segue com o resto. Fechar de novo sem decidir mantém o aviso. Fila pausada pelo usuário continua pausada, sem aviso.
  "Descartar" cancela só os interrompidos (o que estava na fila continua).
- **Fechar o app**: `before-quit` chama `shutdown()`: grava na hora (síncrono), marca o que rodava como `interrupted`, manda parar os processos e **apaga o `.part` do que estava rodando** (o processo sai logo depois e
  o executor não chega a limpar; tenta de novo por uns instantes enquanto o ffmpeg solta o arquivo; vale a mesma regra do `.part` abaixo). O fim assíncrono do executor depois disso não altera o estado.
- **Executor ausente**: `jobRunner.js` e `qc.js` são carregados sob demanda (tentando de novo a cada varredura). Sem o executor os jobs ficam `queued` e a fila mostra `blocked` (com o erro, se o arquivo existir mas não carregar).
- **Cancelamento que o executor ignora**: depois de `abortGraceMs` (20 s) a vaga é liberada, o job vira `cancelled` com um aviso para conferir se sobrou `.part`.
- **`.part`**: o executor é o responsável por apagar; como garantia extra, a fila apaga o `<saída prevista>.part` depois de cancelar/falhar, ao **fechar o app** e também ao **descartar/cancelar/remover um trabalho interrompido** (sobra de uma queda), **só** se ele foi modificado depois do início da execução (`startedAt`) e nenhum outro job usa o mesmo nome. Com "Salvar com outro nome" vale também o numerado (`nome (2).mp4.part`). Um `.part` mais antigo ou de nome que não é de nenhum trabalho da fila nunca é tocado. Se o trabalho for retomado, o executor descarta sozinho o `.part` sem dono.
- **Ferramentas**: a fila só usa `ctx.tools.ffmpeg` (do sistema, via executor), por isso **não** registra uso em `ctx.toolUsage` (ele só vale para whisper/yt-dlp/TwitchDownloaderCLI instalados pelo app).

## A tela Exportações

A aba `queue` (ordem 30, tela larga) aparece no menu como **Exportações** e funciona **sem projeto aberto**. De cima para baixo: o subtítulo "Acompanhe o progresso dos seus cortes e exportações.", os avisos (recuperação com Retomar/Descartar;
"N esperam sua decisão" com Resolver…; executor ausente; arquivo da fila corrompido; erro de gravação) e um cartão com:

- as **pílulas** `Fila (n)`, `Concluídos (n)` e `Falhas (n)`, com as ações ao lado: **Pausar fila/Retomar** (em todas), **Cancelar tudo** (só na Fila, com 2 ou mais ativos, com confirmação) e **Limpar concluídos** (só em Concluídos). Sem trabalho nenhum
  (e sem a fila pausada) as pílulas nem aparecem; a de Falhas ganha cor de alerta quando há falha. A pílula mostrada vale até o app fechar e sobrevive às atualizações da fila; cada uma vazia explica o que aparece nela;
- **Fila**: o que espera ou exporta (`queued`, `running`, `needsAction`, `interrupted`), exportando primeiro, com ↑↓ e arrastar para reordenar e o resumo "Exportando 1 · Na fila 2". **Concluídos**: o que terminou sem erro (`done`, `skipped` e `cancelled`), do mais
  recente ao mais antigo, com "mostrar na pasta" e "tentar de novo". **Falhas**: `failed`, com causa, solução e detalhes técnicos recolhidos (ficam até serem tratadas: não há "limpar" para elas). Um trabalho que muda de estado muda de pílula sozinho;
- o **cartão do trabalho**: ícone do estado, título do corte, "vídeo · intervalo · perfil", selo do estado (sempre em texto; o ícone e a cor só reforçam), barra de progresso com "42% · faltam ~1 min 05 s" no que exporta, nova tentativa com contagem
  regressiva, avisos do executor/QC recolhidos e as ações do estado; a alça de reordenar fica à direita (só no que ainda não começou);
- a **barra de saída**: **Perfil de exportação** e **Destino** do PROJETO ABERTO e o **Limite de fila**. Perfil e destino são os mesmos da aba Exportar (`BF.exportOut` em `renderer/features/export.js`: `summary()`, `ensureProfiles()`, `chooseProfile(id)` e `pickDir()`;
  escolher em um lugar atualiza o outro) e valem para as **próximas** exportações do projeto, não para o que já está na fila; sem projeto aberto esses dois somem e fica só o limite. O destino é cortado pelo começo (a pasta está no fim do caminho; o caminho inteiro
  fica na dica). O limite (`#q-parallel`) é o padrão das Preferências ou de 1 a 4 exportações ao mesmo tempo;
- **Ajustes** recolhido, só com o que não está na barra: tentativas automáticas, o que fazer ao reabrir com exportações em andamento e "se o arquivo já existir".

Com a fila pausada e algo rodando aparece "Interromper os atuais" (com confirmação). O diálogo de conflito (Pular / Substituir… / Salvar com outro nome) tem "fazer o mesmo com os outros N" (nunca para substituir); **Substituir… pede uma segunda confirmação**
(`BF.ui.confirm`); Esc adia todos e o aviso "Resolver…" reabre. O selo da aba mostra a quantidade de ativos.

**Anotar exportações**: em `queue:jobDone`, se o projeto carregado é o do job (`projectId`, ou o caminho do vídeo se vier vazio) e o corte ainda existe, a aba faz `BF.project.update` e acrescenta em `cut.exports`
`{ path, at, start, end, profile, jobId, key, revision }` (idempotente: não repete o mesmo trabalho nem o mesmo arquivo) e emite `cuts:changed { ids, from:'queue:done' }`. Ao carregar um projeto, a aba lê `queue:list` e anota o que terminou
enquanto ele não estava aberto. **Mesmo arquivo gravado por um trabalho mais novo** (o usuário escolheu "Substituir"): a anotação existente é **atualizada no lugar** (perfil, intervalo, chave, `jobId`, `at`) para descrever o que o arquivo contém agora; só vale se o `finishedAt` do trabalho for maior que o `at` da anotação, então a reconciliação (que revê todos os concluídos a cada abertura) nunca troca a anotação de volta para o trabalho antigo.

**Reordenar** (↑/↓ ou arrastar): a tela mostra a ordem nova na hora e cada movimento parte da ordem que o usuário está vendo. Os pedidos `queue:reorder` saem **um por vez**, na ordem dos cliques, e enquanto algum está a caminho
os `queue:update` que chegam são descartados (eles trazem uma ordem anterior ao último movimento e desfariam a tela / perderiam o movimento seguinte); quando o último pedido é respondido a aba recarrega a lista com `queue:list`.
Se um pedido falha, a tela volta ao que o main tem.

## Decisões provisórias

- O estado `paused` **por job** do contrato não é usado; a pausa é uma propriedade da fila (`paused` em `queue:update`/`queue:list`).
- O destino diferente conta como trabalho novo (não é "pulado") — a chave não inclui pasta nem nome, mas a decisão de pular exige a mesma pasta.
- "Limpar concluídos" tira done/skipped/cancelled e **deixa as falhas**. É por isso que a pílula **Concluídos** junta os três (o que terminou sem erro): o botão vale exatamente para o que ela mostra, e as falhas ficam sozinhas na pílula Falhas.
- Do desenho da tela (mockup do dono, 23/10/2026) **não** foram feitos: o botão de pausar/continuar em cada trabalho (a pausa é da fila inteira, como abaixo) e o "5 de 8" (cada trabalho da fila é um corte, um arquivo). O resto — pílulas com contagem, cartões com ícone e
  progresso, alça de reordenar e a barra de perfil, destino e limite — foi feito.
- "Descartar" (recuperação) cancela só os jobs interrompidos; jobs que estavam apenas na fila continuam.
- Valores da espera entre tentativas (2 s, dobrando, máximo 30 s) e o prazo de cancelamento (20 s) são provisórios.
- **Pausa da fila ≠ pausa do trabalho** (decisão provisória, já registrada em `requisitos-e-etapas.md`): continua sem suspender o ffmpeg; o botão se chama "Pausar fila" e a dica diz que o que já exporta vai até o fim. Suspender o processo de verdade
  (NtSuspendProcess no Windows, SIGSTOP/SIGCONT nos outros) e ter um estado "pausado" por trabalho ficou como possibilidade futura: exige código específico de cada sistema e não foi pedido como requisito fechado.
- Id de job fora do padrão seguro (vindo do renderer ou do `queue.json`) é **trocado** por um novo em vez de recusar a entrada inteira: quem usa a resposta de `queue:enqueue` (`ids`) não percebe diferença.
- Trabalho incompleto no `queue.json` que ainda ia rodar vira falha visível (com como resolver), em vez de ser descartado em silêncio.
- `queue.json` guarda o corte completo de cada job (o executor precisa dele); com muitas legendas o arquivo pode crescer (limite de 300 finalizados).

## Limites conhecidos

- O ffmpeg não é retomado de onde parou: interromper = recomeçar do início.
- Fechar o app normalmente apaga o `.part` do que estava rodando (melhor esforço: se o sistema ainda segurar o arquivo, ele sobra). Kill brusco (queda de energia, "encerrar tarefa"): o `.part` do que estava rodando pode sobrar até a próxima execução do mesmo job
  (o executor descarta `.part` sem dono ao reservar o destino) ou até "Descartar"/"Remover" o trabalho interrompido. Um `before-quit` não dispara em kill forçado; nesse caso é o `running` gravado em disco que gera o `interrupted` na próxima abertura.
- A previsão do arquivo de saída usa `naming.sanitizeFileName` do exportador e `.mp4`; se o executor passar a nomear de outro jeito, o conflito ainda é pego pelo `OUTPUT_EXISTS`, mas só depois de iniciar o job.
- Com `parallel` 3 ou 4 e codificação por placa (NVENC), o limite de sessões da GPU pode forçar a queda para software (o executor avisa em `warnings`). Não foi medido o ganho real de paralelizar em uma GTX 1650.
- Escrever o `queue.json` inteiro a cada mudança de estado é síncrono (alguns ms para centenas de jobs).
- O padrão de paralelismo das Preferências só chega ao main quando a aba/projeto/app dispara a sincronização (não há evento de mudança de preferência no contrato).

## Pedidos de contrato (para `arquitetura.md`)

1. **3.4**: acrescentar `queue:recover {action}`; `queue:pause {interrupt?}`; `queue:enqueue {jobs, force?}`; `queue:clearFinished {includeFailed?}`; `queue:setSettings` aceita também `defaultParallel`;
   `queue:getSettings` devolve também `effectiveParallel` e `defaultParallel`; `parallel: null` = "padrão das Preferências"; `queue:update` e `queue:list` trazem `parallel, active, blocked, recovery, loadWarning, saveError, settings`;
   `queue:progress` traz `etaSec`; `onConflict` do ajuste da fila é `ask|rename|skip|fail` (nunca `replace`).
2. **3.4, estados**: informar que o job nunca fica em `paused` (a pausa é da fila). **3.3**: o resultado do executor pode trazer `skipped:true` (o jobRunner atual já traz) e a fila trata como `skipped`.
3. **2.2 (`exports`)**: a fila acrescenta `jobId`, `key` (chave estável do job) e `revision` ao item de `cut.exports` além de `{ path, at, start, end, profile }`. Quem quiser saber "este corte já foi exportado com estas configurações"
   pode comparar com `key`, mas o jeito certo é só enfileirar de novo: a fila pula sozinha (`skipped/ALREADY_DONE`).
4. **exportEngine**: `Job.onConflict: 'ask'` passa a significar "siga o ajuste de conflito da fila" (padrão: perguntar); a fila ignora o aviso `NAME_CONFLICT` do QC (ela mesma pergunta).
5. **prefs**: a fila lê `queue.parallel` por `BF.prefs.get('queue.parallel', 1)`. Se a tela de Preferências mudar o valor, um evento no `BF.bus` (por exemplo `prefs:changed`) faria a fila acompanhar na hora; hoje ela sincroniza ao abrir o app, carregar projeto e mostrar a aba.
7. **5.5, "Não repetir concluído"**: a chave estável (agora versão 2) usa o **áudio pelo efeito** (texto do filtro de `buildAudioFilter`, sem `history`/`redo`) e as **legendas** com modo normalizado e o formato do arquivo separado (`sidecarFormat`); o texto "áudio (sem `history`)" fica incompleto.
   **5.5, `queue:enqueue`**: o `id` do job só é aceito se for seguro (`/^[A-Za-z0-9_-]{1,64}$/`, fora `all`); senão a fila dá um id novo. **exportEngine**: `profile.container` não decide o nome do arquivo previsto (sempre `.mp4`).
6. **base**: a variável `BF_TEST_QUEUE_RUNNER` (caminho absoluto de um módulo com `runExportJob`) só é aceita com `NODE_ENV=test` e `app.isPackaged === false`, no mesmo espírito de `BF_TEST_TOOL_ENTRIES`; só o e2e a usa.

## Testes

```bash
node --test tests/queue-manager.test.js tests/queue-store.test.js tests/queue-ipc.test.js tests/queue-renderer.test.js tests/queue-ui.test.js
node --test tests/queue-integration.test.js     # motor real + ffmpeg de verdade (pula, com motivo, sem ffmpeg ou sem jobRunner/qc)
node tests/e2e/queue.e2e.js                      # abre o app Electron de verdade; BF_E2E_SHOTDIR=<pasta> guarda capturas
npx eslint src/core/queue src/ipc/handlers/queue.js renderer/features/queue.js tests/queue-*.js tests/e2e/queue.e2e.js
```

- `queue-manager`: executor **falso** controlável (só isola o motor), relógio e disco reais: ordem, concorrência (e mudar em execução), pausa/interromper, reordenação, tentativas e backoff, erros não recuperáveis,
  recuperação (queda simulada copiando o `queue.json` com `running`, depois recriando o gerenciador; ask/resume/discard), fechamento (inclui o `.part` apagado), pular concluído (cada parte da chave, áudio desfeito com `redo`, SRT x ASS), conflito (ask→rename/replace/skip, modos fixos, ajuste padrão),
  mesmo arquivo nunca em paralelo, cancelar/remover/limpar/retry, executor que ignora o cancelamento, preflight, ffmpeg/vídeo ausentes, executor ausente, progresso/ETA, validação, **entradas hostis** (ids e contêiner com `../`, pasta alheia intacta),
  **`queue.json` com trabalhos incompletos** ou impossível de interpretar, e textos de erro sem jargão.
- `queue-store`: atomicidade (falha no rename/escrita deixa o arquivo anterior; um **outro processo** lendo durante centenas de gravações nunca vê JSON pela metade), `.tmp` e `.corrupt`, versão nova preservada, erro de gravação.
- `queue-ipc`: ctx real com Electron falso: todos os canais e eventos (clonáveis pelo IPC), erros em português, `before-quit`, reabertura com recuperação, conflito, executor ausente/quebrado, `queue.json` incompleto (o handler carrega mesmo assim), ids hostis pelo canal.
- `queue-renderer`: a feature num `vm` com BF falso (registro da aba, canais usados existem no handler, regras do projeto, anotação idempotente de `cut.exports`, reconciliação, sem projeto, **reordenar rápido com um `queue:update` atrasado** contra um "main" simulado, textos sem jargão).
- `queue-ui`: a feature de verdade num DOM de mentira (`tests/prefs-fakedom.js` + `tests/fakedom-extra.js`): as três pílulas com a contagem e uma lista cada (e o trabalho que muda de pílula), o estado vazio de cada uma, as ações que só valem numa pílula, o cartão de cada estado, a delegação dos botões, e a **barra de saída** (sem projeto, com projeto, perfil e destino nos dois sentidos, limite de fila e a lista de perfis pedida uma vez).
- `queue-integration`: **motor real** (`jobRunner` + `qc`) e ffmpeg de verdade: exportação em ordem com progresso, cancelar mata o processo e limpa `.part`, interromper/retomar, conflitos sem sobrescrever, erros do QC, legenda em arquivo separado (SRT/ASS) com áudio ajustado e a decisão "já exportado".
- `e2e/queue`: o app inteiro, com jobs reais pelo motor real (um wrapper de teste só injeta falhas passageiras nos jobs chamados "instável"): tudo da lista da aba, incluindo queda de verdade (kill do processo) e reabertura.
