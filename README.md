# Braga Frame

*Cortes verticais para criadores: analisa, revisa e exporta (a publicação é sua).* — transforma gravações em arquivos prontos para você publicar onde quiser; o app não publica nada.

> "Braga Frame" é o nome de trabalho; marca (INPI), domínio e redes ainda não foram verificados. O nome fica centralizado em [`src/appInfo.js`](src/appInfo.js) (mais o título em `renderer/index.html` e o `package.json`).

Programa separado do Braga Digital Studio (BDS), com a mesma base técnica (Electron + Node), para analisar gameplays e lives, revisar cortes e exportar em vertical 9:16 com controle de qualidade.

## Pré-requisitos

- **Windows 10/11** (único sistema em que o app foi executado; o código de Linux/macOS existe, mas não foi testado), **Node.js** (desenvolvido com Node 24) e `npm install` (traz o Electron).
- **FFmpeg e ffprobe** no PATH (ou `CORTE_FFMPEG` / `CORTE_FFPROBE` apontando para os executáveis). No Windows 64 bits a aba **Ferramentas** (e o aviso vermelho do topo) tem o botão **Instalar o FFmpeg**, que baixa uma compilação de terceiros (Gyan Doshi, licença GPL v3) com tamanho e SHA-256 conferidos, só quando você clica; nos outros sistemas, ou se preferir, instale à mão (a aba mostra a versão detectada e como instalar). Para legenda incorporada o FFmpeg precisa do filtro `subtitles` (libass; as builds "full" têm); a aceleração por placa NVIDIA (NVENC) é opcional e testada de verdade antes de ser usada.
- Opcionais, instalados pelo próprio app (aba **Ferramentas**, só de releases oficiais, com URL fixa, tamanho e SHA-256 conferidos): **yt-dlp** e **Deno** (VODs do YouTube/Twitch), **TwitchDownloaderCLI** (chat da Twitch) e **whisper.cpp** (legendas automáticas). Baixar depende de internet e, no caso dos VODs, de acesso e disponibilidade da fonte ([docs/recursos/tools.md](docs/recursos/tools.md)).

## Como usar

```bash
npm install
npm start
```

No Windows, dá para usar o **`BF_Menu.bat`** (dois cliques): menu com **1** rodar o aplicativo (instala as dependências na primeira vez), **2** testes, **3** testes e2e, **4** lint e **0** sair. Ele precisa do Node.js instalado. Para gerar o instalador do Windows (NSIS, ainda sem assinatura digital) use `npm run dist`: o arquivo sai em `dist/installer/`; `npm run dist:dir` gera só a pasta descompactada para teste. Os dados do usuário ficam em `%APPDATA%\braga-frame` (atualizar ou desinstalar não os apaga) e o log, em `logs/bragaframe.log` nessa pasta. O FFmpeg não vai dentro do instalador: o próprio app o instala pelo botão **Instalar o FFmpeg** (ou use um que já esteja no PATH ou em `CORTE_FFMPEG`).

1. **Novo projeto** (botão da **Início** e de **Projetos**): escolha de onde vem o vídeo (**Arquivos locais**, **YouTube**, **Twitch** ou **Gravações do OBS**). Em Arquivos locais, arraste o arquivo para a janela ou clique na área de soltar (MP4, MKV, MOV, WebM, AVI, FLV, TS); o botão **Abrir vídeo** do cabeçalho faz o mesmo de qualquer tela. Sem vídeo aberto, **Início**, **Projetos** (com o **Novo projeto**), **Exportações** e **Configurações** (**Preferências** e **Ferramentas**) já funcionam, e o app abre na **Início**; só o item **Cortes** espera um vídeo.
2. Posicione o player, use **Marcar início / Marcar fim** (ou digite `m:ss.d`; atalhos `I` e `O`) e **Ver trecho**; **Salvar corte**.
3. Revise em **Cortes**, ajuste o que quiser (nas abas **Legendas** e **Áudio**, e o enquadramento em **Exportar**) e **aprove**.
4. Na aba **Exportar** (dentro de **Cortes**), confira o perfil e use **Adicionar à fila**; acompanhe em **Exportações**.

Os cortes saem em `Cortes` ao lado do vídeo (ou na pasta escolhida). **Nada é sobrescrito sem a sua escolha**: se o nome já existe, a fila pergunta (outro nome "(2)", pular ou, com confirmação extra, substituir). O projeto (cortes, títulos, decisões, configurações e exportações) é salvo automaticamente e reaberto ao abrir o mesmo vídeo. Exportar só gera arquivos locais: a publicação é manual.

### O menu e as telas

