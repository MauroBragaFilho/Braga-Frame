# Requisitos, decisões e etapas

## 1. Confirmados (briefing)

- Entrada: arquivos locais, gravações do OBS, VODs (YouTube/Twitch) e chat quando disponível.
- Exportação: **9:16 obrigatório**; 1080p, 1440p (2K) e 2160p (4K); H.264 ou H.265; bitrate por barra (padrão 10 Mbps); exportação local, **publicação manual**.
- Central de revisão: ordem cronológica (relevância opcional), ajuste temporal simples + timeline detalhada opcional, aprovar/rejeitar/categorizar/editar, sugestão de títulos sem substituir os personalizados, cortes semelhantes/alterados/revisados, lote com prévia, confirmação e desfazer.
- Projetos e aprendizado: reconhecer lives já analisadas (confirmar antes de abrir), comparar atualização de fonte, preservar ajustes manuais, preferências geral/jogo/canal editáveis e reversíveis, histórico de decisões.
- Legendas: geração opcional, revisão, sincronização, estilo, incorporada ou arquivo separado; nunca inventar fala; sinalizar após mudança temporal.
- Áudio: só ajuste manual por corte; sem normalização/redução de ruído automáticas; preservar original, comparar, desfazer.
- Qualidade: avisos não impeditivos; bloquear só o trabalho afetado; explicar causa e solução; nunca corrigir sem autorização.
- Fila: sequencial/paralela configurável, pausa/retomada/cancelamento, reordenação, recuperação após interrupção, tentativas limitadas, perguntar em conflito de nome, não repetir concluídos.

## 2. Decisões técnicas tomadas

- **Stack:** Electron + Node (igual ao BDS) para reaproveitar o conhecimento e módulos (ffprobe, fila de jobs, Whisper). Sem dependências de runtime além do próprio Electron.
- **FFmpeg:** usa o instalado no sistema (PATH ou `CORTE_FFMPEG`/`CORTE_FFPROBE`). O projeto FFmpeg não publica binários oficiais, então o app **nunca baixa** FFmpeg (nem de builds de terceiros): a aba Ferramentas mostra a versão detectada e como instalar.
- **Outras ferramentas:** yt-dlp, whisper.cpp, TwitchDownloaderCLI e Deno são instaladas pelo próprio app (aba Ferramentas), **só de releases oficiais**, com URL fixa, tamanho e SHA-256 conferidos, sem compilar nada e sem builds de terceiros. Sem dependências npm novas em runtime.
- **Persistência:** um JSON por vídeo em `userData/projects`, gravação atômica; arquivo corrompido é preservado como `.corrupt`. Estado que sobrevive sem projeto (fila, preferências, histórico, fontes) fica em arquivos próprios de `userData`, também atômicos.
- **Exportação:** grava em `.part` e só renomeia ao concluir; nunca sobrescreve (substituir só por escolha explícita, arquivo a arquivo). Toda exportação passa pela **fila**; a aba Exportar só monta os trabalhos e confere a qualidade.
- **Avisos e bloqueios:** aviso não impeditivo nunca bloqueia; só falha realmente impeditiva bloqueia, e bloqueia só o trabalho afetado, sempre com causa e solução. O app não corrige conteúdo sem autorização.
- **Idioma e interface:** português do Brasil; telas limpas (poucos botões visíveis, ajustes avançados recolhidos); nada fictício (sem botão sem ação nem integração simulada apresentada como real).

## 3. Decisões provisórias a confirmar

Tudo abaixo foi **escolhido pelo desenvolvimento** para não travar a entrega e está **marcado como provisório**: cada item tem um ponto único de mudança (indicado) e testes que o protegem. Os itens com **(Liz)** dependem de decisão de produto; os demais são técnicos e valem até alguém pedir outra coisa. Fonte de cada grupo: `docs/recursos/<recurso>.md`.

### 3.1 Produto e marca

| Tema | Provisório | Observação |
|---|---|---|
| Nome do produto | "Braga Frame" (nome de trabalho; antes "Corte Shorts") | Centralizado em `src/appInfo.js`. Falta verificar marca no INPI, domínio (bragaframe.com.br / .com) e @bragaframe nas redes |
| Pasta de saída | `Cortes` ao lado do vídeo | O usuário pode escolher outra (fica no projeto) |
| Nome do arquivo | `{fonte} - corte {n} - {titulo}` (número com pelo menos 2 dígitos, pela ordem cronológica de todos os cortes do projeto) | Modelo editável na aba Exportar; **(Liz)** padrão de nome |
| Reprodução no player | Depende do Chromium | HEVC/alguns MKV podem não tocar no player; a exportação com ffmpeg funciona. Proxy de baixa resolução pode resolver |

### 3.2 Exportação e fila (`exportEngine`, `queue`)

