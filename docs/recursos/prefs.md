# Preferências, aprendizado e correspondência de projetos

Dono: **prefs**. Contrato geral em [`docs/arquitetura.md`](../arquitetura.md) (1.3 `BF.prefs`, 2.3 armazenamento, 3.5 preferências). Este recurso substitui a aba **Preferências** (stub da base) e o `BF.prefs` mínimo do `app.js`.

## O que faz

1. **Preferências em três escopos** — geral, por **jogo** e por **canal/criador** — com a regra **canal > jogo > geral** (a mais específica vence, chave por chave). `BF.prefs.get` é síncrono e `BF.prefs.explain(key)` diz de onde veio o valor.
2. **Aprendizado** com as decisões do usuário (evento `decision`): propõe preferências por escopo, cada uma com **evidência legível**, e só as faz valer depois de **N cortes de evidência** (padrão 5). Tudo é visível na aba, editável, desativável (cada item e a chave geral "Aprender com minhas decisões") e **desfazível** pelo histórico.
3. **Correspondência com lives já analisadas**: ao abrir um vídeo, se parece uma live que já tem projeto, pergunta ("Parece a live X, já analisada (N cortes)": **Abrir o projeto existente / Criar novo / Cancelar**). Nunca abre sem confirmar; "abrir o existente" copia cortes e decisões para o arquivo novo (`project:adopt`) sem alterar o original.
4. **Fonte atualizada**: ao abrir um vídeo que já tem projeto mas cuja duração/tamanho mudou (VOD que cresceu, arquivo regravado), mostra a diferença e só segue depois da confirmação; decisões e ajustes são preservados e os cortes que ficam fora do novo intervalo são **sinalizados, nunca apagados**. O mesmo vale quando a live parecida está em **outro arquivo** (o VOD baixado de novo cai num nome "(2)"): a pergunta de 3 saídas já mostra a diferença e, ao abrir o existente, a mudança de fonte é gravada.
5. **Aba Preferências** limpa: jogo e canal do projeto (com sugestões), seletor Geral/Jogo/Canal, lista de preferências com controles simples e o selo de origem, seção "Aprendido com suas decisões", histórico e avançado recolhidos.

