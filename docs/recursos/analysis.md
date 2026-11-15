# Análise: sugestões de momentos para cortar

Dono: `analysis`. Contratos: [arquitetura.md](../arquitetura.md) (1.4 aba de ordem 60, 3.6 chat, 5.3 `ext.analysis`, 5.9 análise). A aba **Análise** precisa de um projeto aberto e do FFmpeg/FFprobe do sistema (nunca baixa nada).

## Dois motores

A aba **Análise** tem o seletor **Motor da análise: Algoritmo | IA na nuvem**. Este documento descreve o **algoritmo** (regras simples, roda neste computador, sem enviar nada para fora, e continua sendo a reserva quando a IA não está configurada ou falha). A **IA na nuvem** (provedor compatível com a OpenAI, escolhido pelo usuário — nenhum vem pré-selecionado; no OpenRouter o modelo parte do roteador gratuito —, lendo a transcrição do vídeo, com conferência local rigorosa) está em [analise-ia.md](analise-ia.md), inclusive a transcrição do vídeo, o aviso de privacidade e a configuração do provedor. O padrão é a IA quando há provedor configurado **e** aviso aceito; senão o algoritmo. O motor escolhido fica em `project.ext.analysis.settings.engine`. As sugestões dos dois motores aparecem na mesma lista (cartões, motivos em chips, "Adicionar", "Adicionar todas") e viram cortes `origin:'auto'`, sempre pendentes.

> **Recalibrado na v4 (`ALGO_VERSION` 4, 23/10/2026).** A versão 3 saturava na abertura da live e não sugeria nada do resto (0 de 15 no gabarito). A v4 mede o volume contra o nível de fala do trecho, usa a transcrição quando existe, desempata pela pontuação e distribui as sugestões por toda a duração. Os números honestos (antes × depois, metade de ajuste × metade de teste, e a ressalva de que o gabarito é circular e de uma live só) estão em [analise-ia.md](analise-ia.md), seção 13; o resumo está em "Resultado na live real" abaixo.

## O que faz

Procura trechos **prováveis** de bons cortes por **regras simples e explicáveis** (não é inteligência artificial, e sugestão não é garantia: a tela diz isso). Cinco sinais, quatro que procuram o que se destaca para cima e um que procura o que se destaca por ser calmo (**momento calmo**, abaixo): **áudio** (volume sustentado acima do normal de fala e subida brusca depois de fala), **imagem** (mudança de cena e movimento), **chat** (velocidade das mensagens e palavras-chave) e **texto** (a transcrição do vídeo: risadas, exclamações e reações, ritmo de fala, repetição de bordão, falas sobre o próprio momento e as **expressões do canal** do perfil de humor; só quando há transcrição). Cada sugestão traz início, fim, relevância (0 a 100%) e os motivos em texto curto ("volume acima do normal de fala (+14 dB)", "mudança de cena", "chat 4× a média", "palavras-chave no chat: clip ×7", "risadas", "ritmo de fala acelerou (3,2 palavras/s)", "exclamações e reações", "repetição (bordão)").