| Tema | Provisório | Observação |
|---|---|---|
| Bitrate dos horizontais | 10 / 16 / 35 Mbps (1080 / 1440 / 2160) | O briefing só fixa 10 Mbps para o 9:16 |
| Faixas de aviso de bitrate | Bits por pixel por quadro abaixo de 0,045 (0,03 em H.265) ou acima de 0,6 (0,4) | Só avisos; nunca bloqueiam |
| Codificador `auto` | Usa a placa NVIDIA (NVENC) quando um teste real funciona | Mais rápido; a qualidade por bitrate é um pouco menor que a do software. Quem prioriza qualidade escolhe "Software" |
| Parâmetros de codificação | Fundo desfocado em 1/4 da resolução, escala `lanczos`, `maxrate` 1,2× e `bufsize` 2× do bitrate | Ajustável em `src/core/export/{framing,encoders}.js` |
| Corte longo | Aviso acima de 180 s (limite atual do Shorts) | **(Liz)** limite de duração por corte |
| Estado `paused` por trabalho | Não existe: a pausa é da fila inteira | Pausar não suspende o ffmpeg; "Interromper os atuais" recomeça do início |
| Destino diferente | Conta como trabalho novo (não é "pulado") | Pular concluído exige a mesma pasta |
| Limpeza | "Limpar concluídos" tira concluídos, pulados e cancelados e **deixa as falhas**; "Descartar" na recuperação cancela só os interrompidos | |
| Tempos da fila | Espera entre tentativas 2 s dobrando (máx. 30 s), 2 tentativas extras, prazo de cancelamento 20 s | |

### 3.3 Revisão (`review`)

| Tema | Provisório | Observação |
|---|---|---|
| Cortes semelhantes **(Liz)** | Sobreposição com IoU ≥ 0,4 **ou** trecho em comum ≥ 70% do menor; **ou** (a ≤ 5 s de distância **e** ≥ 50% das palavras do título em comum). Transitivo | Parâmetros em `similarity.DEFAULTS` |
| Duração mínima de um corte | 0,2 s | `core.MIN_LENGTH` |
| Título personalizado sem marca | Título que não é "Corte N", nem sugestão guardada, nem de corte sugerido nunca editado, é tratado como do usuário (prudência) | Cortes antigos |
| Manter um (semelhantes) | Não aprova o mantido, a menos que a caixa seja marcada | |
| Restaurar | Volta ao estado de **antes** da ação escolhida (e das seguintes) | Vira entrada nova e se desfaz |
| Desfazer | Pilha só da sessão; histórico em disco até 5000 ações | |
| Atalhos | `J`/`K`/`L` **não** foram implementados | O `<video>` do Chromium não tem avanço/retrocesso confiável por tecla |

### 3.4 Áudio e legendas (`audio`, `subtitles`)

| Tema | Provisório | Observação |
|---|---|---|
| Ajuste de áudio | Ganho −30 a +20 dB (passo 0,1), fade até metade da duração do corte; só ajuste manual | "Voltar ao original" zera os quatro valores sem apagar o histórico; a medição não é gravada no projeto |
| Tempos das falas | Relativos ao início do corte | |
| Estilo da legenda | Guardado no corte; "último usado no projeto" é o padrão dos próximos; `subtitles.enabled` das preferências **não** liga sozinho | |
| Modelo e idioma | Modelo **Pequeno** (q5, 181 MB) e português | Com placa NVIDIA e o motor CUDA (opcional) é bem mais rápido; só com o processador o Pequeno leva de alguns segundos a mais de um minuto por corte |
| Limiares anti-invenção | Descarta confiança < 0,28 e marca "revisar" entre 0,28 e 0,55; silêncio −50 dB / 1 s | Calibrados com o modelo tiny (`hallucinations.js`) |
| Prévia da legenda | Fator 0,89 entre o tamanho do ASS e o CSS (medido com Arial; ~2% de diferença) | Outras fontes podem diferir um pouco mais |

### 3.5 Análise (`analysis`) **(Liz)**

Os **sinais e critérios de "bom momento"** estão em aberto no briefing; o que existe é provisório (algoritmo **v4**): áudio (nível sustentado contra o nível de fala, com porta de ruído), imagem (mudança de cena e movimento), chat (velocidade e palavras-chave) e **texto da transcrição** (risadas, exclamações, ritmo de fala, repetição de bordão, falas sobre o próprio momento e as expressões do canal do **perfil de humor**; só quando há transcrição), pesos 0,8 / 0,6 / 1 / 1, sensibilidade 3, 6 sugestões por hora, relevância mínima 0,5, margens 3 s antes e 2 s depois, duração de 15 a 60 s, atraso do chat de 6 s, palavras `clip pog omg wtf`. Eventos do jogo **não** são sinais. Foi calibrado com mídia sintética e **medido numa live real contra 15 cortes escolhidos à mão** (uma live só, gabarito circular: `docs/recursos/analise-ia.md`, seção 13). A análise por **IA na nuvem** (transcrição + provedor compatível com a OpenAI, inclusive os modelos gratuitos do OpenRouter) é a outra opção. O **perfil de humor do canal** (pedido do dono em 23/10/2026: critérios e exemplos de cortes aprovados e rejeitados para a IA; bordões e palavras de reação para o algoritmo; fica nas Preferências, canal > jogo > geral) está implementado e testado, **mas seu efeito na qualidade não foi medido** (`docs/recursos/analise-ia.md`, seção 16). Detalhes e fórmulas em `docs/recursos/analysis.md`.