A aba funciona **sem projeto aberto** (valores gerais, aprendizado e histórico continuam editáveis).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/preferences/keys.js` | Chaves reconhecidas (3.5) com padrão, tipo, limites, textos; `validate`, `formatValue`, regra mín ≤ máx |
| `src/core/preferences/scope.js` | Escopos (`general`/`game`/`channel`), normalização de nomes (sem acento/caixa), `projectScopeNames` |
| `src/core/preferences/atomic.js` | Gravação atômica (tmp + fsync + rename, com tentativas no Windows) e leitura que preserva arquivo ilegível como `.corrupt` |
| `src/core/preferences/learning.js` | Funções puras: das observações às propostas por escopo, com evidência |
| `src/core/preferences/learnedStore.js` | `userData/learned.json`: estado atual de cada corte decidido, por projeto |
| `src/core/preferences/index.js` | `Preferences`: resolução, edição, aprendizado (itens, estados), histórico e reverter; `userData/preferences.json` |
| `src/core/preferences/format.js` | Textos pt-BR (duração, tamanho, plural) |
| `src/core/projects/matcher.js` | Correspondência forte/média/fraca sobre `projectStore.list()` |
| `src/core/projects/compare.js` | Comparação de fonte atualizada (`compareSource`, `describeComparison`) |
| `src/ipc/handlers/prefs.js` | Canais `prefs:*` (inclui `prefs:inspect`, usado pelos ganchos) |
| `renderer/features/prefs.js` / `.css` | `BF.prefs`, aba Preferências, ganchos `beforeOpen`/`afterOpen`, observação de `decision` |
| `tests/prefs-*.test.js`, `tests/prefs-helpers.js`, `tests/prefs-fakedom.js`, `tests/e2e/prefs.e2e.js` | Testes |

## Preferências

### Chaves (contrato 3.5) e validação

`export.profileId` (`vertical-1080-h264`), `export.framing.mode` (`center`|`blur`|`stack`|`custom`), `analysis.minRelevance` (0,5; 0 a 1), `analysis.minDurationSec` (15; 3 a 120), `analysis.maxDurationSec` (60; 5 a 180), `analysis.padBeforeSec` (3; 0 a 60), `analysis.padAfterSec` (2; 0 a 60), `review.defaultSort` (`chrono`|`relevance`), `review.categories` (lista, até 30 itens), `queue.parallel` (1; 1 a 4), `subtitles.enabled` (false; "Ligar a legenda nos cortes novos"), `subtitles.mode` (`burn`|`sidecar`|`both`), `subtitles.style` (objeto, até 4 KB; definido pelo botão "Usar esta aparência nos próximos vídeos" da aba Legendas). Acrescentadas **`analysis.keywords`** (lista de palavras-chave do chat; já é lida por `renderer/features/analysis.js`) e **`analysis.humor`** (o **perfil de humor do canal**: objeto `{ criteria, catchphrases, reactions, examples }` de até 16 KB, avançado, herdado canal > jogo > geral, sem aprendizado; é **editado na aba Análise**, cartão "Perfil de humor do canal", e `keys.validate` o normaliza ao gravar com as regras de `src/core/analysis/humor.js` e recusa o perfil vazio; em Preferências, "Mais ajustes", aparece como "definido na aba Análise" e pode ser removido; docs/recursos/analise-ia.md, seção 16).

**Faixas iguais às da análise.** As faixas de duração e de margem são as MESMAS de `RANGES` em `src/core/analysis/params.js` (`keys.js` as lê de lá; sem o módulo valem os mesmos números), então o valor que aparece em Preferências é o que a análise usa de fato (antes aceitava 1 a 600 s e a análise cortava em 3-120 e 5-180 sem avisar; um teste confere que as duas continuam iguais). Um valor antigo fora da faixa, escrito à mão ou de uma versão anterior, é ignorado (vale o padrão).

**Nenhuma preferência sem leitor.** Toda chave do catálogo é lida por alguma aba (`subtitles.enabled` e `subtitles.style` passaram a ser lidas pela aba Legendas: a caixa "Legendar este corte" de um corte sem legenda nasce com `subtitles.enabled`, e o botão "Usar esta aparência nos próximos vídeos" grava `subtitles.style`). `tests/prefs-keys.test.js` varre o código e falha se uma chave do catálogo ficar sem quem a leia. O texto da linha diz o que ela faz: `subtitles.enabled` só liga a caixa do corte, **não gera falas**.

Chave desconhecida, valor fora do limite ou tipo errado voltam como `{ ok:false, code, message }` em português (`UNKNOWN_KEY`, `INVALID_VALUE`, `INVALID_SCOPE`). Número em texto só vale com dígitos e vírgula ou ponto decimal (`"4,5"`, `"0.7"`); `"0x1"`, `"1e-1"` e `"Infinity"` são recusados (a tela usa campo numérico, mas `BF.prefs.set` aceita qualquer coisa). A duração mínima não pode passar da máxima (e vice-versa) no mesmo escopo; se o conflito vier de escopos diferentes vira **aviso** na resolução (`warnings`), não erro. Valor inválido escrito à mão em `preferences.json` é ignorado (vale o padrão) e chaves desconhecidas do arquivo são preservadas.

### Prioridade (decisão PROVISÓRIA, a confirmar com a Liz)

Para cada chave, na ordem: **canal** (valor do usuário, depois o aprendido) → **jogo** (idem) → **geral** (idem) → padrão. No mesmo escopo o valor do usuário vence o aprendido; um aprendido mais específico vence um valor do usuário mais geral (a especificidade vem primeiro). Se a Liz decidir outra ordem, a mudança é só em `Preferences.resolve` (`src/core/preferences/index.js`) e na tabela de testes de `tests/prefs-store.test.js`.

Jogo e canal do projeto vêm de `project.meta` e, na falta, de `source.origin.game/channel` (nunca grava `meta` sozinho). Nomes ignoram acento, caixa e espaços repetidos.

### `BF.prefs` (renderer)

| Função | O que faz |
|---|---|
| `get(key, fallback)` | Valor em vigor, síncrono. Se nada do usuário/aprendido vale, devolve o `fallback` de quem pergunta (senão o padrão do contrato) |
| `resolve()` | `{ chave: valor }` de todas as chaves (com padrões) |
| `explain(key)` | `{ value, scope: 'channel'\|'game'\|'general'\|'default', source: 'explicit'\|'learned'\|'default', scopeName, label, evidence }` (`label`: "canal Fulano", "aprendida · jogo X", "padrão"…) |
| `set(key, value, scope?)` / `unset(key, scope?)` | Grava/remove valor do usuário; `scope`: `'general'` (padrão), `'game'`/`'channel'` (do projeto aberto) ou `{ type, name }`. Devolve a resposta do IPC |
| `scope()` / `reload()` / `ready` | Jogo/canal a que o cache se refere; recarrega; Promise do primeiro carregamento |

O cache vem de `prefs:resolve { game, channel }`: carregado no início, **antes** de o vídeo abrir (no gancho `beforeOpen`, para o `project:loaded` já encontrar os valores certos), de novo ao abrir, ao editar `project.meta` e a cada edição. O objeto `BF.prefs` da base é **mantido** (as funções são trocadas por dentro), então quem guardou a referência continua certo. Evento **`prefs:changed`** no `BF.bus`: `{ reason, keys }`, só quando algum valor em vigor mudou.

### IPC (`src/ipc/handlers/prefs.js`)

| Canal | Payload | Resposta |
|---|---|---|
| `prefs:schema` | — | `{ groups, keys, minEvidence, profiles, notices }` (`notices`: arquivos ilegíveis que foram preservados e recomeçados) |
| `prefs:resolve` | `{ game?, channel? }` | `{ values, details, warnings, learning, scope }` |
| `prefs:get` | `{ key, game?, channel? }` | `{ key, value, scope, source, scopeName, label, evidence? }` |
| `prefs:set` / `prefs:unset` | `{ scope:{type,name?}, key, value? }` | `{ changed, entry? }` |
| `prefs:list` | `{ scope }` | `{ scope, values (do usuário), inherited (details) }` |
| `prefs:names` | — | `{ games, channels }` (preferências + aprendizado + projetos salvos) |
| `prefs:observe` | `{ projectId, game, channel, cuts:[{ id, state }], onlyKnown? }` | `{ ignored?, changes }`; cada `change` = `{ itemId, key, label, scope, value, evidence, fresh, notify, text }` (`notify`: vale um aviso na tela; veja Aprendizado) |
| `prefs:learned` | `{ game?, channel? }` | `{ enabled, minEvidence, observed, items }` |
| `prefs:learnedSet` | `{ id, enabled? \| value? \| restore? }` | `{ changed, entry?, item }` |
| `prefs:learning` | `{ enabled?, minEvidence? }` (vazio = consulta) | `{ enabled, minEvidence, observed, changes }` |
| `prefs:history` / `prefs:revert` | `{ limit? }` / `{ id }` | `{ entries }` / `{ entry }` |
| `prefs:forget` | — | `{ forgotten }` |
| `prefs:inspect` | `{ path, origin? }` | `{ exists, file, own, compare, matches, matchScope, scope }` (não grava nada); `compare` é o do MESMO caminho; cada item de `matches` traz o seu `compare` (o arquivo novo contra o projeto parecido; `null` quando nada difere) |

Códigos: `UNKNOWN_KEY`, `INVALID_VALUE`, `INVALID_SCOPE`, `INVALID_ARGS`, `INVALID_PATH`, `NOT_FOUND`, `ALREADY_REVERTED`, `NOT_REVERSIBLE`, `WRITE_FAILED`. `ctx.preferences` expõe o serviço a outros módulos do processo principal (opcional); `ctx.bus` emite `prefs:changed { what }`.

### Armazenamento

`userData/preferences.json` (versão 1): `general.values`, `games[<chave>] = { name, values }`, `channels[...]`, `learning { enabled, minEvidence, items }`, `history[]` (até 300; ao passar disso saem primeiro as entradas **automáticas** do aprendizado, mais antigas antes, e só depois as outras: o aprendizado nunca empurra para fora o que o usuário alterou à mão). Gravação **atômica** (tmp + fsync + rename); se a gravação falhar, o estado em memória volta ao do disco e o erro explica a causa (`WRITE_FAILED`). Arquivo ilegível é renomeado para `preferences.json.<data>.corrupt` (nunca apagado), o app recomeça nos padrões e avisa o usuário (toast + aviso na aba).

### Histórico e "desfazer"

Toda mudança que o usuário faz (valor, remoção, ativar/desativar aprendido, editar aprendido, chave geral, evidência mínima) e todo aprendizado que passa a valer vira uma entrada, com texto legível ("Alterou "Relevância mínima" (canal Fulano): 40% → 60%"). Perfis de exportação aparecem pelo **nome** ("Vertical 9:16 · 1440p (2K) · H.264"), como no seletor, e não pelo id técnico (o processo principal recebe o tradutor de nomes do exportEngine; perfil desconhecido aparece pelo id). **Desfazer** volta ao estado de ANTES daquela entrada e registra a reversão como entrada nova (que também pode ser desfeita). Desfazer a entrada automática "Nova preferência aprendida…" **desativa** aquele item. "Esquecer o que foi aprendido" não é reversível (a entrada diz isso).

## Aprendizado

O renderer observa `decision` e, a cada ~0,4 s (e antes de abrir outro vídeo), envia o **estado atual** dos cortes tocados (`prefs:observe`): `{ status, duration, category, relevance, origin, profileId }`. Guardar o estado (e não o evento) evita contar duas vezes quem aprova → redefine → aprova, e acompanha ajustes de tempo e remoções. Só números e textos curtos são guardados em `learned.json` (gravado **sem indentação**); cortes pendentes sem categoria nem entram. Limites: 300 projetos, 500 cortes por projeto e **10.000 cortes no total** (os projetos mais antigos saem primeiro; o que acabou de mudar nunca sai). O teto existe porque cada lote regrava o arquivo e refaz o cálculo no processo principal: medido, ~4.000 cortes custam ~30 ms por lote e 150.000 (300 × 500, o antigo teto) passavam de 1,5 s.

Regras (provisórias):

| Chave | De onde vem | Evidência de exemplo |
|---|---|---|
| `analysis.minDurationSec` / `maxDurationSec` | mediana das durações dos cortes **aprovados**; mín = o menor entre metade da mediana e o 1º quartil; máx = o maior entre 1,5 × a mediana e o 3º quartil (limites 3–120 / mín+5–180, as faixas da análise) | "12 cortes aprovados, mediana 28 s" |
| `review.categories` | categorias usadas em cortes não rejeitados, da mais para a menos usada, seguidas das padrão que faltam (até 20) | "9 cortes categorizados; mais usadas: Hype (4), Fail (3), Clutch (2)" |
| `analysis.minRelevance` | maior limite (20/40/60/80%) abaixo do qual ≥ 70% dos cortes **sugeridos e decididos** foram rejeitados, desde que acima dele ≤ 50% tenham sido rejeitados | "5 de 7 cortes com relevância abaixo de 60% foram rejeitados (71%)" |
| `export.profileId` | perfil mais usado nos cortes aprovados, se tiver ≥ 50% deles (perfil = último export do corte, senão `ext.export.profileId`, senão `project.profileId`) | "6 de 8 cortes aprovados usaram este perfil (75%)" |

- **Escopos**: as observações são agrupadas em geral, por jogo e por canal. Cada proposta é comparada com o que o escopo **já herdaria**: a geral some quando é igual ao padrão do app; uma de jogo/canal some quando é igual à geral mostrada com **o mesmo n** (mesmos cortes) ou quando o herdado é o próprio padrão. Uma proposta de canal igual ao padrão do app **continua listada** quando a geral propõe outro valor (o canal aprende 60 s = padrão, a geral 45 s: vale 60 s do canal, não os 45 s da geral).
- **Evidência mínima**: padrão 5, configurável de 3 a 100 (Avançado). Abaixo disso o item aparece só na linha "N sugestões aguardam mais decisões" (com "n de N") e **não vale**.
- **Estados** de cada item: `active` (em vigor), `waiting` (sem evidência), `disabled` (o usuário desativou), `paused` (chave geral desligada). Editar o valor marca "editada" e vale o editado (novas decisões atualizam o calculado, não passam por cima); "Voltar ao aprendido" restaura.
- **Chave geral desligada**: nada novo é observado e nenhuma preferência aprendida vale; o que já foi guardado continua visível.
- **Nada escondido, sem barulho**: ao passar a valer um aprendido sai um aviso na tela (toast), a aba mostra um contador de novidades e há entrada no histórico; o selo "aprendida · escopo" aparece em cada linha da lista. Depois disso a mediana anda um pouco a cada corte novo: o valor em vigor, o cache (`prefs:changed`) e o card da aba acompanham sempre, mas o **toast e o contador só reaparecem quando a mudança é relevante** (`notify` em `prefs:observe`): número que passou de 20% do último valor de que o usuário foi avisado, lista que ganhou ou perdeu um item, perfil trocado. O histórico guarda **uma entrada por preferência aprendida**, atualizada no lugar ("Preferência aprendida atualizada: …") e levada para o topo; antes eram dezenas de entradas e de toasts por sessão (160 aprovações seguidas geravam 104 avisos e 105 entradas).

## Correspondência com lives já analisadas (`matcher.js`)

Só projetos **com cortes** entram. Níveis (a pergunta aparece em qualquer um, com texto mais cauteloso na fraca: "Pode ser a live…"):

- **forte**: mesmo `origin.videoId` ou código tirado do endereço (YouTube `watch?v=`, `youtu.be`, `/live/`, `/shorts/`; Twitch `/videos/`, `/v/`, `?video=`), mesma plataforma (ou uma delas desconhecida); ou mesmo endereço normalizado;
- **média**: mesmo canal (de `origin.channel` ou `meta.channel`) **+** título normalizado com semelhança ≥ 0,8 (Dice sobre palavras; números diferentes limitam a 0,5) **+** duração parecida (diferença até o maior entre 30 s e 1%);
- **fraca**: **pelo menos dois** sinais entre nome de arquivo igual (nomes genéricos como `video`, `gameplay`, `live`, `obs` não contam), tamanho (±0,1%) e duração (diferença até o maior entre 1 s e 0,2%).

Falsos positivos evitados: códigos de vídeo **diferentes** excluem (o mesmo canal repete título e duração todo dia); datas de publicação diferentes e canais diferentes excluem; um sinal só não basta; o mesmo caminho nunca é duplicata. A ordem das sugestões é nível, pontuação, mais cortes, mais recente; a pergunta usa a melhor.

**Fluxo (gancho `beforeOpen`)**: `prefs:inspect` (lê o arquivo, mede com ffprobe, compara com `projectStore.list()`) → se há correspondência e o caminho não tem trabalho próprio (ou tem só um projeto vazio sem resposta anterior), o modal próprio (`.bf-modal` da base, com `data-act` `cancel`/`new`/`ok`) pergunta. Se o arquivo novo **não é igual ao analisado** (duração ou tamanho diferentes, ou cortes que passariam do fim), a pergunta traz antes das saídas o bloco "Este arquivo é diferente do que foi analisado" com as mesmas linhas da comparação de fonte (mais longo/curto, tamanho, resolução, cortes fora do novo intervalo, trecho novo ainda não analisado); cópia idêntica não mostra nada. **Cancelar** (também Esc e clique fora) não abre nada e não cria projeto. **Criar novo** abre normalmente e grava `project.ext.prefs.match = { decision:'new', candidates, at }` (um projeto vazio com essa marca não pergunta de novo). **Abrir o existente** chama `project:adopt` (copia cortes, decisões, meta, perfis e `ext`; **não** altera o original) e, em melhor esforço, `review:historyCopy`; grava `project.ext.prefs.adoptedFrom`, limpa o `sourceChange`/`match` herdados e, quando a pergunta mostrou diferenças, grava o `sourceChange` do arquivo novo (selo "!" da aba, card "Fonte atualizada" e selo "Fora da fonte" nos cortes que passam do fim; um aviso só: "copiados de … N cortes ficaram fora do novo intervalo"). Se a adoção falhar, o motivo aparece num toast e nada abre. A mensagem avisa quando o arquivo do projeto existente não está mais no lugar (mudou de pasta).

## Fonte atualizada (`compare.js`)

Quando o caminho já tem projeto **com cortes** e a duração (diferença de pelo menos o maior entre 0,5 s e 0,1%) ou o tamanho (pelo menos 0,5%) mudou, `beforeOpen` mostra (`BF.ui.confirm`): direção (mais longo/curto), tamanho, resolução, **quantos cortes ficam fora do novo intervalo** (e quais), chat salvo com mais mensagens que o projeto registrava, o trecho novo ainda não analisado, e a garantia de que decisões e ajustes continuam. **Cancelar** não abre nem grava nada. **Atualizar e abrir** segue o `source:open` da base (que atualiza `source.size/duration`) e o `afterOpen` grava `project.ext.prefs.sourceChange = { at, direction, before:{duration,size}, after:{duration,size}, dismissed }`.

Cortes fora do intervalo: nunca alterados nem apagados. A aba Preferências mostra um card "Fonte atualizada" com a lista calculada **ao vivo** (corte com `end` maior que a duração; some da lista quando o usuário ajusta o tempo), botão **Ver** (abre a aba Cortes e emite `cut:selected`) e **Dispensar aviso**; a aba ganha o selo "!" enquanto houver corte fora.

## Aba Preferências (`renderer/features/prefs.js`)

De cima para baixo: aviso de fonte atualizada (só quando existe) → **Este projeto** (Jogo e Canal de `project.meta`, com `<datalist>` dos conhecidos e "Detectado: X" da origem) → **Preferências** (seletor Geral/Jogo/Canal; no Jogo/Canal o nome vem do projeto e pode ser trocado; linhas por grupo com controle simples, selo de origem — "padrão", "geral", "jogo X", "canal Y", "aprendida · …" — e **Limpar** quando há valor no escopo; "Neste projeto vale …" quando outro escopo sobrepõe; ajustes avançados em `<details>` "Mais ajustes") → **Aprendido com suas decisões** (chave geral, um cartão por item com ativar/desativar, valor editável, evidência, "Voltar ao aprendido") → **Histórico de mudanças** (recolhido, com Desfazer) → **Avançado** (evidência mínima; Esquecer o que foi aprendido, com confirmação).

## Dados do projeto (`project.ext.prefs`)

`sourceChange`, `match` e `adoptedFrom` (veja acima). Nenhum campo de corte é escrito por este recurso.

## Decisões provisórias

- Prioridade canal > jogo > geral (a confirmar com a Liz).
- Regras de aprendizado (faixa de duração a partir da mediana, limites de rejeição por relevância, 50% do perfil) e o piso de 3 para a evidência mínima configurável.
- Comparação só pergunta quando o projeto tem cortes; tolerâncias de duração/tamanho acima.
- "Criar novo" grava a decisão no projeto vazio para não perguntar de novo.
- Aviso de aprendizado só quando é novo ou a mudança passa de 20% (números), muda a lista (itens) ou troca o perfil; teto de 10.000 cortes observados no total.
- Sem consulta automática à plataforma (`sources:refreshMeta`) ao abrir um projeto: a comparação de fonte é entre arquivos locais.
- Faixas de duração e margem iguais às da análise (3-120 e 5-180); um valor antigo fora da faixa passa a valer o padrão.

## Limites conhecidos

- A pergunta e a comparação precisam do **ffprobe** para a duração; sem ele só nome e tamanho valem (correspondência fraca), e a comparação não roda (o `source:open` da base acusa a falta do ffprobe).
- **A comparação é sempre entre arquivos locais** (o que está sendo aberto contra o que o projeto registrou). O recurso **não consulta a plataforma** (`sources:refreshMeta` existe no recurso Fontes, mas as Preferências não o chamam): um VOD que cresceu no site só é percebido quando o usuário baixa de novo e abre o arquivo, e aí a diferença aparece. Decisão provisória: abrir um projeto não deve disparar yt-dlp/rede sozinho (atrasaria a abertura, falharia offline e acessaria a plataforma sem o usuário pedir); se a Liz quiser o aviso "o VOD mudou no site", é um botão explícito na aba Novo projeto, não uma consulta automática.
- `source:open` (base) sempre atualiza `source.size/duration` ao abrir: por isso a diferença é mostrada **antes**, e recusar significa não abrir (não existe "abrir sem atualizar").
- "Chat novo" = chat salvo (`project.chat.path`) com mais mensagens que `project.chat.count`; o recurso **não baixa** chat nem o registra de novo.
- O contador de aprendido pode perder as últimas decisões se o app for fechado nos 0,4 s depois delas (o `beforeunload` já dispara o envio, mas não espera a resposta).
- `prefs:inspect` mede o arquivo e lê a lista de projetos a cada abertura (a base mede de novo no `source:open`); com milhares de projetos a pergunta pode demorar um pouco.
- O cache de `BF.prefs` já assume o projeto que vai abrir; se a abertura não acontecer, ele volta ao projeto aberto em até 6 s ou no próximo `project:changed`.
- Só o tema escuro da base foi conferido visualmente; layout em janela estreita (< 860 px) não foi inspecionado.

## IA na nuvem não é preferência

A configuração do provedor de IA (provedor, modelo, endereço, limites, aceite de privacidade) e a chave de API **não** são chaves de preferência: valem para o computador (não por jogo/canal), a chave é um segredo e nada disso passa por `preferences.json`, pelo aprendizado nem por `BF.prefs`. Ficam em `userData/ai/` (veja docs/recursos/analise-ia.md) e a tela é um cartão recolhido da aba Análise. As chaves `analysis.*` continuam valendo para a análise por IA: `minDurationSec`, `maxDurationSec`, `padBeforeSec`, `padAfterSec`, `minRelevance` (conferência local dos cortes) e `keywords` (pista de chat enviada à IA). **`analysis.humor` é preferência** (valor por canal/jogo, sem segredo) e vale para os dois motores: a IA recebe o perfil e o algoritmo as listas.

## Pedidos de contrato (para `arquitetura.md`)

Quem consolida o contrato deve incorporar:

- **1.3 `BF.prefs`**: `get(key, fallback)` devolve o `fallback` quando nada do usuário/aprendido vale; `explain(key)` → `{ value, scope, source, scopeName, label, evidence }` (`scope`: `channel|game|general|default`; `source`: `explicit|learned|default`); novos `set(key, value, scope?)`, `unset`, `scope()`, `reload()`, `ready`; evento `prefs:changed` com `{ reason, keys }`.
- **3.5**: chave `analysis.keywords` (lista de textos; já usada por `analysis.js`), `review.categories` com o padrão `Jogada, Clutch, Engraçado, Fail, Hype, Dica` (igual ao de `cuts.js`), e a regra de aprendizado/escopos acima.
- **2.1 `project.ext.prefs`**: `{ sourceChange?, match?, adoptedFrom? }` (namespace deste recurso).
- **review (aba Cortes)**: sinalizar com um selo os cortes cujo `end` passa da duração da fonte enquanto existir `project.ext.prefs.sourceChange` com `dismissed:false` (hoje só a aba Preferências lista esses cortes). Também: `cut.exports[].profile` pode ser o id (texto) ou um objeto com `id`; o aprendizado lê os dois.
- **base**: (a) um `source:probe { path }` (ffprobe sem abrir) evitaria a medição dupla do `prefs:inspect`; (b) `BF.openSource` poderia permitir "abrir sem atualizar a fonte" se for desejado; (c) o painel de abas já aparece sem projeto, então nada a pedir para a aba Preferências.
- **sources**: o gancho `beforeOpen` do recurso Fontes deveria preencher `ctx.origin` com `sources:originFor` (hoje o prefs consulta `sources:originFor` por conta própria só para comparar, sem alterar a abertura). **`sources:refreshMeta` não é usado pelo prefs** (veja Limites conhecidos): as frases de `arquitetura.md` (5.3 e 5.10) e de `sources.md` que diziam o contrário foram corrigidas.
- **3.5 / 5.11**: as faixas de `analysis.minDurationSec` (3 a 120) e `analysis.maxDurationSec` (5 a 180) são as da análise; `prefs:observe` devolve `changes[].fresh` e `changes[].notify`; `prefs:inspect` devolve `matches[].compare`.

## Testes

```bash
node --test tests/prefs-store.test.js tests/prefs-keys.test.js tests/prefs-learning.test.js tests/prefs-matcher.test.js tests/prefs-compare.test.js tests/prefs-ipc.test.js tests/prefs-renderer.test.js
node tests/e2e/prefs.e2e.js        # abre o app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
npx eslint src/core/preferences src/core/projects/matcher.js src/core/projects/compare.js src/ipc/handlers/prefs.js renderer/features/prefs.js tests/prefs-*.js tests/e2e/prefs.e2e.js
```

- `prefs-keys`: números em texto (hexadecimal/científico recusados), faixas iguais às da análise, nome do perfil nos textos, textos das legendas e a guarda "toda chave tem quem a leia".
- `prefs-store`: padrão, prioridade e `explain`, escopos, nomes (acento/caixa/`__proto__`), validação, regra mín ≤ máx, aviso de conflito, persistência atômica (falha injetada no `rename`), arquivo corrompido, histórico e reverter, limite.
- `prefs-learning`: evidência mínima (4 não valem, 5 valem), configurável, estado em vez de evento, escopos e redundância, desativar/editar/restaurar/desfazer, chave geral, esquecer, cada regra (duração, categoria, relevância, perfil), persistência, falha de gravação, limites; proposta de canal igual ao padrão com a geral diferente; 160 aprovações seguidas sem 160 avisos nem entradas; a deriva da mediana avisa só quando relevante e atualiza a mesma entrada; as alterações manuais sobrevivem a centenas de entradas automáticas; nomes de perfil nos textos; teto de 10.000 cortes e `learned.json` compacto.
- `prefs-matcher`: URLs, títulos, forte/média/fraca/nenhuma e os falsos positivos, ordenação.
- `prefs-compare`: sem mudança, cresceu, encurtou (fora/parcial, sem mexer no projeto), mesma duração, duração desconhecida, chat novo.
- `prefs-ipc`: todos os canais com o `ctx` de verdade; `prefs:inspect` com vídeos reais (ffprobe) e projetos reais no `projectStore` (inclui a comparação do VOD baixado de novo em outro arquivo e as faixas/validação pelo IPC).
- `prefs-renderer`: a feature no `vm` com DOM mínimo, ligada aos handlers reais (ganchos, modal de 3 saídas com as diferenças do arquivo novo, adoção com mudança de fonte sinalizada, comparação, aprendizado com aviso só do que importa, aba).
- `e2e/prefs`: o app real — escopos pela tela, aprendizado com evidência e desativar/desfazer, pergunta de live duplicada (cancelar não abre; criar novo; abrir o existente sem alterar o original byte a byte), fonte regravada (recusar não grava; aceitar preserva e sinaliza), reiniciar e persistência, sem erros de console.
