# Análise: sugestões de momentos para cortar

Dono: `analysis`. Contratos: [arquitetura.md](../arquitetura.md) (1.4 aba de ordem 60, 3.6 chat, 5.3 `ext.analysis`, 5.9 análise). A aba **Análise** precisa de um projeto aberto e do FFmpeg/FFprobe do sistema (nunca baixa nada).

## Os motores

A aba **Análise** tem o seletor **Motor da análise: Algoritmo | IA na nuvem | Algoritmo + IA** (o terceiro roda os dois e junta as listas: seção "Algoritmo + IA" abaixo). Este documento descreve o **algoritmo** (regras simples, roda neste computador, sem enviar nada para fora, e continua sendo a reserva quando a IA não está configurada ou falha). A **IA na nuvem** (provedor compatível com a OpenAI, escolhido pelo usuário — nenhum vem pré-selecionado; no OpenRouter o modelo parte do roteador gratuito —, lendo a transcrição do vídeo, com conferência local rigorosa) está em [analise-ia.md](analise-ia.md), inclusive a transcrição do vídeo, o aviso de privacidade e a configuração do provedor. O padrão é **Algoritmo + IA** quando há provedor configurado **e** aviso aceito (até 16/11/2026 era a IA sozinha); senão o algoritmo. O motor escolhido fica em `project.ext.analysis.settings.engine`. As sugestões dos dois motores aparecem na mesma lista (cartões, motivos em chips, "Adicionar", "Adicionar todas") e viram cortes `origin:'auto'`, sempre pendentes.

> **Recalibrado na v4 (`ALGO_VERSION` 4, 23/10/2026).** A versão 3 saturava na abertura da live e não sugeria nada do resto (0 de 15 no gabarito). A v4 mede o volume contra o nível de fala do trecho, usa a transcrição quando existe, desempata pela pontuação e distribui as sugestões por toda a duração. Os números honestos (antes × depois, metade de ajuste × metade de teste, e a ressalva de que o gabarito é circular e de uma live só) estão em [analise-ia.md](analise-ia.md), seção 13; o resumo está em "Resultado na live real" abaixo.

## O que faz

Procura trechos **prováveis** de bons cortes por **regras simples e explicáveis** (não é inteligência artificial, e sugestão não é garantia: a tela diz isso). Cinco sinais, quatro que procuram o que se destaca para cima e um que procura o que se destaca por ser calmo (**momento calmo**, abaixo): **áudio** (volume sustentado acima do normal de fala e subida brusca depois de fala), **imagem** (mudança de cena e movimento), **chat** (velocidade das mensagens e palavras-chave) e **texto** (a transcrição do vídeo: risadas, exclamações e reações, ritmo de fala, repetição de bordão, falas sobre o próprio momento e as **expressões do canal** do perfil de humor; só quando há transcrição). Cada sugestão traz início, fim, relevância (0 a 100%) e os motivos em texto curto ("volume acima do normal de fala (+14 dB)", "mudança de cena", "chat 4× a média", "palavras-chave no chat: clip ×7", "risadas", "ritmo de fala acelerou (3,2 palavras/s)", "exclamações e reações", "repetição (bordão)").

- **Momentos calmos** (v5, pedido do dono depois de um short real, "só um jogador aproveitando o momento", sem fala nem jogada). Um trecho tranquilo, sem fala e sem pico, mas **vivo** (o som e a imagem continuam): construir, explorar uma paisagem, uma cena de história com música baixa. É calmo **perto do resto do vídeo** (o normal de uma live é a fala por cima do jogo), então vale para lives longas e **não** marca um vídeo que é calmo do começo ao fim. A sugestão traz o motivo "momento calmo: som baixo e contínuo, sem picos (27 dB abaixo do normal)", com ", sem fala" quando a transcrição confirma. Pesa menos (0,7: sozinha nunca passa de ~68%) e tem **cota própria, além da Quantidade** (um quarto dela, no mínimo 1), para não ser engolida pelos picos. Só no algoritmo (a IA lê o texto: veja analise-ia.md).
- **Tipo de vídeo** (perfil da análise, 14–15/11/2026): **Gameplay ou live de jogo** (padrão, o comportamento de sempre) ou **Conversa ou podcast**. No de conversa a repetição só conta como **laço**, entra a pista de **estrutura**, a imagem ignora as **trocas de câmera** e os cortes têm **30 a 75 s** e terminam em **frase completa**. Detalhes e medição em "Perfil de conversa", abaixo.
- **Quantidade automática** e **Descartar ideias fracas** (16/11/2026): a Quantidade pode ser **automática** (sem teto por hora: entra tudo o que passa na relevância mínima e no filtro) e o **filtro de ideias fracas** (ligado por padrão, com transcrição) tira a sugestão sem reação de voz nem do chat; a vaga dela vai para o próximo pico. Detalhes e medição em "Filtro de ideias fracas e quantidade automática", abaixo.
- **Separar por episódios** (15/11/2026, ligado por padrão): uma live com vários programas separados por arte de espera ("Iniciamos em instantes", "Voltamos em instantes", "Encerramos por hoje") tem as **telas de espera** achadas pela imagem parada, pelo silêncio e pela falta de fala; nenhuma sugestão entra nelas, e **cada episódio ganha pelo menos uma sugestão** quando tem um momento acima da relevância mínima. Cada sugestão mostra "Episódio N". Detalhes e medição em "Episódios e telas de espera", abaixo.
- **Nada é aprovado automaticamente.** "Adicionar" cria um corte `origin:'auto'`, `status:'pending'`, com `relevance` e `reasons`, e emite `cuts:changed { from:'analysis' }` mais um `decision` `create` por corte (a revisão e o histórico enxergam). Quem decide é o usuário, na aba Cortes.
- **Descartar** esconde a sugestão **sem criar corte**: ela some da lista e do selo da aba, não volta nas próximas análises do mesmo vídeo e fica em "Descartadas" (seção recolhida) para restaurar. Descartar não emite `decision` (não conta como aprendizado).
- **Um sinal que falta não bloqueia.** Sem áudio, sem chat baixado, sem transcrição, chat ilegível ou ffmpeg que falha num sinal: o sinal é ignorado, a tela diz o motivo e a análise segue com os outros. Só falha (`NO_SIGNALS`) se nenhum puder ser usado.
- **Segundo plano e cancelável.** `analysis:start` volta na hora; o ffmpeg roda com prioridade abaixo do normal (não trava a interface nem uma live), em fluxo (memória constante) e pode ser cancelado (os processos são encerrados e nada é gravado).
- **O processo principal nunca grava o projeto**: devolve o resultado e o renderer o aplica.

### A tela (poucos botões; ajustes avançados recolhidos)

0. **Motor da análise** (Algoritmo | IA na nuvem | Algoritmo + IA) e, logo abaixo, o cartão **Transcrição do vídeo** (nos dois motores: na IA é obrigatória; no algoritmo é *opcional* e liga o sinal de texto). O cartão tem **Transcrever o vídeo** (Whisper) e **Importar legenda…** (`.srt`/`.vtt`); os detalhes estão em analise-ia.md. Os itens 1, 2 e 4 abaixo valem para o algoritmo; no modo IA a tela mostra também o provedor e esconde sinais, sensibilidade e ajustes avançados do algoritmo (a **Quantidade** vale nos dois); no modo **Algoritmo + IA** mostra tudo: os ajustes do algoritmo e o provedor da IA.
1. **O que procurar**: o seletor **Tipo de vídeo** (Gameplay ou live de jogo | Conversa ou podcast, com uma frase do que muda; fica no projeto, em `settings.profile`), depois Áudio, Imagem, Chat, **Texto** e **Momentos calmos** (este precisa do sinal de Áudio ligado), com a dica do que cada um procura, e o interruptor **Separar por episódios** (ligado; fica no projeto, em `settings.episodes`). Sinal que o vídeo não tem (sem áudio; sem chat baixado na aba Novo projeto; **sem transcrição deste vídeo**, ou transcrição de outro arquivo) fica desabilitado e a linha diz que será ignorado.
2. **Sensibilidade** (1 a 5, padrão 3) e **Quantidade** (sugestões por hora, padrão 6; mostra "até N neste vídeo").
3. **Analisar** (e **Cancelar** durante a análise), com barra de progresso e estimativa de tempo restante. A estimativa é **da etapa em andamento** ("cerca de 9 min restantes nesta etapa"), pelo ritmo dela (`stageRemainingSec`, com `stageP` dos eventos); com áudio e imagem ao mesmo tempo vale a mais lenta, e no Algoritmo + IA a parte do algoritmo avisa "(depois vem a IA)". Até 16/11/2026 a conta era pela barra inteira, que mistura etapas de ritmos muito diferentes: numa live de 4 h o áudio enchia 20% da barra em 1 a 2 minutos e, durante a imagem, o tempo restante **subia** (13, 19, 22 min…) em vez de descer. Sem `stageP` (processo principal antigo ou janela recarregada antes do primeiro evento) vale a conta antiga. O botão fica desabilitado sem projeto, sem FFmpeg ou **sem nenhum sinal utilizável** (a tela explica: "Nenhum sinal utilizável…"). É o único botão primário da área de ajustes (o outro, "Adicionar todas", fica na área de resultados).
4. **Ajustes avançados** (recolhidos): **peso de cada sinal** (Áudio, Imagem, Chat, Texto, Momentos calmos), **pistas da transcrição** (peso de Risadas, Exclamações, Ritmo de fala, Repetição, "Sobre o momento", "Expressões do canal" e "Estrutura (conversa)"; 0 desliga a pista), palavras-chave do chat, atraso e janela do chat, imagem em modo rápido, **Restaurar padrões** e **Analisar de novo, sem usar o guardado** (ignora o resultado e os sinais já guardados no cache e lê o vídeo outra vez). Um número fora da faixa (0 a 2 nos pesos) é corrigido na hora e o campo passa a mostrar o valor que vale.
5. **Resultado**: resumo (quantas, quantas já nos cortes, quantas descartadas, sinais usados e ignorados, "N episódios" e "telas de espera puladas (X min)" quando a live tem espera, tempo ou "resultado do cache"), avisos, a lista (da mais relevante para a menos, com o selo **Episódio N** quando há episódios: **Ver trecho**, **Adicionar**, **Descartar**), a escolha **Ordem** logo acima dela (com 2 ou mais: "Mais relevantes primeiro", o padrão, ou "Ordem dos episódios", que vira "Ordem do vídeo" quando não há episódios; muda só a exibição, fica no projeto em `ext.analysis.listOrder` e vale também para as próximas análises), "Adicionar todas (N)" e "Descartar todas (N)" (só com 2 ou mais) e "Descartadas (N)" (recolhida, com **Restaurar** por linha e "Restaurar todas").

Margens e durações **não** têm campo aqui: vêm das Preferências (`analysis.*`, abaixo) e a tela mostra os valores em vigor, avisando quando a análise precisa limitá-los.