### 3.6 Novo projeto, a antiga Fontes (`sources`)

| Tema | Provisório | Observação |
|---|---|---|
| A tela | Pergunta "Como deseja adicionar o seu vídeo?", quatro cartões (Arquivos locais, YouTube, Twitch, Gravações do OBS) e só o painel do escolhido; a escolha fica lembrada | Do desenho do dono. Sem botão "Continuar": o projeto abre ao soltar ou escolher o arquivo; ao abrir, o app segue para Cortes |
| Arquivos locais | Arrastar e soltar (a janela inteira aceita) ou escolher o arquivo; MP4, MKV, MOV, WebM, AVI, FLV, TS | Cada vídeo é um projeto: vários arquivos soltos abrem só o primeiro, com aviso |
| Um trabalho por vez | Download de VOD **ou** de chat | O segundo pedido responde `BUSY` |
| Links aceitos | YouTube (vídeo, live encerrada, shorts) e Twitch `videos/<id>` | Clipes, playlists e canais são recusados com explicação |
| `meta.game` | Só de campo `game` da fonte ou, na Twitch, do jogo que mais tempo ocupou; "Gaming" do YouTube não vira jogo | O usuário sempre edita; reabrir nunca sobrescreve |
| "Em gravação" (OBS) | Modificado há menos de 30 s e crescendo | Só aviso; abrir pede confirmação |
| Espaço em disco | Bloqueia só se claramente não cabe; abaixo de ~2,2× vira aviso | |
| Deno | Recomendado, não obrigatório, para o YouTube | A aba avisa e segue tentando |

### 3.7 Preferências e aprendizado (`prefs`) **(Liz)**

| Tema | Provisório | Observação |
|---|---|---|
| Prioridade | **canal > jogo > geral** (o mais específico vence; no mesmo escopo, o valor do usuário vence o aprendido) | Mudança só em `Preferences.resolve` e na tabela de `tests/prefs-store.test.js` |
| Regras de aprendizado | Faixa de duração pela mediana dos aprovados, categorias mais usadas, relevância mínima (≥ 70% de rejeição abaixo do limite), perfil mais usado (≥ 50%) | Evidência mínima 5 (configurável de 3 a 100) |
| Correspondência com lives | Forte (mesmo código de vídeo/endereço), média (canal + título ≥ 0,8 + duração parecida), fraca (≥ 2 sinais entre nome, tamanho e duração) | A pergunta sempre aparece antes de abrir |
| Fonte atualizada | Só pergunta se o projeto tem cortes; tolerância de duração (maior entre 0,5 s e 0,1%) e de tamanho (0,5%) | |
| "Criar novo" | Grava a decisão num projeto vazio para não perguntar de novo | |

### 3.8 Codificação

Software (libx264/libx265) sempre disponível; aceleração por GPU NVIDIA (NVENC) opcional, verificada com um teste real e com queda para software. A aceleração do Whisper pela placa NVIDIA é **opcional**: o motor CUDA oficial (whisper.cpp `b5130`, 675 MB, tamanho e SHA-256 conferidos) é instalado pelo app ou vem do BDS; o modo automático usa a placa quando o modelo cabe na memória dela e cai para o processador se a placa falhar (`docs/recursos/subtitles.md`).

## 4. Pendências de produto (precisam da Liz / do Mauro)

- Sinais e critérios de "bom momento" (picos de áudio, ritmo do chat, mudança de cena, falas, eventos do jogo?) — hoje provisório e sem validação com gameplay real (3.5).
- Prioridade das preferências (geral × jogo × canal) e critério de "cortes semelhantes" (3.7 e 3.3).
- Limite de duração por corte e padrão de nome de arquivo (3.1 e 3.2).
- Marca: INPI, domínio e redes do "Braga Frame" (3.1).
- Testar a análise e o aprendizado com **gravações e lives reais** (hoje só mídia sintética).

## 5. Etapas (estado real)

"Verificado" = executado de verdade (ffmpeg, Electron e arquivos reais) por teste automatizado nesta máquina (Windows, Node 24, ffmpeg "full" 2026-02-09, GTX 1650); o que depende de internet, de conta ou de um serviço externo aparece em "Depende de acesso externo". Resultados das últimas execuções e o que **não** foi verificado estão em "Verificação" (seção 7).