- **Momentos calmos** (v5, pedido do dono depois de um short real, "só um jogador aproveitando o momento", sem fala nem jogada). Um trecho tranquilo, sem fala e sem pico, mas **vivo** (o som e a imagem continuam): construir, explorar uma paisagem, uma cena de história com música baixa. É calmo **perto do resto do vídeo** (o normal de uma live é a fala por cima do jogo), então vale para lives longas e **não** marca um vídeo que é calmo do começo ao fim. A sugestão traz o motivo "momento calmo: som baixo e contínuo, sem picos (27 dB abaixo do normal)", com ", sem fala" quando a transcrição confirma. Pesa menos (0,7: sozinha nunca passa de ~68%) e tem **cota própria, além da Quantidade** (um quarto dela, no mínimo 1), para não ser engolida pelos picos. Só no algoritmo (a IA lê o texto: veja analise-ia.md).
- **Tipo de vídeo** (perfil da análise, 14–15/11/2026): **Gameplay ou live de jogo** (padrão, o comportamento de sempre) ou **Conversa ou podcast**. No de conversa a repetição só conta como **laço**, entra a pista de **estrutura**, a imagem ignora as **trocas de câmera** e os cortes têm **30 a 75 s** e terminam em **frase completa**. Detalhes e medição em "Perfil de conversa", abaixo.
- **Separar por episódios** (15/11/2026, ligado por padrão): uma live com vários programas separados por arte de espera ("Iniciamos em instantes", "Voltamos em instantes", "Encerramos por hoje") tem as **telas de espera** achadas pela imagem parada, pelo silêncio e pela falta de fala; nenhuma sugestão entra nelas, e **cada episódio ganha pelo menos uma sugestão** quando tem um momento acima da relevância mínima. Cada sugestão mostra "Episódio N". Detalhes e medição em "Episódios e telas de espera", abaixo.
- **Nada é aprovado automaticamente.** "Adicionar" cria um corte `origin:'auto'`, `status:'pending'`, com `relevance` e `reasons`, e emite `cuts:changed { from:'analysis' }` mais um `decision` `create` por corte (a revisão e o histórico enxergam). Quem decide é o usuário, na aba Cortes.
- **Descartar** esconde a sugestão **sem criar corte**: ela some da lista e do selo da aba, não volta nas próximas análises do mesmo vídeo e fica em "Descartadas" (seção recolhida) para restaurar. Descartar não emite `decision` (não conta como aprendizado).
- **Um sinal que falta não bloqueia.** Sem áudio, sem chat baixado, sem transcrição, chat ilegível ou ffmpeg que falha num sinal: o sinal é ignorado, a tela diz o motivo e a análise segue com os outros. Só falha (`NO_SIGNALS`) se nenhum puder ser usado.
- **Segundo plano e cancelável.** `analysis:start` volta na hora; o ffmpeg roda com prioridade abaixo do normal (não trava a interface nem uma live), em fluxo (memória constante) e pode ser cancelado (os processos são encerrados e nada é gravado).
- **O processo principal nunca grava o projeto**: devolve o resultado e o renderer o aplica.

### A tela (poucos botões; ajustes avançados recolhidos)

0. **Motor da análise** (Algoritmo | IA na nuvem) e, logo abaixo, o cartão **Transcrição do vídeo** (nos dois motores: na IA é obrigatória; no algoritmo é *opcional* e liga o sinal de texto). O cartão tem **Transcrever o vídeo** (Whisper) e **Importar legenda…** (`.srt`/`.vtt`); os detalhes estão em analise-ia.md. Os itens 1, 2 e 4 abaixo valem para o algoritmo; no modo IA a tela mostra também o provedor e esconde sinais, sensibilidade e ajustes avançados do algoritmo (a **Quantidade** vale nos dois).
1. **O que procurar**: o seletor **Tipo de vídeo** (Gameplay ou live de jogo | Conversa ou podcast, com uma frase do que muda; fica no projeto, em `settings.profile`), depois Áudio, Imagem, Chat, **Texto** e **Momentos calmos** (este precisa do sinal de Áudio ligado), com a dica do que cada um procura, e o interruptor **Separar por episódios** (ligado; fica no projeto, em `settings.episodes`). Sinal que o vídeo não tem (sem áudio; sem chat baixado na aba Novo projeto; **sem transcrição deste vídeo**, ou transcrição de outro arquivo) fica desabilitado e a linha diz que será ignorado.
2. **Sensibilidade** (1 a 5, padrão 3) e **Quantidade** (sugestões por hora, padrão 6; mostra "até N neste vídeo").
3. **Analisar** (e **Cancelar** durante a análise), com barra de progresso e estimativa de tempo restante. O botão fica desabilitado sem projeto, sem FFmpeg ou **sem nenhum sinal utilizável** (a tela explica: "Nenhum sinal utilizável…"). É o único botão primário da área de ajustes (o outro, "Adicionar todas", fica na área de resultados).
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
| `analysis:start` | `{ path, params?, chatPath?, fresh?, projectId?, size?, duration? }` → `{ jobId }` (uma por vez: `BUSY`; `INVALID_ARGS`, `NO_FFMPEG`, `NO_FFPROBE`, `INPUT_MISSING`). `fresh:true` ignora o cache. Com `projectId` (e `size`/`duration` do vídeo), o processo principal procura a transcrição do projeto em `userData/transcripts`, **confere que é deste arquivo** (mesmo caminho, tamanho e duração) e a usa como sinal de texto; sem ela, ou se for de outro arquivo, o texto é só ignorado (com o motivo no resultado) |
| `analysis:cancel` | `{ jobId? }` → `{ cancelled }` |
| `analysis:status` | → `{ running: { jobId, path, startedAt, p, stage, message } ou null }` (a aba usa para retomar uma análise depois de recarregar a janela) |