O menu lateral tem **cinco itens**: **Início**, **Projetos**, **Cortes**, **Exportações** e **Configurações**. **Cortes** reúne, como abas em cima do painel, o que trabalha sobre o vídeo aberto, ao lado do player: **Cortes**, **Análise**, **Legendas**, **Áudio** e **Exportar**; **Configurações** reúne **Geral**, **Preferências** e **Ferramentas**. **Novo projeto** não tem item de menu: abre pelos botões da **Início** e de **Projetos**.

| Tela | No menu | Para que serve |
|---|---|---|
| **Início** | Início | A tela de abertura: boas-vindas, **busca** pelos seus projetos (título, canal ou jogo; Enter abre a lista completa), **Novo projeto**, **Continuar de onde parou** (abre o projeto mais recente) e os **3 projetos mais recentes** com miniatura, estado e número de cortes. É a tela inicial |
| **Projetos** | Projetos | Lista dos vídeos que já têm projeto, com a **miniatura** do vídeo, o estado de cada um (Novo, Em revisão, Pronto para exportar, Exportado), números de cortes, busca, filtros e ordem; "Abrir" (ou a miniatura) retoma de onde parou e avisa quando o vídeo foi movido ("Localizar vídeo…" reaproveita os cortes no arquivo novo). A **lixeira** apaga o projeto; a confirmação mostra o que sai e, com a caixa marcada (padrão), apaga também os cortes exportados e o vídeo e o chat que o próprio app baixou. O vídeo que você trouxe nunca é apagado |
| **Novo projeto** | sem item: abre pelos botões da Início e de Projetos | Quatro cartões para começar: **Arquivos locais** (arrastar e soltar ou escolher o arquivo), **YouTube** e **Twitch** (o link de um vídeo ou VOD, com progresso, cancelar/retomar e chat quando existe) e **Gravações do OBS** (lê a pasta de gravação do próprio OBS). Só o painel do cartão escolhido aparece, e o app lembra a escolha. Ao abrir o vídeo, segue para **Cortes**. Playlists e clipes da Twitch não são aceitos |
| **Cortes** | Cortes › Cortes | O cabeçalho mostra "Projetos › nome do projeto", o estado dele e o botão **Exportar**. Lista na ordem cronológica da live (ou por relevância), cada corte com **miniatura**, filtros, ajuste de tempo de início/fim, categorias, notas, títulos (sugestões locais que nunca trocam o seu), cortes semelhantes, aprovação/rejeição em lote com prévia, **Desfazer/Refazer**, histórico com **Restaurar** e uma **timeline** opcional com a forma de onda real |
| **Análise** | Cortes › Análise | Dois motores. **Algoritmo**: regras simples (pico de áudio, mudança de cena/movimento, agitação do chat e, à parte, **momentos calmos**: trechos tranquilos, sem fala e sem pico, como um jogador só construindo ou uma cena de história), roda no computador. **IA na nuvem**: um provedor compatível com a OpenAI (Gemini, Groq, OpenRouter ou outro) lê a transcrição do vídeo (gerada com o Whisper ou importada de um .srt/.vtt); o app confere cada horário e cada frase antes de sugerir, e só envia algo depois de você aceitar o aviso de privacidade. No **OpenRouter** o interruptor **Usar apenas modelos gratuitos** vem ligado e é garantido no código (um modelo pago nem é enviado): o roteador gratuito fica no topo da lista e já vem escolhido (você pode trocar), os modelos gratuitos logo abaixo, e você pode ordenar até 3 modelos de reserva. O cartão **Perfil de humor do canal** diz o que é um bom corte do SEU canal: critérios e exemplos de cortes que você aprovou e rejeitou (a IA recebe, e você vê antes quais trechos iriam) e listas de bordões e reações (o algoritmo conta). **Não é garantia**: as sugestões entram como cortes pendentes, nunca aprovados (`docs/recursos/analise-ia.md`, seção 16 para o perfil; o efeito dele ainda não foi medido) |
| **Legendas** | Cortes › Legendas | Geração opcional e local (Whisper, na placa NVIDIA quando há o motor CUDA e no processador nos demais casos) só do trecho do corte, revisão e sincronia do texto, aparência (prévia sobre o player), incorporada ao vídeo e/ou arquivo SRT/ASS separado. Nunca inventa fala: sem fala, o resultado é "nenhuma fala detectada" |
| **Áudio** | Cortes › Áudio | Só ajuste **manual** por corte: ganho em dB, mudo e fades, comparação Original × Ajustado, desfazer/refazer e histórico. Sem normalização nem redução de ruído automáticas; o áudio da fonte nunca é alterado |
| **Exportar** | Cortes › Exportar | Perfil (9:16 1080p H.264 10 Mbps é o padrão; 1440p, 2160p, H.265, 16:9 e perfis seus), enquadramento (centro, fundo desfocado, webcam + jogo, retângulo livre) por projeto ou por corte com **prévia real**, **layouts Conversa e Jogo** (sugeridos pela análise, detectados pela imagem ou escolhidos por você: a decisão é sempre sua), cortes a exportar, destino, **conferência de qualidade** (erros com causa e solução bloqueiam só o corte afetado; avisos nunca bloqueiam) e **Adicionar à fila** |
| **Exportações** | Exportações | A fila em três pílulas com a contagem (**Fila**, **Concluídos** e **Falhas**): progresso e tempo restante, pausar/retomar, reordenar, cancelar, tentativas automáticas só para falhas passageiras, recuperação depois de uma queda, conflito de nome e "já exportado" (não repete concluído). Embaixo, a barra com o perfil e o destino do projeto aberto (os da aba Exportar) e o limite de exportações ao mesmo tempo |
| **Geral** | Configurações › Geral | A primeira aba de Configurações: **Aparência** (Escuro ou Claro), **Pasta de projetos** (onde ficam os projetos, com "Mostrar na pasta") e o cartão **Sobre** (nome, versão e frase do app) |
| **Preferências** | Configurações › Preferências | Valores gerais, por jogo e por canal (o mais específico vence), aprendizado com as suas decisões (visível, editável, desativável e desfazível), histórico de mudanças e avisos de live já analisada ou de fonte atualizada |
| **Ferramentas** | Configurações › Ferramentas | Mostra o FFmpeg/ffprobe do sistema e instala/remove as ferramentas oficiais do app |