| # | Etapa | Estado | Depende de acesso externo / não verificado |
|---|---|---|---|
| 1 | Fundação: projeto, execução, testes, lint | **Feita e verificada** (`npm test`, `npm run test:e2e`, `npm run lint`) | — |
| 2 | Fluxo mínimo: fonte local, marcar início/fim, prévia, exportar | **Feita e verificada** (e2e `app`) | — |
| 3 | Central de revisão: ordem, filtros, ajuste de tempo, timeline, categorias, títulos, semelhantes, lote com prévia, desfazer/restaurar | **Feita e verificada** (e2e `review`) | Vídeos de várias horas e telas de alta densidade (DPI > 1) não medidos |
| 4 | Qualidade e fila: QC, fila com pausa/retomada/reordenação, tentativas, recuperação, conflito de nome, não repetir concluído | **Feita e verificada** (e2e `export`, `queue`, `app`) | Kill brusco do sistema (queda de energia) só simulado por kill do processo |
| 5a | Legendas (Whisper) | **Feita e verificada**, inclusive geração real com o motor oficial e fala sintetizada pelo Windows (e2e `subtitles`; teste `subtitles-whisper`) | **Baixar motor e modelos precisa de internet** (~40 MB para o tiny); na placa NVIDIA só com o motor CUDA opcional (etapa 5k), senão no processador; fala muito baixa que passou por AAC pode virar "nenhuma fala"; a impressão auditiva não foi avaliada |
| 5b | Fontes externas (pasta do OBS, YouTube/Twitch VOD + chat) | **Feita**; OBS e yt-dlp (vídeo público "Me at the zoo" e o download de uma live de 3 h em 1440p, 12,5 GB) verificados de verdade | **Depende de acesso, permissões e disponibilidade da fonte.** O **chat da Twitch não foi verificado em rede real** (o do YouTube foi baixado pelo app numa live de 3 h, 73 mensagens; o da Twitch só com arquivos montados à mão no formato do programa); TwitchDownloaderCLI e Deno só com o teste de rede opcional (`npm run test:network`); cookies do navegador não testados com conta real |
| 5c | Análise de momentos + sugestão de títulos | **Feita** (regras provisórias); verificada com mídia sintética (e2e `analysis`) | Critérios dependem da Liz (3.5); **sem validação com gameplay/live real** |
| 5c+ | Análise por IA na nuvem (transcrição do vídeo, provedor compatível com a OpenAI, conferência local) | **Feita**; verificada com servidor local, Whisper real (BDS), e2e e **rede real com o OpenRouter** (teste opt-in com chave e uma análise completa de uma live de 3 h com modelo gratuito) | **Qualidade medida só com um modelo, uma live e um gabarito circular**: 3 de 15 com 18 sugestões, no nível do acaso e igual ao algoritmo (`docs/recursos/analise-ia.md`, 13.6). Gemini, Groq e o provedor Personalizado **nunca foram testados em rede real**. O perfil de humor do canal (critérios, exemplos, bordões, reações) foi feito depois, é testado só com servidor local e **não teve o ganho medido** (16.6) |
| 5d | Aprendizado de preferências, correspondência com lives anteriores, fonte atualizada | **Feita e verificada** (e2e `prefs`) | Prioridade e regras dependem da Liz (3.7) |
| 5e | Perfis horizontais/personalizados, enquadramento por corte (centro, desfoque, webcam + jogo, livre), ajustes de áudio por corte | **Feita e verificada** (e2e `export`, `audio`) | A impressão auditiva (estalos, naturalidade dos fades) não foi avaliada por ouvido |
| 5f | Integração entre os recursos (esta rodada) | **Contratos consolidados** em `docs/arquitetura.md` (seção 5); `app.e2e` reescrito para o fluxo real; scripts de teste; `npm test` estabilizado | Veja "Problemas conhecidos" na seção 7 |
| 5g | Aba **Projetos** (o que já foi feito, retomar com um clique, localizar vídeo movido) e ajustes das **Fontes** (hoje a tela Novo projeto; qualidade do download lembrada, repetição sem cookies, aviso de yt-dlp antigo) | **Feita e verificada** (e2e `projects`, `sources`) | Avisar quando os arquivos **exportados** de um projeto sumiram da pasta foi oferecido e não foi pedido |
| 5h | **Layouts do canal** (Conversa e Jogo, escolha do usuário, presets por canal/jogo/geral) e **detector local de layout** pela imagem | **Feita e verificada** (e2e `export-layout`, testes com ffmpeg real) | Presets medidos numa live só; o detector é conservador (na dúvida diz "incerto") |
| 5i | **OpenRouter só com modelos gratuitos** (roteador no topo e já escolhido como modelo de partida, gratuitos abaixo, interruptor ligado e garantido no código, reservas, cota do dia) | **Feita e verificada** (testes unitários, e2e `ai-openrouter` e `analysis-openrouter`, **rede real com chave de teste**) | Os modelos gratuitos são irregulares (429/404/502 do provedor, modelos que raciocinam, roteador sorteando modelo de moderação); `Retry-After` de um 429 **da conta** não foi visto |
| 5j | **Retirada do BDS em 25/10/2026** (pedido do dono: o Braga Frame fica como programa externo; o módulo, a tela e a cópia no BDS foram removidos). Era: **Módulo no BDS** (tela embutida, motores e modelos compartilhados, IA do assistente) | **Retirada** (tinha sido feita e verificada: cópia sincronizada, e2e `braga-frame` do BDS e a suíte do BDS; nada disso existe mais no BDS) | Provedor de IA real configurado no BDS não foi verificado em rede real; a regra "só gratuitos" **vale também no BDS** (modelo pago do OpenRouter recusado, cadeia de fallback filtrada; testada com o `AIService` real e servidor local) |
| 5k | **Transcrição pela placa NVIDIA** (motor CUDA oficial, automático com queda para o processador) | **Feita e verificada** (e2e `subtitles-gpu`; teste real com a GTX 1650) | Falha real do CUDA (memória esgotada, driver quebrado) só simulada; AMD e Intel sem suporte |
| 5l | Aba **Projetos**: **miniatura** do vídeo em cada cartão, **ordenar** a lista e **lixeira** (apaga o projeto e o que o app guarda dele; com a caixa marcada, também os cortes exportados e o vídeo e o chat que o próprio app baixou; o vídeo e a legenda do usuário nunca) | **Feita e verificada** (testes `thumbnails`, `project-delete` e `projects-ui`; e2e `projects` com arquivos de verdade, inclusive apagar o projeto aberto e o vídeo baixado que estava no player) | Miniatura medida só com vídeos curtos (não com uma gravação de várias horas); apagar numa unidade de rede fora do ar só testado por prazo simulado; a exclusão é recusada enquanto há exportação, análise ou transcrição do projeto (por desenho) |
| 5m | Tela **Exportações** (a antiga aba Fila, do desenho do dono): pílulas **Fila**, **Concluídos** e **Falhas** com a contagem, cartões com ícone do estado e progresso, e a **barra de saída** (perfil e destino do projeto aberto, os mesmos da aba Exportar, e o limite de exportações ao mesmo tempo) | **Feita e verificada** (testes `queue-ui` e `queue-renderer`; e2e `queue`, com exportações reais, e os que passam pela tela) | Ficaram de fora o botão de pausar em cada trabalho e o "5 de 8" do desenho (a pausa é da fila inteira e cada trabalho é um arquivo); a barra de saída muda o projeto aberto, não o que já está na fila; o menu continua com **Exportar** (preparar: enquadramento, layouts, conferência) e **Exportações** (acompanhar) como abas separadas |
| 5n | Tela **Novo projeto** (a antiga aba Fontes, do desenho do dono): pergunta e quatro cartões (**Arquivos locais**, **YouTube**, **Twitch**, **Gravações do OBS**), só o painel do escolhido, área de soltar grande (arrastar e soltar ou escolher o arquivo), o link colado que troca o cartão, a escolha lembrada, o selo "Baixando" no cartão e o salto para **Cortes** ao abrir o vídeo; a faixa de boas-vindas deixou de existir | **Feita e verificada** (testes `sources-ui` e `sources-renderer`; e2e `sources` com **arrastar e soltar de verdade**, e os que passam pela tela) | O desenho tinha o botão "Continuar" e uma quarta fonte genérica; ficaram de fora (o projeto abre direto e o quarto cartão é só o OBS, que o app de fato lê). Playlists e clipes/canais da Twitch **não são aceitos** (o texto do cartão diz). O diálogo nativo de escolher o arquivo não é acionado pelo e2e (a resposta dele entra no lugar); soltar vários arquivos abre só o primeiro |
| 5o | Tela **Início** (a "Tela Inicial" do desenho do dono): boas-vindas ("Bem-vindo de volta!", ou "Bem-vindo ao Braga Frame!" sem projetos), **busca** nos projetos (título, canal ou jogo; resultados na própria tela e Enter ou "Ver todos os resultados" abrem Projetos com o texto), atalhos **Novo projeto** e **Continuar de onde parou**, os **3 projetos mais recentes** (miniatura, estado, cortes, origem, "Abrir"/"Continuar") e a aba **inicial** do app, a primeira do menu | **Feita e verificada** (testes `home-ui` e `projects-ui`; e2e `home`, com projetos e miniaturas de verdade, busca digitada, janela estreita, tema claro e vídeo apagado; e os e2e que passam pelo menu) | Ficaram de fora o que o app não tem: nome e foto do usuário e "Online", o sino de avisos, o ícone de atualizar, o atalho ⌘K, a busca por tag, a foto do banner com o botão de play (o banner é só um brilho vermelho em CSS), o menu "⋮" dos cartões e o item "Biblioteca". A saudação não leva nome (o app não tem perfil de usuário); a busca não procura por plataforma ("twitch", "youtube") |
| 5p | **Menu lateral de 5 itens** (o do desenho do dono): **Início**, **Projetos**, **Cortes**, **Exportações** e **Configurações**. Cortes abriga como abas internas Cortes, Análise, Legendas, Áudio e Exportar; Configurações abriga Preferências e Ferramentas (texto com a linha vermelha na ativa, as cinco numa linha só até no painel mais estreito, coladas no topo nas telas largas que rolam). **Novo projeto** não tem item: abre pelos botões da Início e de Projetos e acende Projetos. O cabeçalho leva o nome do item; as contagens ficam na aba interna e só "!" e "…" sobem para o item; teclado nos dois níveis | **Feita e verificada** (testes `menu-layout`, `renderer-base` e `projects-ui`; e2e `menu`, com o app de verdade, e os que passam pelo menu: `app`, `embed`, `home`, `projects`, `sources`, `review`, `integration-flow` e `system`) | O desenho tem o item **Biblioteca**, que o app não tem (não há biblioteca para mostrar) e **não foi criado**. Legendas, Áudio, Análise e Exportar ficam um clique mais fundo, dentro de Cortes; o cabeçalho de uma aba interna mostra o nome do item (Cortes, Configurações), não o da aba |
| 5q | **Editor de Cortes** (o item Cortes, do desenho do dono): cabeçalho com **"‹ Projetos › nome do projeto"** e o estado do projeto (Novo, Em revisão, Pronto para exportar, Exportado), botão **Exportar** como ação principal (abre a aba Exportar) e **miniatura** do vídeo em cada corte da lista | **Feita e verificada** (e2e `editor`, com o app de verdade, miniaturas reais, janela mínima e tema claro; e os e2e que passam pela tela Cortes) | Ficaram de fora o que o app não tem ou não precisa: o botão **Salvar** e o de atualizar (o app salva sozinho), as abas **Momentos / Cortes / Configurações** do desenho (as abas internas de Cortes são as do app) e a **timeline sempre aberta** com a faixa de quadros e a legenda por categoria (a timeline continua opcional, pelo botão Timeline, para não decodificar o áudio de toda live ao abrir). Cada miniatura é um quadro tirado por ffmpeg, só das linhas à vista |
| 5r | Tela **Geral** de **Configurações** (a primeira aba do item, do desenho do dono): **Aparência** (Escuro e Claro, com a janelinha de cada tema), **Pasta de projetos** (o caminho real, com "Mostrar na pasta") e o cartão **Sobre** (nome, versão e frase do app) | **Feita e verificada** (testes `general-ui` e `menu-layout`; e2e `settings`, com o app de verdade, tema trocado de fato, pasta real, janela estreita e tema bloqueado dentro do BDS; e os e2e que passam por Configurações) | Ficaram de fora o que o app não tem: o tema **Sistema**, **Idioma**, **Alterar** a pasta, os interruptores **Notificações**, **Salvar automaticamente** e **Enviar dados de uso**, os links **Site, Suporte, Discord e GitHub**, as abas **Cortes, Exportação e Atalhos** (as escolhas já estão em Preferências) e o usuário "Online". A pasta de projetos é a do perfil do app e não pode ser trocada |
| 5s | **Momentos calmos** na análise do algoritmo (pedido do dono, a partir de um short sem fala nem jogada, "ainda mais com games de história"): sinal novo que acha trechos tranquilos, sem fala e sem pico, mas vivos (som e imagem continuam), com cota própria além da Quantidade e peso 0,7 | **Feita e verificada no que dá** (testes `analysis-calm`, com séries sintéticas e mídia de verdade; e2e `analysis`; conferido num short real emendado numa live de 4,7 h) | **Sem gabarito de "bom momento calmo" e sem medida de qualidade**: o sinal só prova que acha o que descreve. É calmo **perto do resto do vídeo** (um short ou uma live toda calma não gera sugestão); sem transcrição não distingue fala baixa de música baixa; tela de carregamento com imagem animada pode passar. A IA não usa o sinal (lê texto): para história com fala, o perfil de humor pode descrever o que procurar |
| 5t | **Temas do canal** e **palavras-chave por sugestão** na análise por IA (pedido do dono, 25/10/2026, depois de ver um repositório de cortes virais): o perfil de humor ganha o campo **Temas** (a IA prefere esses assuntos, distribui os cortes entre eles e marca o tema de cada um); cada sugestão da IA traz de 3 a 5 palavras-chave, mostradas como `#palavra` no cartão e, ao virar corte, na linha do corte | **Feita e verificada no que dá** (testes `analysis-humor`, `analysis-humor-ai` com servidor local que imita o provedor, `analysis-ui`; e2e `editor`) | **Não medido** se melhora as sugestões, e **não verificado com um provedor de verdade** (só com o servidor local, como o resto da IA). O algoritmo não usa temas nem gera palavras-chave. A IA pode marcar um tema ou palavra errada: o tema inventado é descartado, as palavras-chave não têm como ser conferidas |