Eventos: `analysis:progress { jobId, p, stage, message }` (no máximo ~5 por segundo), `analysis:done { jobId, result }`, `analysis:failed { jobId, code, message, details? }` (inclui `CANCELLED`). Códigos de falha: `CANCELLED`, `INVALID_ARGS`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_FFPROBE`, `BUSY`, `PROBE_FAILED`, `NO_SIGNALS`, `FFMPEG_START_FAILED`. ffmpeg/ffprobe são só os do sistema: não há registro em `ctx.toolUsage`.

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
- *Ritmo de fala*: palavras por segundo (as palavras de cada fala espalhadas na duração dela, no mínimo palavras/6 s) em ±8 s, contra o normal de fala do trecho (mediana/MAD só das janelas com fala, por bloco de 10 min; z com teto 6). Motivo "ritmo de fala acelerou (N palavras/s)".
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

O segundo é de espera quando as evidências disponíveis concordam: com as três, bastam duas (a transcrição costuma "vazar" para dentro da espera, e uma espera com música perde o silêncio); com duas, as duas; com uma só (só imagem ou só som), ela basta. **Só a transcrição não decide** (falta de fala também é jogo sem narração). Imagem parada **com som e sem transcrição não é espera**: pode ser um podcast só de áudio com a capa parada. Viram **intervalo** os trechos de espera de **30 s ou mais**, aceitando buracos de até 5 s (uma animação curta na arte). Os **episódios** são os trechos entre intervalos com **90 s ou mais** (um pedaço menor, como os 57 s do episódio 2 antes de uma pausa técnica, não ganha cota, mas pode receber sugestão). Se a espera passa de **60% do vídeo**, nada é marcado: o vídeo é parado por natureza (slides, tela estática).

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

## Cache e cancelamento

- **Onde**: `userData/cache/analysis/` (arquivos nossos; apagar ali nunca toca em arquivo do usuário). Dois níveis: `sig-audio-*` / `sig-image-*` (o que o ffmpeg extraiu, a parte cara) e `res-*` (resultado final). Mudar sensibilidade, pesos ou margens reaproveita os `sig-*` e só refaz a combinação (instantâneo). A chave do resultado inclui a **impressão digital da transcrição**: outra transcrição recalcula (sem reler o vídeo). No máximo 80 arquivos (os usados há mais tempo saem); gravação atômica (tmp + rename); arquivo ilegível ou de outra versão do algoritmo conta como ausente.
- **Chave da fonte**: SHA-1 do tamanho + 3 trechos de 256 KiB (início, meio e fim). Não depende de nome nem de data (copiar ou renomear o vídeo mantém o cache); uma gravação que ainda cresce muda a chave.
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
  episodes: [{ start, end }], breaks: [{ start, end }],   // episódios e telas de espera achados (vazios sem espera ou com a opção desligada)
  suggestions: [{ id, start, end, peak, relevance, reasons, episode? }],
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
- **Episódios: medido numa live só**, com espera em silêncio digital e arte totalmente parada. **Não é achada** a espera com arte **animada** (vinheta em laço, contagem regressiva) **e** música, a menos que a transcrição mostre a falta de fala por 30 s; nem a espera com alguém falando por cima da arte. Um jogo pausado em menu parado e mudo por 30 s ou mais vira intervalo (o que, num corte, não faz falta). A cota não aumenta a Quantidade.
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
7. **`tests/e2e/system.e2e.js` (dono do arquivo; esta frente não o editou)**: a linha 443 exige que o motivo de uma sugestão de áudio comece com `pico de áudio` (`/^pico de áudio/`), texto que a v3 escrevia. A v4 escreve **`volume acima do normal de fala (+N dB)`** e/ou **`subida brusca de volume (+N dB)`**, então o passo "análise" falha com `motivos: volume acima do normal de fala (+20 dB),subida brusca de volume (+19 dB)`. Troque o regex por `/^(volume acima do normal de fala|subida brusca de volume)/`. Conferido em 23/10/2026 numa cópia fora do repositório com só a troca para `/^volume acima do normal de fala/`: o e2e inteiro passa (`OK: system`, 189 s) e a análise acha as 3 sugestões nos instantes conhecidos (14-29, 88,5-103,5 e 44,5-59,5 s), com a v4.

## Testes

```bash
node --test tests/analysis-core.test.js tests/analysis-conversa.test.js tests/analysis-episodes.test.js tests/analysis-text.test.js tests/analysis-humor.test.js tests/analysis-calibration.test.js tests/analysis-media.test.js tests/analysis-ipc.test.js tests/analysis-renderer.test.js tests/analysis-ui.test.js tests/integration-analysis-chat.test.js tests/analysis-perf.test.js tests/eval-analysis.test.js
npm run test:perf                       # inclui o vídeo de 20 minutos (BF_PERF_TESTS=1)
node tests/e2e/analysis.e2e.js          # app Electron de verdade (BF_E2E_SHOTDIR=<pasta> guarda capturas)
npx eslint src/core/analysis src/ipc/handlers/analysis.js renderer/features/analysis.js scripts/eval-analysis.js tests/analysis-*.js tests/e2e/analysis.e2e.js
```

- `analysis-calm`: o sinal de momento calmo (séries sintéticas: nível, estouro, silêncio, tela parada, fala, sensibilidade, combinação e peso 0) e com mídia de verdade (o trecho calmo vira sugestão, a imagem parada e o vídeo todo no mesmo nível não)
- `analysis-conversa`: o perfil de conversa (laço, hesitação e assunto repetido que não contam, frase habitual, estrutura, imagem que ignora as trocas de câmera, limites de frase, durações de 30 a 75 s numa análise só de texto) e o gameplay que continua igual.
- `analysis-episodes`: telas de espera e episódios com as seis combinações de sinais, transcrição que vaza para a espera, espera com música (com e sem transcrição), podcast com capa parada, pausa curta, animação curta, modo rápido da imagem, vídeo parado demais; a cota por episódio no `combine` (um por episódio, episódio sem pico, a espera nunca entra, corte que começa quando a espera acaba); uma análise inteira com os sinais no cache (ligada e desligada); e o acaso justo da avaliação.
- `analysis-core`: estatística robusta, parâmetros (limites, tipos errados, palavras-chave, pesos do texto, distribuição), limiares por sensibilidade, `combine` (margens, durações, picos próximos, relevância mínima, teto, pesos, sinais que concordam, tolerância de tempo, sombra da dilatação, limites do vídeo, **duração fracionária**, propriedades com dados aleatórios), chat (rajada, atraso, palavras-chave, `loadChat` com o leitor oficial) e cache. As expectativas de relevância usam pesos 1 (testam a mecânica, não os pesos padrão).
- `analysis-calibration` (**v4**): `softRamp` (nunca 1,0, crescente), áudio sobre séries de dB sintéticas — **de silêncio para fala não satura** (30 min de fala com porta de ruído, sem nenhum valor acima de 0,15), grito sustentado acima do normal de fala, fundo constante, fundo quase mudo com estouros raros, nível absoluto mínimo e teto do desvio —, **empate pela pontuação (não pela ordem do tempo)**, **distribuição** (abertura cheia não consome a cota; no máximo N por janela de 10 min), folga mínima, **alinhamento a limites de falas** e propriedades com dados aleatórios. Os testes de comportamento (silêncio→fala e empate) foram conferidos contra uma cópia da v3 e a reprovam.
- `analysis-humor` (algoritmo) e `analysis-media` ("perfil de humor do canal", com ffmpeg real): o perfil limpo e limitado, a preferência `analysis.humor`, a busca das expressões (acento, caixa, palavra inteira, a mais longa vence, freio do bordão comum, reações que somam às exclamações), o motivo, o peso 0 da pista e uma análise inteira em que um bordão numa fala calma vira a única sugestão (e sem o perfil não há nenhuma).
- `analysis-text`: o sinal de texto sobre falas sintéticas com horários conhecidos (exclamações e reações, risadas em laço, repetição de bordão com expressão habitual ignorada, palavras de reação, ritmo, a risada que vem depois do lance, pesos por pista, sensibilidade).
- `analysis-media`: **ffmpeg real**, mídia sintética com instantes conhecidos: rajadas de áudio, ruído que não gera sugestão, faixa atrasada, flash/saltos de luminância/chuvisco, modo rápido, vídeo sem áudio, três sinais no mesmo lance, chat sozinho, sinais ausentes, arquivo que não é mídia, cache (repetir, mudar parâmetros, arquivo diferente), cancelamento (processos encerrados, prioridade abaixo do normal), memória em fluxo, e os casos de robustez: **duração de 40,4 s com rajada no fim**, **ffmpeg que sai com erro**, **`fresh`**, **MKV truncado**, **primeira faixa muda** e `NO_SIGNALS` com tudo desligado. Da v4: **fala com porta de ruído** (silêncio→fala não é destaque; um grito é), **sugestões distribuídas no tempo** (30 min, abertura cheia de gritos iguais), **sinal de texto com transcrição sintética** (alinhado às falas, motivos legíveis, peso 0 e sinal desligado), **sem transcrição continua funcionando** (texto ignorado com o motivo, transcrição de outro arquivo, só texto) e **cache que depende da transcrição** (+ aviso `TEXT_SHORT`).
- `analysis-ipc`: handlers com `ctx` de verdade e Electron falso: segundo plano, uma por vez, progresso, cache, `fresh`, cancelamento, `before-quit` e **a transcrição do projeto achada pelo processo principal** (conferida com o arquivo; de outro arquivo, sem projeto ou com identificador inválido o texto é ignorado).
- `analysis-renderer` e `analysis-ui`: a aba de verdade num DOM de mentira: funções puras e criação de cortes; retomar análise em andamento (estimativa), campos corrigidos na tela, Analisar sem sinal utilizável, descartar/restaurar, resultado de outro vídeo (adoção) e `fresh`; o sinal **Texto** (desligado sem transcrição, no pedido com `projectId`), os pesos novos nos ajustes avançados, a opção de dicas de volume **ausente**, **nenhum provedor pré-selecionado** (lista, modelo, chave e aceite travados; nada é pedido ao processo principal), o alerta de chave sem cifra e o aviso de privacidade sem prazo (inclusive a troca de endereço do Personalizado).
- `integration-analysis-chat`: a análise lê o chat gravado pelo `writeChat` do recurso Fontes.
- `analysis-perf`: 3 min (sempre), 20 min (`BF_PERF_TESTS=1`) e 3 h de PCM em fluxo.
- `eval-analysis`: a avaliação (revocação, precisão, 1:1, distância, melhores, N mais relevantes), a faixa `--from`/`--to` e a referência do acaso (o acaso justo, fora das telas de espera, está em `analysis-episodes`).
- `e2e/analysis`: app real e vídeo sintético (rajadas, flash, chat): tela (inclusive o sinal Texto desligado, os pesos novos e a ausência das dicas de volume), ajustes persistidos, números corrigidos, sem sinal, análise, ver trecho, **descartar/restaurar**, adicionar uma/todas, reanálise sem duplicar (inclusive com corte rejeitado), cancelamento, confirmação ao abrir outro vídeo durante a análise, persistência após reiniciar, **projeto adotado** e zero erros de console. O algoritmo com a transcrição importada (sinal de texto) roda no `e2e/analysis-ia`, depois de "Usar o algoritmo".