## Testes

```bash
npm test               # unitários e de integração com ffmpeg real (~1.490 testes; cerca de 12 minutos nesta máquina)
npm run test:e2e       # todos os e2e (abre o app Electron de verdade), um por vez, com resumo e tempo por arquivo (25 arquivos, de 15 a 20 minutos)
npm run test:e2e -- export queue   # só alguns (nome exato ou trecho do nome); BF_E2E_PARALLEL=2 roda 2 ao mesmo tempo
npm run test:network   # rede real (releases do GitHub, yt-dlp, "Me at the zoo", whisper, catálogo público do OpenRouter): desligado no npm test
node --test tests/ai-openrouter-real.test.js   # OPT-IN, com chave: BF_AI_TEST_KEY=<chave do OpenRouter>; no máximo 8 pedidos de conversa, dados sintéticos (sem a variável, é pulado)
npm run test:perf      # desempenho da análise com 20 min de vídeo: desligado no npm test
npm run lint
```

- O `npm test` roda 2 arquivos de teste por vez (`--test-concurrency=2`): a análise usa prioridade abaixo do normal e, com muita concorrência, os prazos estouram por lentidão e não por erro. Um único teste baixa ~40 MB (o motor e o modelo do Whisper): `BF_SKIP_NETWORK_TESTS=1 npm test` o pula; sem internet ele já se pula com o motivo.
- Os e2e usam porta de depuração dinâmica e um perfil de usuário temporário, então não interferem nos seus projetos e podem rodar em paralelo. `BF_E2E_SHOTDIR=<pasta>` guarda capturas da janela; `BF_E2E_OFFLINE=1` pula a parte de rede real do e2e de Novo projeto (`sources`).
- Variáveis de ambiente úteis: `CORTE_FFMPEG`, `CORTE_FFPROBE`, `CORTE_YTDLP`, `CORTE_WHISPER`, `CORTE_TWITCHDOWNLOADER` (caminhos), `BF_NETWORK_TESTS`, `BF_NETWORK_TOOLS_ALL`, `BF_REQUIRE_NETWORK`, `BF_PERF_TESTS` (listadas em [docs/arquitetura.md](docs/arquitetura.md), seção 5.14).

Arquitetura e contratos: [docs/arquitetura.md](docs/arquitetura.md); como acrescentar um recurso: [docs/recursos/base.md](docs/recursos/base.md); um documento por recurso em [docs/recursos/](docs/recursos/).

## Instalador, atualização e licenças