## 6. Mapa de código

- `main.js` / `preload.js`: janela e ponte segura (`window.bf`; contextIsolation + sandbox).
- `src/ipc`: `index.js` carrega `handlers/*.js` (um por recurso); `context.js` monta o `ctx` (pastas, ferramentas, `handle`).
- `src/core/ffmpeg`: localizar ferramentas e analisar mídia.
- `src/core/export`: perfis, enquadramento, codificadores, QC e execução de cada trabalho (`jobRunner`); `src/core/queue`: a fila (estado em `queue.json`).
- `src/core/projects`: modelo do projeto v2 (`model.js`, migra o v1), persistência (`projectStore.js`), correspondência com lives (`matcher.js`), comparação de fonte (`compare.js`), miniaturas dos vídeos (`thumbnails.js`) e os arquivos de um projeto para a exclusão (`projectFiles.js`).
- `src/core/review` e `src/core/history`: central de revisão (lógica pura, "universal") e histórico em disco.
- `src/core/audio`, `src/core/subtitles`, `src/core/analysis`, `src/core/sources`, `src/core/preferences`, `src/core/tools`: um recurso cada (veja `docs/recursos/<recurso>.md`).
- `renderer/`: `app.js` (`window.BF`), `app.css` e `features/<recurso>.js|.css` (uma aba por recurso).
- `tests/`: unitários (`*.test.js`) e e2e (`tests/e2e/*.e2e.js`, com `helpers.js`); `scripts/`: executores de teste (`run-e2e.js`, `run-network-tests.js`, `run-perf-tests.js`).
- Como acrescentar um recurso: [recursos/base.md](recursos/base.md). Contratos: [arquitetura.md](arquitetura.md).