O cartão **Perfil de humor do canal** (abaixo da transcrição, recolhido) vale para os dois motores: o que o usuário escreve ali (critérios, **bordões** e **palavras e reações**) fica nas Preferências (`analysis.humor`, canal > jogo > geral), não no projeto. No algoritmo, os **bordões** viram a pista **Expressões do canal** e as **palavras e reações** entram na pista de exclamações (abaixo); os critérios e os exemplos de cortes aprovados e rejeitados são só da IA. Tudo sobre o perfil (limites, privacidade, o que não foi medido) está em [analise-ia.md](analise-ia.md), seção 16.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/analysis/analyze.js` | `analyzeSource(request, deps)`: orquestra sinais, cache, avisos de cobertura e combinação |
| `src/core/analysis/audioSignal.js`, `imageSignal.js`, `chatSignal.js`, `textSignal.js` | Extração (ffmpeg / chat / transcrição) e pontuação de cada sinal |
| `src/core/analysis/calmSignal.js` | O sinal de momento calmo (usa os dados do áudio e da imagem já extraídos, mais as falas da transcrição se houver) |
| `src/core/analysis/combine.js` | Junta os sinais em sugestões (picos, desempate, distribuição, cota por episódio, margens, durações, limites de falas, sem sobreposição) |
| `src/core/analysis/segments.js` | `findBreaks`: telas de espera e episódios (imagem parada, silêncio, falta de fala); `episodeAt` |
| `src/core/analysis/params.js` | Padrões, faixas, tabela de sensibilidade, `normalizeParams`, `suggestionLimit`, `perWindowLimit`, `ALGO_VERSION` |
| `src/core/analysis/stats.js` | Mediana/MAD, linha de base local, máximo deslizante, somas acumuladas, `softRamp` (pontuação logística) e `noisyOr` |
| `src/core/analysis/cache.js` | `AnalysisCache` e `sourceKey` (cache em `userData/cache/analysis/`) |
| `src/core/analysis/manager.js` | `AnalysisManager`: uma análise por vez, progresso, cancelamento |
| `src/core/analysis/combo.js` | `ComboAnalysis`: o modo Algoritmo + IA (o algoritmo, depois a IA, com os dois gerenciadores de sempre; um jobId só para a tela) |
| `src/core/analysis/merge.js` | `mergeResults`: junta as listas dos dois motores (mesmo momento vira um só; ordem; motor que falhou) |
| `src/core/analysis/proc.js`, `errors.js`, `index.js` | Execução do ffmpeg, `AnalysisError`, ponto de entrada |
| `src/ipc/handlers/analysis.js` | Canais `analysis:*` (escolhe o motor em `analysis:start`; procura a transcrição do projeto para o sinal de texto; registra também os da IA, via `src/core/analysis/ai/ipc.js`) |
| `src/core/analysis/ai/**`, `src/core/analysis/transcript/**`, `src/core/ai/**` | IA na nuvem, transcrição do vídeo e acesso ao provedor (analise-ia.md); `src/core/ai/openrouter/**` é o modo "Usar apenas modelos gratuitos" do OpenRouter ([openrouter-gratuito.md](openrouter-gratuito.md)) |
| `renderer/features/analysis.js` / `.css` | A aba (`BF.analysis` expõe as funções puras); no cartão do provedor com o OpenRouter usa os componentes de `renderer/features/aiOpenrouter.js` / `.css` (seletor de modelos e selo de pedidos gratuitos restantes) |
| `scripts/eval-analysis.js` | Avaliação contra um gabarito (`--from`/`--to` separam a metade de ajuste da de teste; `--chance` dá a referência do acaso, e `--skip-breaks` sorteia só fora das telas de espera do resultado) |
| `tests/analysis-*.test.js`, `tests/analysis-fixtures.js`, `tests/integration-analysis-chat.test.js`, `tests/e2e/analysis.e2e.js` | Testes (os da IA: analise-ia.md) |

## Canais IPC e eventos

| Canal | Entrada → saída |
|---|---|
| `analysis:defaults` | → `{ defaults, ranges, version }` |
| `analysis:start` | `{ path, params?, chatPath?, fresh?, projectId?, size?, duration?, engine? }` → `{ jobId }` (`engine`: `'algorithm'` (padrão), `'ai'` (analise-ia.md) ou `'both'` (Algoritmo + IA: o pedido do algoritmo mais `meta`, `existingCuts` e `profile` da IA; confere a IA antes de começar: `NO_KEY`, `NOT_CONFIGURED`, `CONSENT_REQUIRED`, `NO_TRANSCRIPT`); uma por vez: `BUSY`; `INVALID_ARGS`, `NO_FFMPEG`, `NO_FFPROBE`, `INPUT_MISSING`). `fresh:true` ignora o cache. Com `projectId` (e `size`/`duration` do vídeo), o processo principal procura a transcrição do projeto em `userData/transcripts`, **confere que é deste arquivo** (mesmo caminho, tamanho e duração) e a usa como sinal de texto; sem ela, ou se for de outro arquivo, o texto é só ignorado (com o motivo no resultado) |
| `analysis:cancel` | `{ jobId? }` → `{ cancelled }` |
| `analysis:status` | → `{ running: { jobId, path, startedAt, p, stage, message, engine? } ou null }` (`engine: 'both'` no combo; os trabalhos internos dele não aparecem) (a aba usa para retomar uma análise depois de recarregar a janela) |

Eventos: `analysis:progress { jobId, p, stage, message, stageP?, phase? }` (no máximo ~5 por segundo; `stageP` = quanto da etapa em andamento já foi, de 0 a 1, no áudio, na imagem e nos blocos da IA; `phase` = `'algorithm'` ou `'ai'` no modo Algoritmo + IA), `analysis:done { jobId, result }`, `analysis:failed { jobId, code, message, details? }` (inclui `CANCELLED`). Códigos de falha: `CANCELLED`, `INVALID_ARGS`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_FFPROBE`, `BUSY`, `PROBE_FAILED`, `NO_SIGNALS`, `FFMPEG_START_FAILED`. ffmpeg/ffprobe são só os do sistema: não há registro em `ctx.toolUsage`.

**Resultado**: `{ version, at, fromCache, tookMs, source:{ duration, hasAudio }, params, signals, usedSignals, limit, warnings, suggestions:[{ id, start, end, peak, relevance, reasons, signals }] }`; `signals` = `{ audio|image|chat|text: { used, reason, cached?, messages?, keywordMessages?, cues?, laughs?, humorHits? } }`.

## Como cada sinal é calculado

A grade é de **1 segundo**: cada sinal vira uma pontuação de 0 a 1 por segundo. Os limiares dependem da sensibilidade (tabela abaixo) e a "linha de base" é **local** (blocos de `baselineSec` = 600 s, interpolados entre si), então um trecho calmo e um barulhento da mesma live são medidos cada um contra o seu entorno.

**Pontuação logística** (`stats.softRamp(x, x0, span)`). Todos os sinais usam a mesma curva: vale 0 até o limiar `x0`, cerca de metade do teto no meio da rampa (`x0 + span/2`, como a rampa linear que ela substituiu), cerca de 90% do teto em `x0 + span` e se aproxima do **teto de 0,97** sem nunca chegar a 1,0. Por isso um desvio de 37σ não empata com um de 5,6σ (a v3 dava 1,0 aos dois e a ordem do tempo decidia), e a relevância de uma sugestão só chega perto de 100% quando vários sinais concordam. Os desvios (z) também têm teto (6 no áudio e no texto, 8 no movimento da imagem, razão 12 no chat). O teto é do **sinal**: um peso acima de 1 (a tela aceita até 2) amplifica a pontuação e pode levá-la a 1,0 por escolha da pessoa; o desempate pela pontuação do entorno vale do mesmo jeito.

**Áudio** (`audioSignal.js`). Primeira faixa de áudio (`-map 0:a:0`, a mesma que a exportação usa), PCM 16 kHz mono por `aresample=16000:async=1:first_pts=0` (a faixa atrasada mantém o tempo do vídeo), lido em fluxo. Energia RMS em dBFS por janela de 0,5 s (piso −100). Daí:
- *Piso de ruído*: entre −75 e −60 dBFS, 30 dB abaixo do percentil 95 do próprio áudio (gravação baixa = piso mais baixo). Quadros abaixo dele são **silêncio** (porta de ruído do microfone fechada, ambiente quase mudo) e não entram no "normal". Se menos de 20% do áudio passa do piso (um ambiente de −61 dB com estouros raros), o piso desce a −75 dBFS: o fundo é o normal e o estouro é o destaque.
- *Nível sustentado*: média dos quadros **ativos** (acima do piso) em ±2 s (5 s), exigindo 40% de quadros ativos e pelo menos 2 s de fala. Fala animada dura; um estalo isolado não.
- *Linha de base = nível normal de fala do trecho*: mediana e MAD (escala mínima de 3 dB) **só dos segundos com fala**, por bloco de 10 min interpolado; bloco com menos de 40 s de fala usa o do vídeo todo. É o conserto do defeito da v3: lives com porta de ruído caem a −100 dB entre as frases, e contra uma base que incluía esse silêncio **toda frase que começava** parecia uma subida de dezenas de dB (z de 37σ na abertura da live medida).
- *Destaque*: `z = (nível sustentado − normal) / escala` (teto 6), com **nível absoluto mínimo** (−45 dBFS: nada mais baixo conta). Pontuação `softRamp(z, audioZ0, 1,6)`; o motivo diz "volume acima do normal de fala (+N dB)".
- *Subida brusca*: nível sustentado menos o nível dos ~10 s de fala anteriores (de 12 s a 2 s antes), **só se esses 10 s tinham fala** (40% dos quadros ativos) e o nível já passou de 1σ; **de silêncio para fala é início de frase, não destaque**. Motivo "subida brusca de volume (+N dB)".
- Pontuação do segundo = o maior dos dois.

**Imagem** (`imageSignal.js`). O ffmpeg reduz o vídeo (2 quadros/s, 160 px de largura, só luminância) e o filtro `scdet` mede, por quadro, a diferença média absoluta (`mafd`) e a pontuação de mudança de cena (0 a 100); `-skip_frame noref` pula quadros que nenhum outro usa como referência. Por segundo: `cena` = maior pontuação; `movimento` = `mafd` médio, suavizado pela **mediana de 3 s** (uma troca de cena de 1 s não vira "movimento").
- *Cena*: `softRamp(cena, sceneScore0, 18)`.
- *Movimento*: `z = (movimento − mediana local) / escala` (escala mínima 1%, teto 8); `softRamp(z, motionZ0, 3)`. Só vira motivo se durar 2 s ou mais.
- **Modo rápido**: só quadros-chave (`-skip_frame nokey`, sem `fps`): muito mais rápido e mais grosseiro (a precisão no tempo é a do intervalo de quadros-chave). Mudança só de cor com a mesma luminância não aparece.

**Chat** (`chatSignal.js`). Lê o formato `bf-chat-1` com `readChat` do recurso Fontes (cai para o JSON direto se ele falhar) e conta mensagens por segundo com `messagesPerWindow(chat, 1, n)`.
- *Velocidade*: soma de mensagens numa janela de 10 s ÷ média local aparada (sem os 5% maiores; piso de 0,02 msg/s; razão limitada a 12); só vale com pelo menos 6 mensagens na janela. `softRamp(razão, chatRatio0, 3)`.
- *Palavras-chave*: começo de palavra, sem acento nem caixa (`clip` casa "CLIPA isso"); na janela, com pelo menos `chatKeywords0` mensagens: `softRamp(n, chatKeywords0 − 1, 4)`. Lista vazia = sem esse critério.
- Pontuação = `1 − (1 − velocidade)(1 − palavras)`, **deslocada para trás em `lagSec` (6 s)**: o público reage depois do lance.

**Texto** (`textSignal.js`; só com transcrição). As falas (`bf-transcript-1`, ver analise-ia.md) viram seis pistas, cada uma uma pontuação logística calculada numa janela ao redor do segundo; o texto total é a soma de evidências independentes (`1 − Π(1 − peso·pista)`). As listas de palavras são em **português**; as pistas de risada, ritmo e repetição não dependem do idioma. Sem pontuação no texto (legenda automática do YouTube, por exemplo) a pista de exclamações só enxerga as palavras de reação.
- *Risadas*: marcas `*Risos*` (ou `[risos]`…) das falas; marcas vizinhas (menos de 4 s) são **uma** risada (uma risada longa vale no máximo 3: laços do reconhecimento não inflam). A risada vem **depois** do lance, então o segundo pontua nos ~15 s que a antecedem. Motivo "risada" / "risadas".
- *Exclamações e reações*: por fala, `!` e interjeições/palavrões de reação ("caralho", "nossa", "meu deus", "que isso", "eita"…) contam unidades (até 1,5 por fala); soma numa janela de ±8 s. Motivo "exclamações e reações".
- *Ritmo de fala*: palavras por segundo (as palavras de cada fala espalhadas na duração dela, no mínimo palavras/6 s) em ±8 s, contra o normal de fala do trecho (mediana/MAD só das janelas com fala, por bloco de 10 min; z com teto 6). Motivo "ritmo de fala acelerou (N palavras/s)". Fala de 12 palavras ou mais feita quase só das mesmas palavras (as diferentes são menos de 1/4: "e horas e horas e horas…", "e aí e aí e aí…") é laço de alucinação do Whisper e **não conta** ritmo nem repetição (`textSignal.isLoopArtifact`; numa gameplay medida, um laço desses virava uma sugestão falsa). Uma reação curta repetida de verdade ("Não, não, não, não!") continua contando.
- *Repetição de bordão*: o que se repete **colado**, até 6 s: uma palavra de conteúdo em sequência na própria fala ("like, like, like"), um par de palavras já dito ("21 reais… 21 reais"), uma fala curta inteira repetida ("Beco, moleque!" duas vezes). Expressões que aparecem em muitas falas do próprio vídeo ("e aí", "eu acho que") **não** são bordão; números em lista (alucinação típica do reconhecimento) também não. Palavra de assunto repetida numa conversa não conta. Motivo "repetição (bordão)".
- *Falas sobre o próprio momento*: "vou clipar", "isso vai pro corte", "olha isso", "não acredito", "não é possível", "vem ver" (±12 s). Motivo "fala sobre o próprio momento".
- *Expressões do canal* (perfil de humor, `humor.js`; sem perfil a pista fica em zero): cada fala que contém um **bordão** do usuário vale 1 (até 2 por fala), somado numa janela de ±8 s. A busca ignora acento, caixa e pontuação, só casa palavra(s) inteira(s) dentro de **uma** fala e, entre expressões que se contêm, vale a mais longa. Um bordão dito em mais de 1% das falas (no mínimo 6) vale "limite ÷ falas" a cada vez, para o bordão de todo minuto não encher a lista (o total de uma expressão nunca passa de ~1% das falas). Um bordão já pontua ≈ 0,70 na sensibilidade média; dois ficam perto do teto. Motivo "expressão do canal: “beco moleque”" (até duas, as mais ditas na janela). As **palavras e reações** do perfil não criam pista: somam à de exclamações (0,75 por fala, como as da lista do app e com o mesmo freio do bordão comum). O resultado traz `signals.text.humorHits` (quantas expressões foram achadas; só com perfil).

**Momento calmo** (`calmSignal.js`; não depende de sinal novo: usa o áudio e, quando há, a imagem e a transcrição). Por segundo, numa janela de ~12 s ao redor:
- *Nível*: mediana do volume da janela; o **normal** é a mediana dos níveis do vídeo todo. A pontuação é `softRamp(queda em dB, calmDrop0, 8)` (logística, nunca 1,0; `calmDrop0` 14 · 12 · 10 · 8 · 6 dB nas sensibilidades 1 a 5).
- *Sem pico*: o percentil 90 da janela fica pelo menos 4 dB abaixo do normal (um grito de 3 s tira o trecho; um estalo de 1 s não).
- *Vivo*: pelo menos 60% dos quadros de som acima do piso de ruído e o nível da janela 6 dB acima dele (som quase mudo é pausa, menu ou microfone mudo) e, com imagem, o movimento mediano acima de 0,4 (tela parada, pausa e carregamento não valem).
- *Sem fala*: com transcrição, janela com 20% ou mais coberta por falas não vale. **Sem transcrição o sinal não distingue fala baixa de música baixa**: vale o nível baixo e sem pico.
- Motivo "momento calmo: som baixo e contínuo, sem picos[, sem fala] (N dB abaixo do normal)". O resultado traz `signals.calm = { used, reason, calmSeconds }` (sem o sinal de Áudio ligado: `reason` "precisa do áudio").

**Combinação** (`combine.js`).
1. Cada sinal é multiplicado pelo seu peso (áudio 0,8, imagem 0,6, chat 1, texto 1, calmo 0,7; peso 0 desliga) e **dilatado** ±2 s (`alignToleranceSec`): sinais um pouco fora de sincronia ainda concordam.
2. Evidências independentes se somam como "ou ruidoso": `relevância = 1 − Π(1 − evidência)`. Um sinal forte sozinho passa (até o seu peso vezes 0,97); dois médios no mesmo instante passam juntos.
3. Escolha gulosa do pico mais relevante ao menos relevante. **O empate** entre picos de mesma pontuação se resolve pela **pontuação ao redor** (soma da evidência na janela de duração máxima), nunca pela ordem do tempo (a v3 pegava sempre o primeiro). A **extensão** do evento é onde a pontuação (sem dilatação) fica acima de metade do pico (mínimo 0,15), aceitando buracos de até 2 s; somam-se as margens `padBeforeSec`/`padAfterSec`; a duração é levada ao intervalo `minDurationSec`..`maxDurationSec` (mínimo: estende dos dois lados; máximo: a janela que contém o pico e junta mais pontuação); nunca sobrepõe um trecho já escolhido (o que foi escolhido "gasta" a evidência dele, para a sombra da dilatação não virar um falso evento).
4. **Distribuição por toda a duração**: no máximo `perWindow` sugestões por janela de 10 min (`spread.windowSec`), onde `perWindow` é o **dobro da média** (`limite × 600 / duração`, no mínimo 2) ou o valor de `spread.perWindow`; uma janela que esgota a cota deixa de dar picos, e `spread.minGapSec` (5 s) de folga separa uma sugestão da outra. Uma abertura cheia de eventos fortes não consome mais a cota inteira.
5. **Limites de falas** (só com transcrição): o início vai para o começo de uma fala (até 4 s antes, senão até 2 s depois) e o fim para o fim de uma fala (até 4 s depois, senão até 2 s antes), sem sair do espaço livre nem das durações permitidas. Quando não há limite de fala nessa distância o corte fica onde estava (na live medida, 13 de 18 começos e 16 de 18 fins ficaram exatamente num limite).
6. Só ficam picos com relevância ≥ `minRelevance`, até o teto `suggestionLimit` = `maxSuggestions` se informado, senão `perHour × horas` (mínimo 3, máximo 300). **O momento calmo tem uma rodada à parte** (v5): primeiro os picos dos outros sinais usam o teto; depois o calmo escolhe nos trechos que sobraram (sem encostar nos já escolhidos) até `calmLimit` = um quarto do teto (mínimo 1), e `result.limit` soma essa cota só quando o calmo achou algo. Se o calmo é o único sinal, vale o teto inteiro.
7. Tempos arredondados a 0,1 s; `id = <início×10>_<fim×10>`.

### Duração do vídeo e fim das sugestões

A duração que manda é a do **ffprobe** (`source.duration` do resultado é ela). Nenhuma sugestão termina depois dela: o fim é limitado à duração **truncada a 0,1 s** e o `peak` fica dentro do vídeo. Isso importa porque a exportação (`qc.js`, `INVALID_RANGE`) recusa um corte que termina depois do fim. Só quando o ffprobe não informa a duração (0) a grade vem do que o ffmpeg mediu (janelas de áudio, último quadro) ou do fim da transcrição.

### Parâmetros (`params.js`)

| Parâmetro | Padrão | Faixa | De onde vem |
|---|---|---|---|
| `signals.audio/image/chat/text/calm` | ligados | | aba (por projeto) |
| `sensitivity` | 3 | 1 a 5 | aba (por projeto) |
| `perHour` | 6 | 1 a 60 (a aba oferece 1 a 20) | aba (por projeto) |
| `maxSuggestions` | sem teto | 1 a 500 | só via IPC |
| `weights` | áudio 0,8, imagem 0,6, chat 1, texto 1, calmo 0,7 | 0 a 2 | aba (por projeto) |
| `profile` | `gameplay` | `gameplay` ou `conversa` (outro valor volta ao padrão) | aba (por projeto, "Tipo de vídeo") |
| `episodes` | ligado | ligado ou desligado | aba (por projeto, "Separar por episódios") |
| `autoQuantity` | desligado | ligado ou desligado | aba (por projeto, "Quantidade automática"): sem teto por hora; trava de 30 por hora e 5 por janela de 10 min; o calmo continua com a cota da Quantidade |
| `filterWeak` | ligado | ligado ou desligado | aba (por projeto, "Descartar ideias fracas"); só age com transcrição que marca reações (30 por hora ou mais) |
| `textWeights` | risadas, exclamações, ritmo, repetição, sobre o momento, expressões do canal e estrutura: 1 cada (estrutura só existe no perfil de conversa) | 0 a 2 | aba (por projeto) |
| `humor` | `{ phrases: [], reactions: [] }` | até 40 itens de 60 caracteres por lista (minúsculas, com acento, em ordem alfabética) | Preferências `analysis.humor` (perfil de humor; a aba só manda as duas listas e **não** grava no projeto); entra na chave de cache do resultado |
| `padBeforeSec` / `padAfterSec` | 3 / 2 | 0 a 60 | Preferências `analysis.padBeforeSec/padAfterSec` |
| `minDurationSec` / `maxDurationSec` | 15 / 60 | 3 a 120 / 5 a 180 | Preferências `analysis.minDurationSec/maxDurationSec` |
| `minRelevance` | 0,5 | 0 a 1 | Preferências `analysis.minRelevance` |
| `alignToleranceSec` | 2 | 0 a 10 | só via IPC |
| `baselineSec` | 600 | 60 a 3600 | só via IPC |
| `spread.windowSec` / `perWindow` / `minGapSec` | 600 / dobro da média (mín. 2) / 5 | 120–3600 / 1–100 / 0–300 | só via IPC |
| `chat.windowSec` / `lagSec` / `minMessages` | 10 / 6 / 6 | 2–60 / 0–60 / 1–100 | aba (janela e atraso) |
| `chat.keywords` | `clip pog omg wtf` | até 50 palavras de 40 letras | Preferências `analysis.keywords`; a aba só grava no projeto uma lista **diferente** da que vale, para a preferência continuar valendo |
| `image.fast` | desligado | | aba (por projeto) |

`normalizeParams` valida e limita tudo (valor inválido volta ao padrão; o máximo nunca fica abaixo do mínimo): o IPC não confia no renderer.

Limiares por sensibilidade (1 · 2 · 3 · 4 · 5; valores intermediários são interpolados; `x0` = onde a pontuação começa a subir, `span` = largura da rampa):

| Limiar | 1 | 2 | 3 | 4 | 5 | span |
|---|---|---|---|---|---|---|
| `audioZ0` (σ do nível de fala) | 2,2 | 1,7 | 1,3 | 1,0 | 0,7 | 1,6 |
| `calmDrop0` (dB abaixo do normal do vídeo) | 14 | 12 | 10 | 8 | 6 | 8 |
| `audioRise0` (dB) | 18 | 15 | 12 | 10 | 8 | 8 |
| `chatRatio0` (× a média) | 4 | 3 | 2,4 | 2 | 1,7 | 3 |
| `chatKeywords0` (mensagens) | 5 | 4 | 3 | 3 | 2 | 4 |
| `sceneScore0` (0–100) | 16 | 12 | 9 | 7 | 5 | 18 |
| `motionZ0` (σ) | 5 | 4 | 3,2 | 2,7 | 2,2 | 3 |
| `textLaugh0` (marcas em ~15 s) | 0 | 0 | 0 | 0 | 0 | 2,5 · 2 · 1,5 · 1,2 · 1 |
| `textExclaim0` (unidades em ±8 s) | 2 | 1,5 | 1 | 0,8 | 0,5 | 3 |
| `textPace0` (σ do ritmo) | 2,5 | 2 | 1,5 | 1,2 | 0,9 | 2,5 |
| `textRepeat0` (repetições em ±8 s) | 1,5 | 1,1 | 0,8 | 0,5 | 0,3 | 3 |
| `textMeta0` (falas em ±12 s) | 0 | 0 | 0 | 0 | 0 | 2 · 1,8 · 1,6 · 1,3 · 1 |
| `textHumor0` (expressões do canal em ±8 s) | 0 | 0 | 0 | 0 | 0 | 2 · 1,8 · 1,5 · 1,3 · 1,1 |
| `textStructure0` (perfil de conversa: unidades de estrutura em ±12 s) | 2,5 | 2 | 1,5 | 1,2 | 0,9 | 3 |

## Perfil de conversa (podcast, entrevista, live de bate-papo)

Nasceu do teste numa live real de podcast (14/11/2026: 1h59 com dez episódios-piloto, corte multicâmera ao vivo). No perfil de gameplay o motor não se distinguia do acaso ali: a "repetição" disparava com hesitação ("uma agência de marketing, mas era uma agência de marketing"), cada troca de câmera virava "mudança de cena" e os cortes terminavam no meio da frase ou numa pergunta sem resposta.

O que muda com `profile: 'conversa'` (o gameplay calcula exatamente como antes):

- **Repetição = laço** (`textSignal.loopRepeats`): conta quando uma frase de 2 a 5 palavras (sem as de ligação) aparece em **3 falas em até 25 s** e é o **miolo** (60% das palavras ou mais) de pelo menos duas delas: "obrigado você… obrigado você, fulano…", "a satisfação foi toda minha" três vezes, "quem me conhece sabe". Hesitação, ênfase dentro da fala ("rede social, rede social") e assunto repetido ("fazer rede social para um restaurante… para uma loja") não contam; frase dita em mais de 1% das falas do vídeo é jeito de falar. Motivo: "laço de repetição (bordão)".
- **Estrutura** (`textSignal.structureUnits`, pista nova, peso em "Estrutura (conversa)"): por fala, conselho/dica vale 1 ("primeiro de tudo", "tem que", "estudem", "não tenha…"), história 0,5 ("quando eu era", "teve um dia", "na época"), opinião 0,5 ("eu acredito", "a gente precisa", "não é só") e pergunta com resposta 0,5 (a fala termina em "?" e há 10 s de fala nos 25 s seguintes); janela de ±12 s. Motivo: "conselho, história ou opinião". As listas são em português.
- **Imagem sem trocas de câmera** (`scoreImage` com `ignoreCuts`): a mudança de cena não pontua, e o movimento a até 2 s de uma troca também não (a fusão mexe na imagem inteira). Sobra o movimento de verdade (alguém gesticulando, levantando).
- **Cortes em frase completa** (`analyze.sentenceBounds`): o início vai para uma fala que abre frase (depois de ponto ou de pausa de 0,6 s) e o fim para uma fala que fecha frase com ponto ou exclamação, **nunca numa pergunta**; o alcance é maior que o do gameplay (até 8 s para trás no início e para frente no fim). Transcrição com pontuação em menos de 20% das falas (legenda automática) usa o alinhamento de sempre.
- **Duração de 30 a 75 s**: piso sobre as Preferências (se elas pedem mais, valem as Preferências). Um bom corte de conversa tem pergunta, resposta e desfecho; os reels publicados da live medida têm ~50 s.

A versão do algoritmo **não** mudou (continua 5): a leitura do vídeo é a mesma e o perfil já entra nos parâmetros, que fazem parte da chave do resultado. Mudar a versão obrigaria todo vídeo a ser lido de novo (numa live de 2 h, ~14 min).

### Medição (a live de podcast, 12 sugestões, mesmos sinais em cache)

Dois gabaritos: os 20 momentos marcados lendo a transcrição antes de cortar e os 37 trechos que viraram de fato reels e stories (`Braga Frame - dados do teste`, fora do repositório). "Bate" = início a até 5 s ou sobreposição de 50%.

| Execução | Gabarito de 20 | Acaso igualar | Gabarito de 37 | Acaso igualar | Sugestões que batem com o de 37 |
|---|---|---|---|---|---|
| Gameplay (padrão) | 3 | 27,7% | 7 | 7,6% | 7 de 12 |
| **Conversa** | **5** | **2,3%** | **8** | **4,9%** | **9 de 12** |
| Conversa, sem a pista de estrutura | 5 | 2,4% | 8 | 4,6% | 8 de 12 |
| Conversa, sem o laço | 4 | 9,6% | 6 | 22,6% | 7 de 12 |
| Conversa, sem o ritmo de fala | 3 | 29,1% | 8 | 5,0% | 8 de 12 |
| Conversa, sem a imagem | 5 | 2,2% | 9 | 1,6% | 9 de 12 |
| Conversa, 12 por hora (24 sugestões) | 6 | 12,9% | 13 | 3,4% | 15 de 24 |

**Leitura honesta:** o ganho em acertos é pequeno; o maior ganho é de **qualidade**. Das 12 sugestões do perfil de conversa, 9 viraram reels e as outras 3 são um anúncio de livro, uma história de infância colada a um corte publicado e uma história engraçada que ficou de fora por cuidado. No gameplay, uma sugestão era a hesitação do marketing (três, com a imagem desligada), uma era a pergunta do apresentador sem a resposta e outra a apresentação repetida do convidado ("pra quem não me conhece, eu me chamo fulano"). Quem pesa: o **laço** (sem ele cai para 6 de 37 e 4 de 20) e o **ritmo de fala** (sem ele, 3 de 20). A **estrutura** não mudou o resultado nesta live (fica branda de propósito; uma versão mais forte trocou um acerto de um gabarito por outro do outro). Com as trocas de câmera ignoradas, desligar a imagem quase não muda (um acerto a mais no gabarito de 37), quando no gameplay ela atrapalhava. Ressalvas: **uma live só**, o gabarito foi feito por quem leu a transcrição (favorece o texto) e os ajustes (miolo de 60%, limiar da estrutura) foram conferidos nela: é preciso medir em outra conversa antes de mexer mais.

**Correção (15/11/2026):** as colunas "Acaso igualar" acima sorteiam trechos no vídeo inteiro, e 54 dos 119 minutos dessa live são **telas de espera**, onde ninguém corta. Isso fez o motor parecer bem melhor que o acaso. Sorteando só fora da espera (o "acaso justo", `--skip-breaks`), o perfil de conversa fica em 20% (gabarito de 20) e 40% (gabarito de 37). A medição justa está na próxima seção.

## Episódios e telas de espera (live com vários programas)

Nasceu da mesma live: dez episódios-piloto numa transmissão de 1h59, separados por uma arte parada ("Iniciamos em instantes" no começo, "Voltamos em instantes" entre os episódios, "Encerramos por hoje" no fim). Dos 119 minutos, **54 são espera**. Sem a cota, as sugestões se amontoavam nos episódios mais animados e três episódios ficavam sem nenhuma.

**Como a espera é achada** (`segments.findBreaks`, com os sinais já lidos: nada a mais para ler do vídeo). Por segundo, até três evidências:

- **imagem parada**: diferença média entre quadros de até 0,3% (a arte de espera dá 0; uma câmera de verdade dá 1 a 5%, nunca zero, nem com a pessoa quieta). No modo rápido da imagem (só quadros-chave) os segundos sem quadro parecem parados, então a imagem fica de fora;
- **silêncio**: o segundo inteiro abaixo de -60 dBFS (a espera dessa live é silêncio digital, -100; fala baixa fica em -45 ou mais);
- **sem fala**: nenhuma fala da transcrição no segundo (só quando o texto entra na análise).

Com a imagem lida, **a imagem parada é obrigatória**: o segundo é de espera quando a imagem está parada **e** pelo menos uma das outras evidências concorda (silêncio ou falta de fala: a transcrição costuma "vazar" para dentro da espera, e uma espera com música perde o silêncio); só a imagem lida, ela basta. Sem a imagem (desligada ou no modo rápido), silêncio e falta de fala precisam concordar; só o som, ele basta. (Até 16/11/2026 bastavam duas evidências quaisquer: numa gameplay, o silêncio digital entre as falas somado à falta de fala marcou 18 "esperas" com a imagem mexendo, na conversa de câmera, em menus e telas de carregamento; veja "Teste numa gameplay".) **Só a transcrição não decide** (falta de fala também é jogo sem narração). Imagem parada **com som e sem transcrição não é espera**: pode ser um podcast só de áudio com a capa parada. Viram **intervalo** os trechos de espera de **30 s ou mais**, aceitando buracos de até 5 s (uma animação curta na arte). Os **episódios** são os trechos entre intervalos com **90 s ou mais** (um pedaço menor, como os 57 s do episódio 2 antes de uma pausa técnica, não ganha cota, mas pode receber sugestão). Se a espera passa de **60% do vídeo**, nada é marcado: o vídeo é parado por natureza (slides, tela estática).

Na live medida, as seis combinações de sinais (imagem, som e texto; só dois deles; só imagem; só som) acham os **mesmos 10 episódios**, com diferença de segundos nas bordas.

**O que muda na escolha** (`combine`, opções `blocked` e `groups`):

- Os intervalos entram como trechos bloqueados **sem folga**: nenhuma sugestão os atravessa, e o corte pode começar no instante em que a espera acaba (a folga de 5 s entre sugestões continua valendo entre elas). Vale também para a rodada dos momentos calmos.
- **Cota por episódio**: enquanto houver episódio sem sugestão, o pico é procurado só nos episódios vazios, e o melhor deles vence. A cota por janela de 10 min não barra esta rodada (mas conta). Episódio sem nenhum pico acima da relevância mínima fica sem, e a vaga volta para a escolha de sempre. Depois, a escolha de sempre no vídeo inteiro, até o teto.
- A **Quantidade não muda**: com mais episódios do que sugestões, só os melhores episódios ganham.
- O resultado traz `episodes` e `breaks` (`[{ start, end }]`, em segundos inteiros) e cada sugestão traz `episode` (1, 2, 3…; ausente quando o pico cai fora de um episódio).
- Desligado (`episodes: false`), a análise é exatamente a de antes. A opção entra nos parâmetros e, portanto, na chave do resultado; a versão do algoritmo não mudou.

### Medição (a live de podcast, 12 sugestões, mesmos sinais em cache)

"Acaso justo" é a chance de trechos sorteados com as mesmas durações, **só fora das telas de espera** (66 min de programa), acertarem tanto quanto a execução ou mais (`eval-analysis.js --chance 7156 --skip-breaks`). Sugestões por episódio na ordem dos episódios, de 1 a 10.

| Execução | Por episódio | Batem com o de 37 | Gabarito de 20 | Acaso justo | Gabarito de 37 | Acaso justo |
|---|---|---|---|---|---|---|
| Gameplay, sem episódios | 0 0 2 1 1 1 1 2 1 3 | 7 de 12 | 3 | 70% | 7 | 49% |
| Gameplay, com episódios | 1 1 1 1 1 1 1 1 1 3 | 8 de 12 | 3 | 70% | 9 | 16% |
| Conversa, sem episódios | 0 0 2 2 1 1 1 2 0 3 | 9 de 12 | 5 | 20% | 8 | 40% |
| **Conversa, com episódios** | **1 1 1 1 1 1 1 1 1 3** | **10 de 12** | **5** | **20%** | **10** | **13%** |
| Conversa, com episódios, 12 por hora (24) | 1 2 3 4 2 1 1 5 1 4 | 15 de 24 | 6 | 70% | 13 | 54% |

**Leitura honesta:** a cota faz o que promete. Todo episódio tem sugestão (no perfil de conversa, os episódios 1, 2 e 9 não tinham nenhuma) e nenhuma sugestão toca a espera (antes, uma entrava 9 s na arte de encerramento). Entraram o episódio 1 (4:06, virou reel), o 2 (13:11, não virou) e o 9 (99:32, virou reel e está no gabarito de 20). Saíram dois trechos que não viraram reel (26:13 e 89:00) e um que virou (31:45: o episódio 4 ficou com uma só). O maior ganho é de **organização**: onde estão os episódios, nada na espera, um corte por episódio para revisar. Em **acerto**, o acaso justo mostra que o motor, nesta live, é só **um pouco melhor que sortear momentos dentro dos episódios** (13% a 20% de chance de o acaso empatar; com 24 sugestões, no nível do acaso). "10 de 12 batem" soa alto, mas o gabarito de 37 é denso (um corte publicado a cada 1,8 min de programa) e o sorteio também acerta muito. Ressalvas de sempre: uma live só, e o gabarito foi feito por quem leu a transcrição.

## Teste numa gameplay (live de Call of Duty Warzone, 16/11/2026)

Uma live de **4h18** de CoD Warzone (Ressurgência em dupla, muito sniper; conversa de câmera no começo e no fim; o parceiro e amigos falam pelo Discord; chat pequeno, **386 mensagens de 7 pessoas**), baixada pelo próprio motor de Fontes (1080p60) e transcrita pelo Whisper do app (Large v3 Turbo; 2.211 falas; na placa NVIDIA, 7x o tempo real). O gabarito são **51 momentos** marcados por quem leu a live inteira minuto a minuto (fala, chat e volume) e conferiu na imagem os candidatos, **antes de ver o resultado do motor**: 6 de força 3 (cortaria com certeza), 22 de força 2, 23 de força 1. Ressalva: o gabarito vem de quem leu a transcrição (favorece o texto) e é uma live só. Os dados ficam fora do repositório.

| Execução (26 sugestões, gameplay) | Força 3 (6) | Força ≥ 2 (28) | Todos (51) | Sugestões no gabarito | Acaso igualar (força ≥ 2) |
|---|---|---|---|---|---|
| Antes das correções | 4 | 10 | 14 | 14 de 26 | < 0,1% |
| **Com as correções** (espera exige imagem parada; laço do Whisper ignorado) | **5** | **13** | **18** | **18 de 26** | **< 0,1%** |
| Com as correções, sem a pista de repetição | 5 | 13 | 17 | 17 de 26 | < 0,1% |
| Com as correções, perfil de conversa | 6 | 13 | 16 | 16 de 26 | < 0,1% |
| Com as correções, 12 por hora (52) | 5 | 15 | 21 | 23 de 52 | < 0,1% |

O que a medição mostrou:

- **Numa gameplay o motor funciona bem acima do acaso** (o acaso acerta 0,7 dos 6 momentos fortes e 2,4 dos 28 bons; o motor, 5 e 13). Acertou a luta de sniper contra um esquadrão, a morte do parceiro atropelado pelo trem, a baixa dupla, as crises de riso com abates e a provocação do chat sobre os xingamentos.
- **O defeito das "esperas"**: com a regra antiga, 18 trechos sem fala e com o som em silêncio digital (conversa de câmera, menus, carregamento) viraram espera e 7 episódios; a cota forçou 4 sugestões nesses "episódios" (todas fora do gabarito) e uma espera cortou um anúncio no fim da live. Com a imagem parada obrigatória: nenhuma espera aqui, e a live de podcast continua com os mesmos 10 episódios e os mesmos números.
- **O laço do Whisper** ("e horas e horas…", 1 fala) virava "ritmo de fala acelerou". Agora não conta.
- **O que continua escapando**: lutas em que o streamer quase não fala (o som do jogo domina e a imagem de gameplay mexe o tempo todo) e conversas longas sem exclamação (o perfil de conversa acha a melhor delas, mas perde outras). Das 8 sugestões que não estão no gabarito, 6 têm "repetição (bordão)" como motivo principal (gaguejo, eco do parceiro); desligar a repetição não trocou por coisa melhor.
- **O narrador do jogo** ("Baixa dupla", "Boa baixa", "Alvo abatido") marcaria abates, mas o Whisper só pegou 10 dessas falas em 4h18 (o filtro de ruído tira a voz do jogo): não vale como pista.
- **Corte começava na reação** (corrigido com o "início no lance", abaixo): numa gameplay a reação vem depois do lance (o trem atropelou 30 s antes do riso). Só aumentar a margem de antes (8 s) e a duração mínima (25 s) não bastava: o início ia para o começo de uma fala e o trem continuava fora.

### Início no lance (perfil de gameplay, 16/11/2026)

O corte começa no lance, não na reação (`combine`, opção `leadIn`; valores em `analyze.GAMEPLAY_LEAD`). Depois de definida a extensão do evento, o início volta **8 s** antes dele e, se o **som do jogo** estava ativo antes (pontuação do áudio de 0,2 ou mais), segue essa atividade para trás, aceitando **silêncios de até 15 s** e no máximo **40 s** antes do evento; desconta a margem de antes das Preferências. O fim não muda, a duração máxima continua valendo (o início para em fim − máximo), o início não invade o espaço nem a folga de outra sugestão e, com transcrição, vai para um **começo de fala**: o último até 6 s antes do novo início ou, sem ele, o primeiro depois (nunca depois do início que já existia). Sem fala no trecho (um lance silencioso), o início fica onde estava. Só no gameplay: o perfil de conversa já começa em frase completa.

Medido na mesma gameplay ("acerto" é a regra de sempre; "cobertura" é quanto do momento do gabarito fica dentro do corte):

| | Antes | Com o início no lance |
|---|---|---|
| Momentos fortes e bons (28) tocados por uma sugestão | 13 | 13 |
| Desses, o corte começa no lance (até 3 s depois do começo do momento) | 8 | **10** |
| Momentos com metade ou mais dentro do corte | 10 | **11** |
| Momentos com 80% ou mais dentro do corte | 4 | **5** |
| Cobertura média dos 28 | 31% | **34%** |
| Acertos força 3 / força ≥ 2 / todos (regra de sempre) | 5 / 13 / 18 | 5 / 13 / 17 |
| Duração média dos cortes | 29 s | 35 s |

O corte do trem foi de 3:00:23–3:00:45 (só o riso) para 2:59:48–3:00:45 (o atropelamento às 2:59:52 entra). A regra de acerto conta um a menos porque um corte que começa mais cedo passa a sobrepor menos de metade do próprio tamanho com o momento, mesmo cobrindo mais dele: a cobertura é a medida certa aqui. Silêncio de 12 s entre o lance e a reação não alcançava o trem; 15 s alcança e não estica os outros cortes à toa (18 s e pontuação 0,15 deram o mesmo). A live de podcast não muda (o perfil de conversa não usa; o de gameplay dá os mesmos 3 de 20 e 9 de 37). Limitação: a baixa dupla continua começando 11 s depois do primeiro abate, porque não há começo de fala no trecho e o início só vai para começo de fala.

## Filtro de ideias fracas e quantidade automática (16/11/2026)

**Por que:** o dono quer o máximo de cortes de uma live, com bom aproveitamento. Tirar só o teto da Quantidade enche a lista de ideias ruins: na gameplay de CoD (seção "Teste numa gameplay"), passar de 26 para 86 sugestões trouxe 10 momentos bons a mais e 50 ruins (precisão de 65% para 36%). Faltava descartar as fracas.

**O tipo de cada motivo** (`evidence` em cada sugestão, também no que o filtro descartou): `text:laugh`, `text:exclaim`, `text:meta`, `text:humor`, `text:structure`, `text:loop`, `text:repeat`, `text:pace`, `audio:level`, `audio:rise`, `image:scene`, `image:motion`, `chat:rate`, `chat:keywords`, `calm:calm` (cada `describe()` diz o `kind`; o filtro não lê o texto dos motivos).

**A regra** (`analyze.js`, `VOICE_EVIDENCE`): com transcrição, a sugestão precisa de ao menos uma **reação de voz** (risada, exclamação, fala sobre o momento, expressão do canal, estrutura, laço) **ou do chat**. No perfil de conversa o **ritmo de fala** também conta (num podcast é uma das pistas que mais pesam). Sem isso ela é descartada **dentro da escolha**: a vaga vai para o próximo pico e a descartada vai para `filtered` (até 300, com o motivo "sem reação de voz nem do chat"). Só na rodada dos picos: o momento calmo é calmo de propósito.

Medido nos 86 candidatos da gameplay (o motivo de cada um contra o gabarito de 51 momentos):

| Evidência | Candidatos | No gabarito | Fortes ou bons |
|---|---|---|---|
| reação de voz + volume | 24 | 16 | 13 |
| reação de voz sem volume | 14 | 7 | 3 |
| volume sozinho (às vezes com imagem) | 25 | 5 | 2 |
| volume + repetição ou ritmo | 14 | 2 | 0 |
| só repetição, ritmo ou imagem | 9 | 1 | 0 |

**Proteção:** o filtro só vale quando a transcrição **marca reações**: `stats.voiceSeconds` do sinal de texto (segundos com risada, exclamação, fala sobre o momento ou expressão do canal) precisa dar **30 ou mais por hora** (`MIN_VOICE_PER_HOUR`). Abaixo disso ele fica desligado e a análise avisa (`FILTER_OFF`). Medido: a transcrição do Whisper do app na gameplay marca 61 por hora; a de uma live de podcast importada de um arquivo de texto, 20 (sem risadas e com poucas exclamações), e lá o filtro sem a proteção descartava quase tudo (3 sugestões restantes, nenhum acerto). O corte de 30 vem de duas transcrições: é prudente, não calibrado.

**Quantidade automática** (`autoQuantity`): sem teto por hora; o que decide é a relevância mínima e o filtro, com trava de segurança de 30 por hora e 5 por janela de 10 min (`AUTO_PER_HOUR`, `AUTO_PER_WINDOW`). O momento calmo continua com a cota da Quantidade escolhida (um quarto do "por hora"). Um teto absoluto (`maxSuggestions`) continua mandando.

| Gameplay de CoD (4h18; gabarito de 51) | Sugestões | Fortes (6) | Fortes e bons (28) | Todos (51) | Precisão |
|---|---|---|---|---|---|
| 6 por hora, sem filtro (antes) | 26 | 5 | 13 | 17 | 65% |
| 6 por hora, com filtro | 26 | 5 | 14 | 17 | 65% |
| automática, sem filtro | 124 | 5 | 19 | 34 | 35% |
| **automática, com filtro** | **55** | **5** | **17** | **27** | **51%** |

| Live de podcast (1h59; filtro desligado sozinho: 20 reações por hora) | Sugestões | Gabarito de 20 | Gabarito de 37 |
|---|---|---|---|
| conversa, 6 por hora | 12 | 5 | 10 |
| conversa, automática | 30 | 8 | 14 |
| gameplay, 6 por hora | 12 | 3 | 9 |

Leitura: a automática com o filtro dá **10 momentos a mais** que a Quantidade fixa na gameplay (27 contra 17) com o dobro de sugestões para revisar e metade delas boa; sem o filtro seriam 124 sugestões com duas ruins para cada boa. Com a Quantidade fixa o filtro troca uma ideia fraca por uma boa (13 para 14). Ressalvas: o gabarito da gameplay foi feito por quem leu a transcrição (favorece as reações de voz) e são duas lives.

## Risada do chat, fim do corte cobrindo a risada e quantidade automática mais aberta (16/11/2026)

Releitura completa da gameplay de CoD (seção "Teste numa gameplay") para uma **seleção nova** feita à mão: 69 momentos, 8 fortes, 29 bons e 32 só para a comunidade. Com ela deu para ver o que o algoritmo perdia e por quê. Numa passada bem aberta (sensibilidade 5, relevância mínima 15%, sem teto) ele enxerga 35 dos 37 momentos fortes ou bons; na quantidade automática de antes ficava com 17. O gargalo não era falta de sinal: era a escolha. Três mudanças, nenhuma presa ao jogo:

**1. Risada escrita num chat pequeno** (`chatSignal.js`, evidência `chat:laugh`, motivo "o chat riu"). Um chat de poucas pessoas (menos de 3 mensagens por minuto na média do vídeo, `SMALL_CHAT_RATE`) nunca chega a "6 mensagens em 10 s" nem a "3 com palavra-chave": na live medida (386 mensagens em 4h18) o sinal de chat não gerava **nenhuma** evidência. O que diz algo ali é a risada escrita ("kkkk", "haha", "rsrs", "kaka", "lol", os emojis de riso): cada mensagem pontua os segundos de 3 a 35 **antes** dela (`REACT_BACK_MIN_SEC`, `REACT_BACK_MAX_SEC`; atraso da transmissão mais o tempo de digitar) com 0,45 (`LAUGH_ONE`; duas mensagens, 0,70), ou seja, uma risada sozinha não vira sugestão. Medido: 35% das risadas do chat caem num momento forte ou bom (20% ao acaso) e 15 dos 37 fortes ou bons têm uma. No **filtro de ideias fracas** ela vale como reação só **junto de fala animada** (ritmo ou repetição): com volume alto e mais nada acertou 27%, contra 43% com a fala animada. Chat grande continua como era (velocidade e palavras-chave).

**2. O corte termina depois da risada** (`combine.js`, `tailOut`; `REACTION_TAIL` em `analyze.js`). A pista da risada pontua os segundos **anteriores** a ela (a risada vem depois do lance), então o corte acabava quando a risada começava: nas quatro crises de riso da live, as quatro saíam cortadas no começo da risada, sem ela e sem o comentário que fecha. Agora, se há risada marcada na transcrição do fim do corte em diante (tolerando buracos de 4 s), o fim vai até o fim dela, no máximo 30 s a mais e sem sair do espaço livre; se estourar a duração máxima, quem anda é o começo (o desfecho vale mais que a preparação), sem passar do pico. Vale nos dois perfis.

**3. Quantidade automática: um degrau mais sensível, e uma pista sozinha não basta.** Só quando o filtro de ideias fracas está valendo (transcrição que marca reações):
- a detecção roda com a **sensibilidade + 1** (`result.filter.autoSensitivity`); na sensibilidade 5 não muda;
- a sugestão precisa de **duas famílias de pista** (`FAMILIES`: reação de voz, chat, volume, ritmo da fala; a imagem não conta, porque troca de cena acontece em quase todo trecho de jogo) ou de duas reações de voz diferentes; senão é descartada com "uma pista só (sem outra que confirme)". Cada sugestão traz `agreement` (0 a 4 famílias).
Sem o filtro (transcrição sem marcas de reação, ou o filtro desligado) a quantidade automática é a de antes.

**Risada longa se confirma sozinha.** Duas ou mais marcas de risada em ~15 s levam também a evidência `text:laughrun` (`textSignal.js`, campo `also` do motivo; o `combine` aceita tipos extras por motivo). Na primeira versão da trava, a crise de riso mais longa da live (12 marcas seguidas) era descartada na automática como "uma pista só": visto na análise feita pelo dono no app, onde o projeto não tinha chat. A risada solta continua precisando de outra pista.

| Gameplay de CoD (4h18), contra a seleção nova | Sugestões | Fortes (8) | Fortes e bons (37) | Todos (69) | Aproveitamento | Acertos nas 20 primeiras |
|---|---|---|---|---|---|---|
| 6 por hora, antes | 26 | 4 | 14 | 19 | 69% | – |
| **6 por hora, agora** | 26 | **5** | **15** | 20 | **73%** | – |
| automática, antes | 55 | 4 | 17 | 29 | 53% | 16 |
| **automática, agora** (com o chat) | 76 | **6** | **26** | 38 | 49% | **17** |
| automática, agora, sem chat no projeto | 57 | 5 | 21 | 31 | 53% | – |

Contra a lista antiga de 51 momentos (feita **antes** de ver qualquer resultado): 6 por hora, 15 fortes ou bons de 28 (antes 14); automática, 22 de 28 e 33 de 51 com 76 sugestões (antes 17 e 27 com 55). Na live de podcast de controle (transcrição sem marcas de reação: o filtro se desliga), os quatro resultados ficaram **idênticos** aos de antes.

Leitura: na automática entram 9 momentos fortes ou bons a mais, com 21 sugestões a mais; como a lista vem em ordem de relevância e o topo ficou igual ou melhor (17 acertos nas 20 primeiras, contra 16), o que entra a mais fica no fim. Os 2 fortes que o algoritmo ainda perde são conversas (um desafio de pergunta e resposta e uma história com imitação; sem o chat perde também uma história contada): ali quem acha é a IA (seção "Algoritmo + IA").

**Testado e descartado** (para ninguém refazer):
- **Ordenar a lista pela concordância** das pistas (mais famílias primeiro): piorou o topo (12 acertos nas 20 primeiras contra 16 da relevância). A concordância separa bem só o caso de uma família (10% de acerto numa lista bem aberta, contra 38% a 69% com duas ou mais), e isso a trava da automática já resolve.
- **Risada do chat como reação por si só**: 25 sugestões a mais com 7 acertos (28%).
- **Ritmo de fala como reação no perfil de gameplay**: 3 fortes ou bons a mais com 20 sugestões a mais; ficou só como apoio da risada do chat.
- **Tela avermelhada** (morte ou queda do jogador; lida a 2 quadros por segundo): 70 eventos, 41% são morte ou queda e 30% são cenário vermelho; nenhuma regra simples separou. Serviria de reforço (sugestão com tela vermelha acerta 75% contra 47%), mas a cor do dano muda de jogo para jogo. Não implementado.

Ressalvas: uma live de um jogo só; a seleção nova foi feita por quem já tinha visto os resultados dos motores; o chat medido tem três pessoas. As regras foram escolhidas por serem gerais (reação do público, fim do corte, confirmação entre pistas), mas falta medir em outros jogos e em lives com chat grande.

## Algoritmo + IA (16/11/2026)

**Por que:** na gameplay de CoD (seção "Teste numa gameplay") os dois motores acharam coisas diferentes: a IA acha as **conversas** sem grito nem riso (perguntas e respostas, histórias, piadas que voltam horas depois) e o algoritmo acha as **reações e lances** (crises de riso, baixas, abates com riso). Juntos cobrem mais do que cada um sozinho.

**Como roda** (`combo.js`): primeiro confere o que a IA precisa (provedor pronto, aviso aceito, transcrição deste vídeo; sem isso falha na hora, sem rodar o algoritmo); depois o **algoritmo** (metade da barra, mensagens "Algoritmo: …") e, quando ele termina, a **IA** (a outra metade, "IA: …"). A tela só vê um jobId; os eventos dos trabalhos internos não chegam a ela. Se a IA falha no meio (rede, cota, chave), ficam as sugestões do algoritmo com o aviso `AI_FAILED`; se o algoritmo falha, a IA roda e fica sozinha (`ALGORITHM_FAILED`); se os dois falham, vale o erro da IA. Cancelar cancela o trabalho da vez. A IA recebe o mesmo pedido de sempre (não recebe o resultado do algoritmo).

**A junção** (`merge.js`):
- **Mesmo momento** = a regra do placar (`scripts/eval-analysis.js`): começos a até 5 s um do outro, ou sobreposição de metade do menor. Cada sugestão casa com uma só do outro motor (a de maior sobreposição primeiro). O par vira **uma** sugestão com `engines: ['algorithm', 'ai']`: bordas da **união** (do começo mais cedo ao fim mais tarde; se passar da duração máxima, as bordas da IA), relevância `1 - (1 - a)(1 - b)`, os motivos dos dois (os da IA primeiro), título, categoria, enquadramento e palavras-chave da IA, evidência e episódio do algoritmo.
- O que só um motor achou entra como veio (`engines: ['algorithm']` ou `['ai']`); o da IA ganha o episódio pelo instante do pico.
- **Ordem** ("mais relevantes primeiro"): o que os **dois** acharam vem primeiro; depois alterna um da IA e um do algoritmo, cada um na própria ordem de relevância. As relevâncias dos dois não estão na mesma escala (a do algoritmo encosta em 100% nos picos fortes), então ordenar tudo pelo número misturaria mal.
- Cada cartão mostra um chip **Algoritmo + IA**, **IA** ou **Algoritmo**; o resumo conta "N que os dois acharam, N só da IA, N só do algoritmo", os sinais do algoritmo e as chamadas da IA. Quantidade: cada motor segue a própria (o teto da lista é a soma das duas).

Medido na gameplay de CoD (4h18; gabarito de 51 momentos, 6 fortes e 28 fortes ou bons; mesma regra de acerto). A IA é a análise do Gemini 3.8 Flash feita no app; a junção foi calculada pelo `merge.js` sobre os resultados guardados das duas análises (sem rodar a IA de novo). "Precisão" = parte das sugestões que bate com algum momento do gabarito.

| Motor | Sugestões | Fortes (6) | Fortes e bons (28) | Todos (51) | Precisão |
|---|---|---|---|---|---|
| Algoritmo, 6 por hora, com filtro | 26 | 5 | 14 | 17 | 65% |
| IA na nuvem | 18 | 4 | 11 | 16 | 89% |
| **Algoritmo + IA, 6 por hora** | **41** | **6** | **21** | **27** | **73%** |
| Algoritmo, quantidade automática, com filtro | 55 | 5 | 17 | 27 | 51% |
| **Algoritmo + IA, quantidade automática** | **66** | **6** | **23** | **34** | **56%** |

- Bordas: com a união, 18 dos 21 acertos fortes ou bons começam no lance (17 com as bordas só da IA ou só do algoritmo) e a parte coberta de cada momento sobe de 54% (bordas da IA) para 56%.
- Ordem: nas 20 primeiras da automática, 17 acertos alternando os motores contra 15 ordenando pela relevância.
- Por motor (automática): o que os dois acharam acertou 7 de 7; só a IA, 9 de 11; só o algoritmo, 21 de 48.
- Fora do gabarito (automática): 29 das 66 sugestões, 27 só do algoritmo e 2 só da IA. Conferidas pela transcrição e, nas 12 reações de jogo, por quadros do vídeo (sem ouvir o áudio): **4 são momentos reais que o gabarito não tinha** (os 2 da IA, conversas; e 2 do algoritmo, mortes com reação que quase não têm fala), 4 são lances simples e 21 são fracas (risadas soltas, conversa técnica ou de menu, saque e captura de contrato). Contando os 4, 41 das 66 sugestões são boas (62%). O gabarito não foi alterado.
- Ressalvas: uma live só e um modelo de IA só (um modelo mais fraco acharia menos e pior); o gabarito foi feito por quem leu a transcrição (favorece o que tem fala); leva o tempo dos dois motores.

**A IA confere o que só o algoritmo achou** (16/11/2026, ligado por padrão): depois das passadas dela, a IA lê a fala de cada sugestão que só o algoritmo trouxe e diz se vale um corte; a junção tira as recusadas e as guarda, com o motivo, numa seção recolhida. Ela também acerta o início e o fim de cada uma que fica (lê até 40 s antes e 15 s depois). Falha ou falta de resposta nunca tira sugestão. Detalhes e limites em `analise-ia.md`, 17.10 e 17.11.

**Reserva entre provedores de IA** (16/11/2026): até 3 provedores de reserva, na ordem, assumem quando o escolhido falha por limite de uso, cota ou erro do servidor (chave recusada não troca). O app lê o limite de tokens por minuto que o provedor informa e, se ele é baixo (a Groq no plano gratuito, por exemplo), encolhe os blocos da análise para caber, com mais chamadas. Detalhes e limites em `analise-ia.md`, 17.12.

## Só os melhores (16/11/2026)

Pedido do dono: o motor recomendar só quando o corte for bom ou forte. A aba ganhou o interruptor **"Só os melhores"** (`#anBestOnly`), acima de "Quantidade automática". Os dois são opostos: ligar um desliga o outro.

- **O que faz:** a lista fica curta, só com as sugestões de nota mais alta. É um atalho para a quantidade **fixa de 4 por hora** (`BEST_ONLY_PER_HOUR`), sem a quantidade automática. O controle "Quantidade" fica travado e a saída dele diz "só os melhores: 4 por hora (até N neste vídeo)".
- **Onde vive:** só na aba. O ajuste fica em `ext.analysis.settings.bestOnly`; o valor do controle por hora que o usuário tinha escolhido continua guardado. No pedido de análise vão `perHour: 4` e `autoQuantity: false` (`applyBestOnly`); o motor não tem um parâmetro novo.
- **Projeto que traga os dois marcados** abre com "Só os melhores" (vale o mais exigente).

**Por que a quantidade, e não a relevância mínima.** Medido na live de gameplay de 4 h (seção "Teste numa gameplay"), contra a seleção feita à mão (37 momentos fortes ou bons, 8 deles fortes), com Algoritmo + IA:

| Ajuste | Sugestões | Batem com um forte ou bom | Acerto | Cobrem dos 37 | Fortes (8) |
|---|---|---|---|---|---|
| quantidade automática | 80 | 31 | 39% | 30 | 7 |
| 10 por hora | 51 | 25 | 49% | 24 | 7 |
| 8 por hora | 43 | 24 | 56% | 23 | 7 |
| 6 por hora | 36 | 23 | 64% | 22 | 7 |
| **4 por hora ("Só os melhores")** | **28** | **22** | **79%** | 21 | 7 |
| só o que a IA achou | 17 | 15 | 88% | 15 | 7 |

Algoritmo sozinho: automática 76 sugestões e 34% de acerto; 6 por hora, 26 e 58%; 4 por hora, 17 e 76% (4 dos 8 fortes).

- **O que derruba o acerto é o que só o algoritmo acha**: 16 de 63 batem com um forte ou bom, contra 15 de 17 no que a IA achou.
- **A nota do algoritmo é o melhor filtro dele.** Exigir mais famílias de pista, um tipo de pista ou mais pistas somadas não ganha de simplesmente ficar com as notas mais altas, e é isso que a quantidade fixa faz.
- **Um mínimo absoluto de nota não serve.** A escala muda com os sinais que o vídeo tem: na live de podcast as notas param em 0,98 e só 3 de 30 sugestões passam de 95%. E a "Relevância mínima" das Preferências vale também para a IA, cujas sugestões boas vêm com 70% a 80%.
- **Na live de podcast de controle a direção é a mesma:** 70% de acerto com as 30 sugestões, 80% nas 10 de nota mais alta e 100% nas 6 de cima.

Limites: uma live de um jogo só e uma seleção feita por quem já tinha visto resultados do motor. Com a IA a medição usou a lista dela de uma rodada em quantidade automática; uma rodada inteira com "Só os melhores" ligado ainda não foi feita. Teste: `analysis-ui` ("Só os melhores").

## Teste contra dados do público (16/11/2026)

Preocupação do dono: o motor precisa achar trechos que funcionem publicados; a medição na live de gameplay era contra uma seleção feita à mão. Este teste usa dado do público.

**Como foi.** 17 lives de três canais de jogos e variedades (31 horas), em 240p. Só o **algoritmo** (sem IA, sem chat), no perfil de gameplay, com a legenda automática do YouTube como transcrição (`[risadas]` vira risada; o palavrão censurado vira palavra de reação; não há pontuação). Régua: o gráfico de "mais reassistidos" do YouTube (100 faixas por vídeo, no `heatmap` dos metadados; a primeira faixa fica de fora). Referência: as mesmas sugestões sorteadas em outros pontos da mesma live, mil vezes. "Sorte" é a parte dos sorteios que empata ou ganha do motor.

| Medida | Automática (642 sugestões) | Acaso | Sorte | Só os melhores (152) | Acaso | Sorte |
|---|---|---|---|---|---|---|
| posição média no gráfico (0 a 100) | 56 | 51 | < 0,1% | 58 | 51 | < 0,1% |
| sugestões nos 20% mais reassistidos | 25% | 19% | < 0,1% | 28% | 19% | 0,5% |
| trechos mais reassistidos tocados (5 por live, 85 no total) | 62 | 37,6 | < 0,1% | 24 | 11,5 | < 0,1% |
| shorts publicados achados (13, de um canal só) | 7 | 4,6 | 15% | 2 | 1,3 | 37% |

- **Acima do acaso nos três canais, com margem modesta**: 25% das sugestões caem num trecho muito reassistido, contra 19% do sorteio.
- **Contra os shorts publicados nada se pode afirmar** (13 shorts). E as duas réguas discordam: os shorts publicados ficam na posição 44 do gráfico. O que o canal publica não é o que o público mais reassiste dentro da live.
- **A nota do motor ordena bem**: o terço de nota mais alta fica na posição 61 (30% nos 20% de cima), o do meio em 58 e o de baixo em 49, igual ao acaso. Vale em dois dos três canais.
- **O sinal de momentos calmos aponta para o lado errado nessas lives**: as 42 sugestões desse tipo ficam na posição 34, nos três canais (32, 36 e 35). Na live de gameplay medida à mão, 1 de 7 era boa. O sinal foi feito para jogos de história; em jogo competitivo e live de conversa ele traz o que o público pula.
- **Por pista** (com e sem): risada 62 e 54; mudança de cena 63 e 52; volume acima do normal 61 e 53; exclamação 59 e 51; repetição 58 e 49. Subida brusca de volume (56 e 56) e fala sobre o próprio momento (53 e 57) não se separam.

Limites: o gráfico mede o que se reassiste na live inteira, não o que funciona como vídeo curto; as faixas são largas (de meio minuto a dois minutos); um dos canais é de variedades; sem pontuação na legenda. **Nada foi mudado no motor por causa deste teste.**

## Cache e cancelamento

- **Onde**: `userData/cache/analysis/` (arquivos nossos; apagar ali nunca toca em arquivo do usuário). Dois níveis: `sig-audio-*` / `sig-image-*` (o que o ffmpeg extraiu, a parte cara) e `res-*` (resultado final). Mudar sensibilidade, pesos ou margens reaproveita os `sig-*` e só refaz a combinação (instantâneo). A chave do resultado inclui a **impressão digital da transcrição**: outra transcrição recalcula (sem reler o vídeo). No máximo 80 arquivos (os usados há mais tempo saem); gravação atômica (tmp + rename); arquivo ilegível ou de outra versão do algoritmo conta como ausente.
- **Chave da fonte**: SHA-1 do tamanho + 3 trechos de 256 KiB (início, meio e fim). Não depende de nome nem de data (copiar ou renomear o vídeo mantém o cache); uma gravação que ainda cresce muda a chave.
- **`RESULT_REVISION` (`params.js`, 2 desde 16/11/2026)** entra só na chave do resultado: quando o cálculo das sugestões muda sem mudar a leitura do vídeo nem os parâmetros (2: espera com imagem parada, laço do Whisper, início no lance; 3: filtro de ideias fracas e o tipo de cada motivo), o resultado é refeito com os sinais do cache, sem ler o vídeo de novo. Sem ela, quem já tinha analisado o vídeo receberia o resultado antigo.
- **`ALGO_VERSION` = 4.** Mude quando a forma de calcular mudar. A versão 4 invalida os resultados da 3 (pontuação linear saturada, áudio medido contra o silêncio). A versão 3 tinha invalidado os da 2, que podiam terminar depois do fim do vídeo.
- **Resultado incompleto não é guardado**: se um sinal falhou, ou o ffmpeg saiu com erro depois de dar dados (`*_PARTIAL`), nem o resultado final nem aquele sinal vão para o cache. Uma falha passageira (antivírus, disco, processo morto) não vira resultado permanente; a próxima análise lê o vídeo de novo. Resultado com **aviso de cobertura** (`*_SHORT`, `AUDIO_SILENT`, `TEXT_SHORT`) é determinístico (o arquivo é aquele) e é guardado.
- **Analisar de novo, sem usar o guardado** (`fresh:true`): ignora `res-*` e `sig-*` e regrava.
- **Cancelamento**: `AbortSignal` encerra os ffmpeg (a promessa só resolve depois de eles saírem), rejeita com `CANCELLED` e não grava cache. `before-quit` encerra o que estiver rodando.

## Avisos (nunca bloqueiam)

| Código | Quando |
|---|---|
| `NO_AUDIO` | o vídeo não tem faixa de áudio |
| `CHAT_UNREADABLE` | o arquivo de chat não pôde ser lido (baixe de novo na aba Novo projeto) |
| `AUDIO_FAILED`, `IMAGE_FAILED` | o ffmpeg não conseguiu ler esse sinal |
| `AUDIO_PARTIAL`, `IMAGE_PARTIAL` | o ffmpeg terminou com erro depois de dar dados: arquivo truncado/danificado; foi usado o que deu para ler |
| `AUDIO_SHORT`, `IMAGE_SHORT` | o ffmpeg saiu sem erro mas leu bem menos que a duração do arquivo (gravação cortada): diz até onde foi ("só foi possível ler o áudio até 0:22 (o vídeo tem 0:40)"). Tolerância: o maior entre 5 s e 3% da duração (30 s para a imagem em modo rápido, que só tem quadros-chave) |
| `AUDIO_SILENT` | nenhuma janela da faixa lida passa de −90 dBFS: a primeira faixa está muda (vídeo com várias faixas); o texto lembra que só a primeira faixa é lida |
| `TEXT_SHORT` | a transcrição cobre menos de 90% do vídeo: diz até onde ("cobre só 49% do vídeo (até 0:59): o texto não ajuda no que vem depois disso") |

Os avisos aparecem na aba enquanto o resultado é daquele vídeo. Se nenhuma sugestão passa dos critérios e há avisos, a mensagem de lista vazia manda conferi-los antes de mexer nos ajustes. O sinal de texto ignorado **não** gera aviso: o motivo fica em `result.signals.text.reason` ("este vídeo não tem transcrição…", "a transcrição guardada é de outro arquivo de vídeo", "desligado").

## Dados no projeto

```js
project.analysis.lastRun = { at, signals: ['audio', ...], params, count }          // contrato 2.1
project.ext.analysis = {
  settings,                  // ajustes deste vídeo (sinais, sensibilidade, quantidade, pesos, pesos das pistas do texto, chat, imagem, motor)
  source: { path, size, duration },   // vídeo para o qual o resultado vale
  runAt, fromCache, tookMs, limit, signals, warnings,
  engine,                    // 'algorithm', 'ai' ou 'both' (o motor desta análise); ai: o resumo da IA (nos dois últimos)
  merge: { both, ai, algorithm, aiFailed?, algorithmFailed? },   // só no Algoritmo + IA: de onde veio cada sugestão
  filter: { on, discarded },   // o filtro de ideias fracas: se valeu nesta análise e quantas descartou
  episodes: [{ start, end }], breaks: [{ start, end }],   // episódios e telas de espera achados (vazios sem espera ou com a opção desligada)
  suggestions: [{ id, start, end, peak, relevance, reasons, episode?, engines? }],   // engines: só no Algoritmo + IA (['algorithm'], ['ai'] ou os dois)
  dismissed: [{ start, end, peak, at }],  // descartadas (até 300); somem da lista sem virar corte
  listOrder                  // 'relevance' (padrão) ou 'time': a ordem da lista na tela (só a exibição; "Adicionar todas" segue a relevância)
}
```

- **`source` é a identidade do resultado.** O `project:adopt` copia o `ext` inteiro para o vídeo novo; sem essa conferência as sugestões, os avisos e as descartadas do vídeo antigo apareceriam como se fossem do novo (tempos de outra linha do tempo). A aba só mostra resultado, avisos e selo quando `source` bate com `project.source` (mesmo caminho, mesmo tamanho e duração com folga de 1 s); os **ajustes** (`settings`) acompanham a adoção. Uma nova análise grava a identidade nova e descarta as `dismissed` de outro vídeo. Resultado sem `source` (de uma versão antiga) não é mostrado até analisar de novo.
- `settings` antigos continuam valendo: `signals.text` e `weights.text`/`textWeights` ausentes usam os padrões, e a antiga `audioHints` (dicas de volume da IA, removida) é ignorada.
- Uma sugestão **descartada** é um intervalo: uma análise nova esconde as sugestões que ele cobre pela mesma regra de "já coberta" dos cortes (o pico dentro, mais de 20% da sugestão ou 50% do menor dos dois). Restaurar uma sugestão mantém descartadas as outras que o mesmo intervalo cobria.
- Regra de título: a análise só **cria** cortes ("Sugestão m:ss"); nunca renomeia um existente, muito menos um com `titleCustom === true`.

## Resultado na live real

Medido em 23/10/2026 na live `NtadPdBszjk` (3 h 05, 1440p60, 73 mensagens de chat, transcrição do Whisper com 2.195 falas) contra o gabarito de 15 cortes (bate = início até 5 s de diferença ou 50% de sobreposição). **A metodologia, a tabela completa, a referência do acaso e as ressalvas estão em [analise-ia.md](analise-ia.md), seção 13.** Resumo (padrão: sensibilidade 3, 6 por hora = 18 sugestões):

| | Antes (v3) | Depois (v4) |
|---|---|---|
| Revocação, vídeo todo | **0/15 (0%)** | **4/15 (27%)** |
| Precisão aproximada | 0/18 | 4/18 (22%) |
| Metade de ajuste (0–90 min), rodada como vídeo independente | 0/6 | 2/6 (33%) |
| Metade de teste (90–185 min), rodada como vídeo independente | 0/9 | **1/9 (11%)** |
| Sugestões nos primeiros 7 min | todas (18 de 18) | nenhuma (começam entre 26:05 e 184:32, no máximo 2 por janela de 10 min) |
| Com 12 por hora (37 sugestões), vídeo todo | n/d | 8/15 (53%) |
| Sem transcrição (áudio, imagem e chat corrigidos), 18 sugestões | 0/15 | 0/15 |

**Leitura honesta:** a melhora sobre a linha de base é real mas **modesta no padrão** e vem **só do sinal de texto** (sem transcrição o resultado é o do acaso: o que a correção do áudio e da imagem faz é parar de errar de um jeito sistemático e distribuir as sugestões, não acertar mais). Na metade de teste o padrão não se distingue do acaso (acaso: 0,8 acerto em 9; o resultado rodado sozinho foi 1 de 9). É **uma live só**, com 15 itens, e o gabarito foi escolhido por quem leu a transcrição (**circular**: favorece o sinal de texto). Ajustar mais, com tão poucos itens, só sobreajustaria.

## Decisões provisórias (a confirmar com a Liz)

- **Todos os critérios de "bom momento"**: sinais, fórmulas, limiares, pesos (áudio 0,8, imagem 0,6, chat 1, texto 1), pesos das pistas (1), sensibilidade 3, 6 sugestões por hora, relevância mínima 0,5, margens 3 s antes e 2 s depois, duração de 15 a 60 s, atraso do chat de 6 s, palavras `clip pog omg wtf`, cota de 2× a média por janela de 10 min e folga de 5 s. Calibrados com mídia e chat sintéticos e **uma única live real** (a v4 também foi medida nela: seção "Resultado na live real"). Os pesos não foram ajustados à live: partiram da análise manual (texto e chat valem mais, o volume sozinho engana).
- **Descartar não cria corte e não é decisão**: fica em `ext.analysis.dismissed`, sem `decision` e sem entrar no histórico da revisão nem no aprendizado de preferências. É o comportamento mais seguro; se a Liz quiser que um descarte conte como evidência contra aquele tipo de trecho, é um tipo novo de evento (pedido abaixo).
- **Resultado de outro vídeo é escondido**, não apagado (continua no arquivo do projeto até a próxima análise).
- **Limites dos avisos de cobertura**: 5 s ou 3% (30 s no modo rápido), 90% para a transcrição e −90 dBFS para "sem som".
- **Analisar de novo (`fresh`)** fica nos ajustes avançados (recolhido), não na tela principal.
- **Listas de palavras do texto em português** (reação e fala sobre o momento): não são editáveis na tela (só os pesos); mudar a lista é mudar `textSignal.js`.

## Limites conhecidos

- **Momento calmo (v5): calibrado com pouco e sem gabarito.** Foi calibrado num short real (37 s de Minecraft, sem fala: o som é só o "plom plim" de cada bloco colocado, a −42 dB de média e sem picos) emendado no meio de uma live de 4,7 h (do cache de análise de uma live real; a emenda é o curto no lugar de 37 s da live) e conferido na própria live: o trecho emendado é achado, e a live sozinha dá 24 trechos calmos de ≥ 10 s (16 com a transcrição dela como "sem fala"). **Não há gabarito do que o dono considera um bom momento calmo**, então nada disto mede qualidade, só que o sinal acha o que descreve. O que ele **não** distingue: música bonita de silêncio constrangedor, tela de carregamento com a imagem animada, fala baixa quando não há transcrição. Um vídeo calmo do começo ao fim (um short, uma live toda em silêncio) não tem "normal" para comparar e não gera sugestão. Com os outros sinais ligados e a transcrição da live medida, o calmo acrescentou 7 sugestões (a cota própria) e **não tirou nenhuma** das 28 de antes.
- **Uma live real só, e o gabarito é circular.** Os 15 cortes de referência foram escolhidos por quem **leu a transcrição** (o assistente), então o sinal de texto é favorecido por construção, e uma live não representa todas. A melhora medida é real contra a linha de base (que não acertava nada), mas **não** prova qualidade em outros conteúdos; o chat real da live tem só 73 mensagens e quase não contribui.
- **O texto é o único sinal que mexeu o ponteiro.** Na live medida, áudio e imagem sozinhos (sem transcrição) distribuem as sugestões pela live inteira, mas acertam o que o acaso acertaria. O volume sozinho continua enganando: nível alto não é graça.
- **Episódios: medido em duas lives** (uma de podcast com espera em silêncio digital e arte totalmente parada, que acha os 10 episódios; uma gameplay sem espera nenhuma, que agora não marca nada). **Não é achada** a espera com arte **animada** (vinheta em laço, contagem regressiva) **e** música, a menos que a transcrição mostre a falta de fala por 30 s; nem a espera com alguém falando por cima da arte. Um jogo pausado em menu parado e mudo por 30 s ou mais vira intervalo (o que, num corte, não faz falta). A cota não aumenta a Quantidade.
- **Uma faixa de áudio** (a primeira). Em gravações do OBS com várias faixas a primeira costuma ter a mistura; se estiver muda, o `AUDIO_SILENT` avisa, mas não há seleção de faixa.
- **Áudio com fala rara sobre fundo quase mudo** (ambiente de −61 dB com uma fala de vez em quando): a fala passa a ser o destaque (o fundo é o "normal"), já que não há como distinguir fala de evento só pelo nível; com fala em 20% do tempo ou mais, o normal é a fala.
- **Imagem**: só luminância (mudança só de cor não aparece); o modo rápido é grosseiro. Em gameplay a "mudança de cena" é comum (câmera, menus: "mudança de cena" aparece em 11 das 18 sugestões da live medida), por isso a imagem pesa 0,6 e sozinha mal passa da relevância mínima.
- **Texto**: depende da qualidade da transcrição (o Whisper erra nomes, alucina em ruído e, às vezes, repete `*Risos*` em laço, que é tratado como uma risada). Sem pontuação (legenda automática) a pista de exclamações enxerga menos. Idiomas que não o português só usam risada, ritmo e repetição.
- **Faixas de duração**: as Preferências `analysis.minDurationSec/maxDurationSec` usam as faixas da análise (3 a 120 e 5 a 180: `src/core/preferences/keys.js` as lê de `RANGES` em `params.js`, então mudar uma faixa aqui muda a outra). Um valor antigo fora da faixa continua sendo limitado pela análise, e a aba avisa ("Atenção: … fica fora do que a análise aceita").
- **Cortes curtos**: as sugestões da live medida têm 17 a 40 s (média 27 s), mais curtas que os 33 a 75 s do gabarito; elas crescem com a duração mínima das Preferências.
- **`analysis.sensitivity`** ainda não existe como preferência (a sensibilidade é por projeto).
- **Duração desconhecida** (ffprobe sem duração, mesmo depois da leitura dos pacotes): a grade vem do que o ffmpeg mediu (ou do fim da transcrição) e o fim da última sugestão pode passar um pouco do fim real.
- **Tempo restante**: estimativa linear pela proporção feita; áudio e imagem andam em paralelo e a imagem domina, então oscila no começo.
- **Carga do computador**: o ffmpeg roda com prioridade abaixo do normal, então com o computador saturado a análise fica muito mais lenta (a de 20 min levou 550 s sob carga e poucos segundos em repouso; a leitura de uma live de 3 h com imagem em modo rápido levou ~58 min com outros testes rodando). Os testes esperam por condição, não por tempo curto.
- `project:adopt` leva `ext.analysis` inteiro para o projeto novo (os resultados do vídeo antigo ficam no arquivo, escondidos pela aba).
- Só Windows foi executado.

## Desempenho (medido neste computador, ffmpeg real, vídeo 320×180 a 15 quadros/s, com outros testes rodando)

| Vídeo | Modo normal | Modo rápido | Memória (pico) |
|---|---|---|---|
| 3 min | 0,8 s (215× o tempo real) | 0,8 s (237×) | node 53 MB (+5 MB), ffmpeg 23 MB |
| 20 min | 2,4 s (509×) | 1,6 s (753×) | node 55 MB (+2 MB), ffmpeg 33 MB |
| 3 h de áudio em fluxo (PCM simulado) | 1,3 s para 21.602 janelas | | RSS 58 → 58 MB (+0 MB) para 330 MB de PCM |

Pontuar e combinar uma live real de 3 h **com os sinais já extraídos** (4 sinais, 2.195 falas): ~0,2 s no total (áudio 22 ms, imagem 8 ms, chat 8 ms, texto 52 ms, combinação 33 ms para 18 sugestões e 153 ms para 185). A leitura dessa live (12,5 GB, 1440p60) com o ffmpeg em prioridade baixa levou ~87 s para o áudio e ~58 min para a imagem em modo rápido, com outros testes rodando. A memória não cresce com a duração (o áudio é decodificado em fluxo; só fica um número por janela). Os números dependem da carga: veja o limite acima.

## Pedidos de contrato (para `arquitetura.md`)

1. **5.9**: `analysis:start { path, params?, chatPath?, fresh?, projectId?, size?, duration? }`: com `projectId` (e `size`/`duration`) o algoritmo procura a transcrição do projeto e a usa como sinal de **texto**; `result.signals.text = { used, reason, cues?, laughs? }`; `result.usedSignals` pode trazer `'text'`; novo aviso `TEXT_SHORT`; `ALGO_VERSION` **4**; `params.signals.text`, `params.weights.text`, `params.textWeights` (`laugh`, `exclaim`, `pace`, `repeat`, `meta`) e `params.spread` (`windowSec`, `perWindow`, `minGapSec`); a relevância nunca chega a 1,0 por sinal (teto 0,97). `result.source.duration` continua sendo a do ffprobe e nenhuma sugestão termina depois dela.
2. **5.9 (IA)**: `analysis:start` com `engine:'ai'` **não aceita mais `audioHints`** (dicas de volume removidas; a linha de `arquitetura.md` que cita `audioHints?` deve sair); `result.signals` do motor de IA não traz mais `audio`; o método de IA vai para a versão 2 (mensagem de sistema sem dicas de áudio).
3. **5.3**: `project.ext.analysis.settings` ganhou `signals.text`, `weights.text` e `textWeights`; perdeu `audioHints` (projetos antigos são lidos sem ela). `project.ext.analysis` continua com `source` (identidade do resultado) e `dismissed` (descartadas). Quem copia `ext` (`project:adopt`, **base**) pode, se preferir, manter só `settings` e descartar o resto; a aba já ignora resultado de outro vídeo, então não é urgente.
4. **5.x (configuração da IA)**: `analysis:aiState` devolve `selected: null` e `provider.id: null` enquanto o usuário não escolhe o provedor; `presets[].suggestedModel` e `provider.suggestedModel` substituem `model` nos provedores conhecidos (só sugestão: o modelo vem do usuário); `analysis:aiSave` recusa `model`/`apiKey`/`baseUrl`/`clearKey` sem provedor escolhido (`INVALID_ARGS`) e `analysis:aiAccept` responde `NOT_CONFIGURED`; o aceite é guardado como `{ origin, baseUrl?, at }` por provedor, **não expira**, e mudar o endereço do Personalizado o apaga (e a chave, se a origem mudou). `provider.reasonCode` (novo) diz qual código vale enquanto o provedor não está pronto: `NOT_CONFIGURED` (sem provedor, endereço ou modelo) ou `NO_KEY` (sem chave ou chave ilegível); `chat`/`test`/`analysis:start` usam esse código (sem provedor: `NOT_CONFIGURED`, não `NO_KEY`). **OpenRouter "só gratuitos"** (fase 2, 23/10/2026; detalhes em [openrouter-gratuito.md](openrouter-gratuito.md)): `presets[].freeCapable` e, no provedor `openrouter` local, `provider.freeCapable`, `provider.freeOnly` (padrão `true`: só o valor `false` guardado desliga) e `provider.fallbackModels` (até 3); `presets[].suggestedModel` do OpenRouter é `openrouter/free` (só o texto do campo; nada é selecionado); `analysis:aiSave` aceita `freeOnly` (boolean) e `fallbackModels` só nesse provedor (`INVALID_ARGS` nos outros; `NOT_FREE` se a reserva tem modelo pago com o modo ligado); com o modo ligado, um modelo que não é gratuito deixa o provedor não pronto com `reasonCode: 'NOT_FREE'`. Novos códigos de erro `NOT_FREE`, `DATA_POLICY`, `CREDITS`, `MODERATION`; `result.ai.models` (`{ modelo: chamadas }`, o campo `model` de cada resposta); avisos `AI_MODEL_SWITCHED`, `AI_COST_REPORTED`, `FREE_LIST_OLD`, `FREE_LIST_MISSING`.
5. **5.15 (pendente)**: `analysis.sensitivity` como preferência (prefs + analysis). O alinhamento das faixas de duração já foi feito pelo prefs, que lê `RANGES` de `params.js`: quem mudar essas faixas muda as Preferências junto.
6. **5.12 (eventos)**: descartar sugestão **não** emite `decision` nem `cuts:changed` (só `project:changed` com `reason: 'analysis:dismiss'` ou `'analysis:restore'`). Se o produto quiser aprender com descartes, definir um tipo de `decision` novo (dono: prefs + analysis).
7. **5.9 / 5.13 (Algoritmo + IA, 16/11/2026)**: `analysis:start` aceita `engine:'both'` (o pedido do algoritmo mais `meta`, `existingCuts` e `profile` da IA); `analysis:status` traz `engine:'both'`; o resultado traz `engine:'both'`, `merge:{ both, ai, algorithm, aiFailed?, algorithmFailed? }` e `suggestions[].engines`; novos avisos `AI_FAILED` e `ALGORITHM_FAILED`; `ext.analysis.engine` pode ser `'both'` e ganha `merge`. A escolha automática de motor passa a ser `'both'` com a IA pronta e aceita.
8. **`tests/e2e/system.e2e.js` (dono do arquivo; esta frente não o editou)**: a linha 443 exige que o motivo de uma sugestão de áudio comece com `pico de áudio` (`/^pico de áudio/`), texto que a v3 escrevia. A v4 escreve **`volume acima do normal de fala (+N dB)`** e/ou **`subida brusca de volume (+N dB)`**, então o passo "análise" falha com `motivos: volume acima do normal de fala (+20 dB),subida brusca de volume (+19 dB)`. Troque o regex por `/^(volume acima do normal de fala|subida brusca de volume)/`. Conferido em 23/10/2026 numa cópia fora do repositório com só a troca para `/^volume acima do normal de fala/`: o e2e inteiro passa (`OK: system`, 189 s) e a análise acha as 3 sugestões nos instantes conhecidos (14-29, 88,5-103,5 e 44,5-59,5 s), com a v4.

## Testes

```bash
node --test tests/analysis-core.test.js tests/analysis-conversa.test.js tests/analysis-episodes.test.js tests/analysis-lead.test.js tests/analysis-filter.test.js tests/analysis-agreement.test.js tests/analysis-merge.test.js tests/analysis-text.test.js tests/analysis-humor.test.js tests/analysis-calibration.test.js tests/analysis-media.test.js tests/analysis-ipc.test.js tests/analysis-renderer.test.js tests/analysis-ui.test.js tests/integration-analysis-chat.test.js tests/analysis-perf.test.js tests/eval-analysis.test.js
npm run test:perf                       # inclui o vídeo de 20 minutos (BF_PERF_TESTS=1)
node tests/e2e/analysis.e2e.js          # app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
npx eslint src/core/analysis src/ipc/handlers/analysis.js renderer/features/analysis.js scripts/eval-analysis.js tests/analysis-*.js tests/e2e/analysis.e2e.js
```

- `analysis-calm`: o sinal de momento calmo (séries sintéticas: nível, estouro, silêncio, tela parada, fala, sensibilidade, combinação e peso 0) e com mídia de verdade (o trecho calmo vira sugestão, a imagem parada e o vídeo todo no mesmo nível não)
- `analysis-conversa`: o perfil de conversa (laço, hesitação e assunto repetido que não contam, frase habitual, estrutura, imagem que ignora as trocas de câmera, limites de frase, durações de 30 a 75 s numa análise só de texto) e o gameplay que continua igual.
- `analysis-merge`: o modo Algoritmo + IA. A junção (mesmo momento pela regra do placar, bordas da união e o limite da duração máxima, relevância combinada, motivos dos dois, título da IA, ordem com os dois primeiro e depois alternando, um par por sugestão, episódio da sugestão só da IA, ids únicos, motor que falhou) e o combo com gerenciadores falsos (algoritmo e depois a IA com o pedido certo, andamento em duas metades, eventos internos do combo, falha antes de começar quando a IA não pode rodar, IA ou algoritmo que falha no meio, os dois falhando, cancelamento). Pelo IPC de verdade (`analysis-ai-ipc`): sem o aceite falha antes de rodar o algoritmo, só os eventos do combo chegam à tela, `BUSY`, e o algoritmo que falha deixa a IA sozinha. Na tela (`analysis-ui`): escolha automática com a IA pronta, os ajustes dos dois à mostra, o pedido com os dados dos dois, resumo, chips e o que fica no projeto; sem transcrição não começa.
- `analysis-agreement`: as famílias de pista e a confirmação (duas famílias ou duas reações de voz diferentes); a risada escrita em chat pequeno (pontua os segundos antes dela, duas somam, os padrões de riso, chat grande fica de fora); o fim do corte cobrindo a reação no `combine` (cobre a risada, limite de 30 s, duração máxima, reação longe não conta); e uma análise só de texto com a quantidade fixa (o corte termina depois da risada; a exclamação solta fica) e automática (sensibilidade + 1, a pista sozinha sai com o motivo, sem o filtro nada muda, na sensibilidade 5 não há degrau).
- `analysis-filter`: filtro de ideias fracas (no combine: a descartada sai com o motivo e a vaga vai para o próximo pico; no analyzeSource só de texto: a fala rápida e repetida sem reação de voz sai, com o filtro desligado volta, e transcrição sem marcas de reação desliga o filtro e avisa) e os limites da quantidade automática.
- `analysis-lead`: início no lance (sem a opção, margem de sempre; com ela, 8 s de base, segue o som do jogo por um silêncio de 14 s, não segue além do buraco aceito; duração máxima, espaço de outra sugestão e começo de fala).
- `analysis-episodes`: telas de espera e episódios com as seis combinações de sinais, silêncio sem fala com a imagem mexendo (não é espera), transcrição que vaza para a espera, espera com música (com e sem transcrição), podcast com capa parada, pausa curta, animação curta, modo rápido da imagem, vídeo parado demais; a cota por episódio no `combine` (um por episódio, episódio sem pico, a espera nunca entra, corte que começa quando a espera acaba); uma análise inteira com os sinais no cache (ligada e desligada); e o acaso justo da avaliação.
- `analysis-core`: estatística robusta, parâmetros (limites, tipos errados, palavras-chave, pesos do texto, distribuição), limiares por sensibilidade, `combine` (margens, durações, picos próximos, relevância mínima, teto, pesos, sinais que concordam, tolerância de tempo, sombra da dilatação, limites do vídeo, **duração fracionária**, propriedades com dados aleatórios), chat (rajada, atraso, palavras-chave, `loadChat` com o leitor oficial) e cache. As expectativas de relevância usam pesos 1 (testam a mecânica, não os pesos padrão).
- `analysis-calibration` (**v4**): `softRamp` (nunca 1,0, crescente), áudio sobre séries de dB sintéticas — **de silêncio para fala não satura** (30 min de fala com porta de ruído, sem nenhum valor acima de 0,15), grito sustentado acima do normal de fala, fundo constante, fundo quase mudo com estouros raros, nível absoluto mínimo e teto do desvio —, **empate pela pontuação (não pela ordem do tempo)**, **distribuição** (abertura cheia não consome a cota; no máximo N por janela de 10 min), folga mínima, **alinhamento a limites de falas** e propriedades com dados aleatórios. Os testes de comportamento (silêncio→fala e empate) foram conferidos contra uma cópia da v3 e a reprovam.
- `analysis-humor` (algoritmo) e `analysis-media` ("perfil de humor do canal", com ffmpeg real): o perfil limpo e limitado, a preferência `analysis.humor`, a busca das expressões (acento, caixa, palavra inteira, a mais longa vence, freio do bordão comum, reações que somam às exclamações), o motivo, o peso 0 da pista e uma análise inteira em que um bordão numa fala calma vira a única sugestão (e sem o perfil não há nenhuma).
- `analysis-text`: o sinal de texto sobre falas sintéticas com horários conhecidos (laço de alucinação do Whisper ignorado, exclamações e reações, risadas em laço, repetição de bordão com expressão habitual ignorada, palavras de reação, ritmo, a risada que vem depois do lance, pesos por pista, sensibilidade).
- `analysis-media`: **ffmpeg real**, mídia sintética com instantes conhecidos: rajadas de áudio, ruído que não gera sugestão, faixa atrasada, flash/saltos de luminância/chuvisco, modo rápido, vídeo sem áudio, três sinais no mesmo lance, chat sozinho, sinais ausentes, arquivo que não é mídia, cache (repetir, mudar parâmetros, arquivo diferente), cancelamento (processos encerrados, prioridade abaixo do normal), memória em fluxo, e os casos de robustez: **duração de 40,4 s com rajada no fim**, **ffmpeg que sai com erro**, **`fresh`**, **MKV truncado**, **primeira faixa muda** e `NO_SIGNALS` com tudo desligado. Da v4: **fala com porta de ruído** (silêncio→fala não é destaque; um grito é), **sugestões distribuídas no tempo** (30 min, abertura cheia de gritos iguais), **sinal de texto com transcrição sintética** (alinhado às falas, motivos legíveis, peso 0 e sinal desligado), **sem transcrição continua funcionando** (texto ignorado com o motivo, transcrição de outro arquivo, só texto) e **cache que depende da transcrição** (+ aviso `TEXT_SHORT`).
- `analysis-ipc`: handlers com `ctx` de verdade e Electron falso: segundo plano, uma por vez, progresso, cache, `fresh`, cancelamento, `before-quit` e **a transcrição do projeto achada pelo processo principal** (conferida com o arquivo; de outro arquivo, sem projeto ou com identificador inválido o texto é ignorado).
- `analysis-renderer` e `analysis-ui`: a aba de verdade num DOM de mentira: funções puras e criação de cortes; retomar análise em andamento (estimativa), campos corrigidos na tela, Analisar sem sinal utilizável, descartar/restaurar, resultado de outro vídeo (adoção) e `fresh`; o sinal **Texto** (desligado sem transcrição, no pedido com `projectId`), os pesos novos nos ajustes avançados, a opção de dicas de volume **ausente**, **nenhum provedor pré-selecionado** (lista, modelo, chave e aceite travados; nada é pedido ao processo principal), o alerta de chave sem cifra e o aviso de privacidade sem prazo (inclusive a troca de endereço do Personalizado).
- `integration-analysis-chat`: a análise lê o chat gravado pelo `writeChat` do recurso Fontes.
- `analysis-perf`: 3 min (sempre), 20 min (`BF_PERF_TESTS=1`) e 3 h de PCM em fluxo.
- `eval-analysis`: a avaliação (revocação, precisão, 1:1, distância, melhores, N mais relevantes), a faixa `--from`/`--to` e a referência do acaso (o acaso justo, fora das telas de espera, está em `analysis-episodes`).
- `e2e/analysis`: app real e vídeo sintético (rajadas, flash, chat): tela (inclusive o sinal Texto desligado, os pesos novos e a ausência das dicas de volume), ajustes persistidos, números corrigidos, sem sinal, análise, ver trecho, **descartar/restaurar**, adicionar uma/todas, reanálise sem duplicar (inclusive com corte rejeitado), cancelamento, confirmação ao abrir outro vídeo durante a análise, persistência após reiniciar, **projeto adotado** e zero erros de console. O algoritmo com a transcrição importada (sinal de texto) roda no `e2e/analysis-ia`, depois de "Usar o algoritmo".