- **Para usar o app** (sem mexer em código): [docs/guia-do-usuario.md](docs/guia-do-usuario.md).
- **`npm run test:installer`** gera o instalador de duas versões com uma identidade de teste ("Braga Frame Teste", que não toca numa instalação real), instala em silêncio, abre o programa instalado, atualiza por cima, confere que os projetos ficaram e desinstala (Windows; uns 4 minutos, ou 1 com `-- --reuse`). Roda também na CI (job `installer`).
- **Publicar uma versão**: enviar uma tag (`git tag v0.2.0` e `git push origin v0.2.0`) faz o GitHub Actions compilar o instalador e criar a Release, com um arquivo só e sem artefatos nem cache guardados. Detalhes em [docs/publicar-release.md](docs/publicar-release.md).
- **Licenças de terceiros**: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (vai dentro do instalador, com os textos das licenças das fontes). O Braga Frame em si é software livre sob a **GPL v3 ou posterior** (veja [Licença](#licença)).
- **Aviso de versão nova**: o app consulta a última Release do GitHub ao abrir (dá para desligar) e avisa; não instala sozinho. [docs/atualizacao.md](docs/atualizacao.md).
- **Assinatura digital e licença**: decisões pendentes em [docs/comercial.md](docs/comercial.md). Nada de pagamento ou licenciamento comercial foi implementado.
- **Suporte**: Configurações > Geral > Suporte copia as informações do computador (sem segredos nem o nome de usuário do Windows) e mostra o registro.

## Licença

O Braga Frame é software livre: você pode redistribuí-lo e/ou modificá-lo sob os termos da **GNU General Public License, versão 3 ou (a seu critério) qualquer versão posterior**, publicada pela Free Software Foundation. Ele é distribuído **sem nenhuma garantia**, nem mesmo de comercialização ou de adequação a um fim específico. O texto completo está em [LICENSE](LICENSE) e acompanha o instalador (`LICENSE.bragaframe.txt`).

Copyright (C) 2026 Mauro Braga Filho

Os componentes de terceiros e as licenças deles estão em [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Ainda **não há política para contribuições de terceiros** (DCO ou acordo de contribuição): combine antes de enviar código.

## Assinatura de código

O instalador **ainda não é assinado** (a v0.1.0 saiu sem assinatura, e o Windows pode mostrar o aviso do SmartScreen). O projeto está se preparando para a assinatura gratuita da SignPath Foundation, que atende projetos de código aberto: a [política de assinatura](CODE_SIGNING_POLICY.md) e o guia ([docs/assinatura-signpath.md](docs/assinatura-signpath.md)) já estão no repositório. Depois da aprovação, esta seção passará a dizer: *Free code signing provided by SignPath.io, certificate by SignPath Foundation.*

## Estado do projeto

Todas as telas estão implementadas e verificadas com ffmpeg e Electron reais. Requisitos confirmados, **decisões provisórias a confirmar com a Liz** e o estado real de cada etapa: [docs/requisitos-e-etapas.md](docs/requisitos-e-etapas.md).

## Limites conhecidos

- **Só Windows foi executado.** Linux e macOS: código escrito, não testado (macOS nem tem pacote oficial do whisper.cpp).
- **A análise de momentos é provisória**: os critérios de "bom momento" ainda dependem da Liz. O algoritmo foi calibrado com mídia sintética e **medido numa live real contra 15 cortes escolhidos à mão** (uma live só, gabarito feito lendo a mesma transcrição, então circular; números em [docs/recursos/analise-ia.md](docs/recursos/analise-ia.md)). Sugestão não é garantia. O chat do YouTube foi baixado de verdade numa live (73 mensagens); o da Twitch **não foi verificado em rede real**.
- **Modelos gratuitos do OpenRouter são irregulares** (medido em 23/10/2026): o provedor de um modelo pode recusar (429, 404, 502), alguns modelos que "pensam" gastam a saída raciocinando, o roteador gratuito às vezes sorteia um modelo de moderação (o app descarta essa resposta) e um modelo grande pode levar de 1 a 5 minutos por chamada. O app tenta de novo, usa os modelos de reserva que você ordenar e explica cada erro, mas uma análise pode demorar mais de 20 minutos ou perder um bloco (a tela avisa).
- **Baixar VODs depende da fonte** (acesso, permissões, disponibilidade; o YouTube às vezes pede "confirme que você não é um robô"). O app explica a causa e a solução, mas não contorna isso.
- **Legendas**: só com o processador, o modelo padrão (Pequeno) leva de alguns segundos a mais de um minuto por corte; com placa NVIDIA e o motor CUDA opcional (675 MB, ou o do BDS) é bem mais rápido (automático, com queda para o processador se a placa falhar; AMD e Intel não têm suporte). A confiança do modelo não garante que o texto esteja certo (por isso a revisão humana existe). Fala muito baixa que passou por AAC pode virar "nenhuma fala detectada". Usa a primeira faixa de áudio do vídeo.
- **Áudio e forma de onda usam a primeira faixa de áudio** (gravações do OBS com várias faixas: a faixa 1 costuma ser a mistura). A impressão auditiva da prévia (estalos, fades) não foi avaliada por ouvido.
- **Pausar a fila não suspende o ffmpeg**: interromper recomeça o trabalho do início. NVENC controla o bitrate pior que o software em conteúdo muito ruidoso (o teto `maxrate` não é garantido).
- Fontes HDR, com rotação ou pixel não quadrado não recebem tratamento especial. O player usa o Chromium: HEVC e alguns MKV podem não tocar na prévia, mas a exportação com ffmpeg funciona.
- A marca "Braga Frame" é nome de trabalho (INPI, domínio e redes não foram verificados).