## 7. Verificação (última rodada de integração)

Máquina: Windows 11, 8 threads, GTX 1650 (4 GB), Node 24.14, ffmpeg "full" 2026-02-09, yt-dlp 2026.08.19 (a versão fixada pelo app). Todos os números abaixo são de execuções reais em 23/10/2026, na versão final do código (nada foi commitado).

| Comando | Resultado |
|---|---|
| `npm test` (2 arquivos por vez; sem `BF_SKIP_NETWORK_TESTS`, então o teste que baixa o Whisper de 40 MB rodou) | **1.516 testes, 1.506 passaram, 0 falharam, 10 pulados**, em 682 s. Os 10 pulados são os de rede real desligada por padrão (6: releases do GitHub, yt-dlp, "Me at the zoo", TwitchDownloaderCLI, Deno e o catálogo do OpenRouter), os dois opt-in com chave (`ai-openrouter-real`, `ai-real-network`), o vídeo de 20 min (`test:perf`) e a transcrição real do dono (`BF_TEST_SRT`) |
| `npm run test:e2e` (um arquivo por vez) | **25 de 25 passaram.** Na rodada completa de 25/10/2026 (14 min 47 s) 23 passaram; `analysis-ia` esperava o perfil de humor sem o campo novo `themes` e `editor` falhou uma vez por medir o cabeçalho no meio da transição do menu (agora ele espera a transição); os dois foram ajustados e passaram. Novos nas últimas etapas: `menu`, `editor` e `settings` |
| `npm run test:perf` | **não repetido nesta rodada**; a última medida (análise de 20 min de vídeo em 2,3 s no modo normal e 1,5 s no rápido, sem crescer a memória) está em `docs/recursos/analysis.md` |
| `npm run lint` | limpo (rodado de novo depois da última edição) |
| Rede real **sem chave**: `BF_NETWORK_TESTS=1 node --test tests/ai-openrouter-network.test.js` | passou: o catálogo público do OpenRouter (468 modelos, 20 com preço zero, 8 gratuitos adequados à análise mais o roteador, 11 outros gratuitos). O restante do `npm run test:network` (GitHub, yt-dlp, Whisper de 40 MB) **não foi repetido nesta rodada** |
| Rede real **com chave de teste** (opt-in): `tests/ai-openrouter-real.test.js` | **passou contra o OpenRouter de verdade** (398 s, 6 pedidos de conversa na rede, 4 pedidos gratuitos gastos): trava recusando um modelo pago real sem enviar nada, modelo inválido, roteador, modelo fixo e uma mini-análise com troca para a reserva (`docs/recursos/openrouter-gratuito.md`, seção 6); a chave e o `user_id` da conta não aparecem na saída |
| Análise **real** de uma live de 3 h com modelo gratuito (Nemotron 3 Ultra) | completou pelo código de produção (6 blocos + escolha final, 18 sugestões, 9 chamadas, ~22 min, US$ 0): **3 dos 15 cortes de referência, no nível do acaso** (12% de chance de 3 ou mais); ver `docs/recursos/analise-ia.md`, seção 13.6 |
| BDS (`D:\Projetos\Braga Digital Studio`) | `npm test` do BDS: **923 testes, 0 falhas** (941 antes de a integração com o Braga Frame sair do BDS: os 18 testes dela saíram junto); `npm run check`, `verify:preload` e `verify:braga-frame` (192 arquivos, manifesto conferido) ok; e2e `braga-frame` do BDS: **OK** (módulo ligado e desligado, ferramentas e modelos do BDS reconhecidos, 15 abas, exportação real pela fila, tela Exportações (pílulas e barra de saída), aba Projetos com miniatura e lixeira, a tela Novo projeto (cartões e área de soltar) e a tela Início (boas-vindas, atalhos e o projeto aberto entre os recentes) dentro do iframe, inclusive apagar o projeto aberto, IA do assistente somente leitura, tema repassado, sem processo órfão) |

**O que as rodadas mostraram (e foi corrigido):**

- O `npm test` com o executor padrão (7 arquivos ao mesmo tempo) falhava por lentidão e não por defeito: a análise roda com prioridade abaixo do normal e, com o computador saturado, a mesma análise de 20 min levou 550 s (2,3 s em repouso). Medida de base nesta máquina: 735 testes, 724 passaram, 4 falharam, 1 cancelado, 597 s. Correções: `--test-concurrency=2`, esperas por condição com prazo folgado em `tests/analysis-*`, limpeza de pastas temporárias tolerante a EPERM, e o teste de 20 min foi para `npm run test:perf` (ficou uma versão de 3 min no `npm test`).
- Dois testes de outros recursos eram intermitentes por construção e foram corrigidos sem enfraquecer nenhuma asserção: `tests/tools-ipc.test.js` ("cancelar no meio do download": o servidor "de espera" mandava o zip inteiro de ~260 bytes e a instalação terminava em milissegundos; falhava em 1 de 4 execuções isoladas e agora passou 6 de 6) e `tests/queue-store.test.js` ("outro processo lendo o arquivo…": exigia 100 leituras em 1,2 s e, sob carga, o leitor fez 45; agora lê até o gravador terminar e ter lido mais de 100 vezes). Em 23/10, depois de acrescentar arquivos de teste (o que muda quais arquivos rodam juntos), o mesmo teste falhou duas vezes seguidas no `npm test` completo ("gravou 7 vezes" contra o mínimo de 8; sozinho, a mesma carga faz de 32 a 74 gravações, porque o rename recusado com o leitor em cima espera centenas de milissegundos): o laço do gravador passou a continuar até o mínimo de 8 gravações (teto de 30 s), sem afrouxar nenhuma asserção.
- `tests/e2e/review.e2e.js`, passo do **clique de mouse de verdade** em "Aprovar" depois de digitar o título, passou a falhar (em 3 de 3 execuções, **também com o código de antes da tela Novo projeto**, conferido numa cópia à parte): com a última linha rente ao fim da lista, os avisos dos passos anteriores (Aprovou 3 cortes, "Use o formato m:ss…", "Não há sugestões novas…") ficam no canto da janela exatamente sobre o botão e o clique caía no aviso, não no botão. O teste agora limpa os avisos antes de clicar (o que ele prova é que o clique não se perde por redesenho da lista); o produto não mudou. Passou 3 de 3 depois disso.
- `app.e2e.js` e `tools.e2e.js` estavam desatualizados (aba Exportar mínima antiga, registro de ferramentas vazio) e foram reescritos/ajustados; o `app.e2e` passou 3 de 3 depois da última edição e 12 de 12 na rodada completa.

**Problemas conhecidos / testes instáveis (nenhum bloqueia o uso):**

- Na primeira rodada completa, com o computador ocupado por outras execuções, três e2e falharam e **passaram isolados em seguida** (e na rodada final): `audio` (causa provável: espera de 8 s por 5 amostras da reprodução em `tests/e2e/audio.e2e.js`, linha 265, curta demais com a máquina ocupada), `export` (condição de corrida lida no código: no arrasto do retângulo, `nextPreview` devolve a primeira prévia intermediária e lê os pixels 150 ms depois, `tests/e2e/export.e2e.js`, linhas 139 a 151) e `review` ("Criou 6 cortes" ausente do histórico, `tests/e2e/review.e2e.js`, linha 494; **causa não identificada**: passou isolado logo depois e coincidiu com edições de outro integrador em `src/core/history/log.js`). Em modo paralelo (`BF_E2E_PARALLEL=3`) o `prefs` falhou uma vez em "sugestões aguardando evidência" (`tests/e2e/prefs.e2e.js`, linha 176, espera de 8 s depois de um `sleep(900)`) e passou 3 de 3 isolado. São testes sensíveis à carga dos donos de cada recurso; o executor tem `BF_E2E_RETRIES=n` para localizá-los (quem passa só na repetição aparece como instável).
- O que **não foi verificado**: chat da Twitch em rede real (o do YouTube foi baixado numa live de 3 h); TwitchDownloaderCLI e Deno reais (só com `npm run test:network` + `BF_NETWORK_TOOLS_ALL=1`, não executados); o `npm run test:network` completo nesta rodada; Gemini, Groq e o provedor Personalizado em rede real (só o OpenRouter foi); a qualidade da IA em outros modelos, lives e provedores (uma live, um modelo, gabarito circular); o `Retry-After` de um 429 da conta no OpenRouter; um provedor de IA real configurado no assistente do BDS (a regra "só gratuitos" vale lá, mas só foi testada com servidor local); falha real do CUDA com a placa (só simulada); Linux/macOS; a impressão auditiva da prévia de áudio; layout em janela estreita (< 860 px) e telas de alta densidade.
- Os e2e `sources` e `subtitles` **baixam de verdade**, por desenho (yt-dlp do sistema + o vídeo público "Me at the zoo" de 19 s numa pasta temporária; motor whisper.cpp oficial e modelo tiny, ~40 MB, instalados pela aba Legendas num perfil temporário); tudo é apagado no fim. `BF_E2E_OFFLINE=1` pula a parte de rede do e2e de Fontes.
