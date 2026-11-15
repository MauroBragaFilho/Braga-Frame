# Teste de sistema completo (`tests/e2e/system.e2e.js`)

Dono: **integração**. Os recursos (exportEngine, queue, audio, subtitles, review, analysis, sources, prefs) e a base foram feitos em paralelo, cada um testado só pelo próprio lado. Este teste percorre a **jornada inteira do produto num único app Electron de verdade** (perfil de usuário temporário), cruzando todos os recursos, com dados reais gerados na hora e resultados conferidos **em disco, por fora do app** (ffprobe, volumedetect, pixels, hash). O contrato continua em [`../arquitetura.md`](../arquitetura.md); o que os pares de recursos precisam um do outro está em [`integracao.md`](integracao.md).

## Como rodar

```bash
node tests/e2e/system.e2e.js                 # a jornada inteira (de 2,5 a 5 min nesta máquina, conforme a carga)
npm run test:e2e -- system                   # o mesmo pelo executor de e2e (um arquivo, com resumo e tempo)
BF_NETWORK_TESTS=1 node tests/e2e/system.e2e.js
```

Pré-requisitos: Node 24, `ffmpeg`/`ffprobe` no PATH (com libass; NVENC é opcional, o app cai para software), Windows (o passo de queda usa `taskkill`). `yt-dlp` só é preciso no passo 9. O teste abre o app com `--mute-audio` (a prévia de áudio passa pelo Web Audio, mas nada sai nas caixas de som), usa um `%APPDATA%` próprio (a configuração do OBS é de mentira, em pasta temporária) e **não toca em nada fora da pasta temporária** `bf-system-*` de `%TEMP%`.

| Variável | Efeito |
|---|---|
| `BF_NETWORK_TESTS=1` | liga o **passo 9** (rede real): baixa "Me at the zoo" (`https://www.youtube.com/watch?v=jNQXAC9IVRw`, ~19 s) pela aba Novo projeto, com o yt-dlp do sistema, numa pasta temporária, e abre como projeto com `origin` `vod`. Se o YouTube pedir verificação ("confirme que você não é um robô"), o passo termina como **NÃO verificado** (não falha) |
| `BF_REQUIRE_NETWORK=1` | liga a **geração real de legenda com o whisper** (passo 5): o app instala o motor oficial e o modelo Tiny (~40 MB, tamanho e SHA-256 conferidos pelo instalador) e gera a legenda de S3 a partir de uma fala sintetizada pelo Windows (voz pt-BR) |
| `BF_SUBTITLES_TEST_CACHE=<pasta>` | o mesmo, sem baixar: copia `tools/whisper` e `models` de uma pasta já instalada (desenvolvimento) |
| `BF_SYSTEM_UNTIL=n` | (desenvolvimento) para depois do passo `n` (`6.1` a `6.4` param dentro do passo 6) e limpa tudo |
| `BF_E2E_SHOTDIR=<pasta>` | guarda capturas da janela de alguns passos (`system-*.png`) |

Sem `BF_REQUIRE_NETWORK` e sem cache, o teste **pula a geração real de legenda e diz isso** no resumo final (`↷ PULADO: …`); sem `BF_NETWORK_TESTS` o passo 9 aparece como `⚠ NÃO verificado`. A legenda manual (incorporada e em arquivo separado) roda sempre.

## O material de teste

Uma gravação "estilo OBS" gerada com o ffmpeg: 1080p/30 quadros, H.264 + AAC estéreo 48 kHz, **120 s**, na pasta de gravação de um perfil de OBS de teste (`basic.ini`/`user.ini` em um `%APPDATA%` temporário). Vídeo: o quadro codificado por posição (**R = x, G = y, B = 0**: a cor de um pixel diz de onde da fonte ele veio, e o branco só pode ser legenda), com **uma mudança de cena** (quadro quase branco) em **52,0–52,5 s**. Áudio: ruído a -50 dB com **rajadas a -20 dB** em **20–23 s** e **95–98 s**. Os instantes são conhecidos, então a análise é conferida contra eles.

## Os passos e o que cada um confere

| # | Passo | Confere (resumo) |
|---|---|---|
| 1 | Sem projeto | Novo projeto, Exportações, Preferências e Ferramentas utilizáveis e sem botão morto; as outras abas desabilitadas com a dica; FFmpeg/ffprobe encontrados na aba Ferramentas; Fontes lista a gravação da pasta do OBS (duração do ffprobe, `.txt` ignorado) e a abre como projeto (`origin {type:'obs'}`) |
| 2 | Análise | 3 sugestões, uma por evento conhecido (cobrem 21,5 s, 52,25 s e 96,5 s, pico a ≤ 2,5 s, motivos legíveis); "Adicionar todas" cria cortes `pending`, `origin:'auto'`, com relevância e motivos, 1 `cuts:changed` e 1 `decision create` por corte (com `origin:'auto'`); reanalisar (cache e "sem usar o guardado") não duplica nada |
| 3 | Revisão | 5 cortes manuais pela barra do player; ordem da live e por relevância; filtros; categorizar em lote (prévia, Desfazer pelo aviso, Refazer); aprovar em lote (cancelar não muda nada, 1 grupo, 1 `cuts:changed`); ajuste fino com `revision` subindo, selo "Alterado" e filtro, desfazer devolve o tempo; semelhantes ("Manter um…" aprova S1 e rejeita o parecido); rejeitar; histórico com restauração com prévia e **desfazer a restauração** devolvendo exatamente o estado anterior |
| 4 | Preferências | as decisões chegam ao `learned.json` (7 cortes observados: o pendente sem categoria não); jogo e canal do projeto; **canal 80% > jogo 60% > geral 40% > padrão**, com "Limpar" voltando a herdar e a aba Análise usando o valor em vigor; 4 aprovações não valem (evidência mínima 5), a 5ª vira preferência aprendida com evidência legível, aviso, cartão e efeito na aba Análise; desativar, desfazer pelo histórico (com confirmação) e a chave geral |
| 5 | Áudio e legendas | +6 dB e fade in/out em S1, **Original x Ajustado** lidos do `AnalyserNode` do player (+6 dB), histórico de 3 entradas, desfazer e refazer; legenda manual incorporada (M2) e em arquivo separado `.srt` (M3); ajustes de áudio/legendas **não** chegam ao aprendizado; whisper real (opcional, acima) |
| 6 | Exportação | perfil padrão 9:16 1080p H.264 a 10 Mbps; **enquadramento por corte** (M4) sem alterar perfil nem padrão do projeto e prévia = mesmo filtro; 5 cortes na fila (software); **fila paralela 2** (máximo observado = 2), **pausar** (nada novo começa), **reordenar** (↑), **cancelar** um (sem arquivo nem `.part`) e **tentar de novo**; cada arquivo conferido com ffprobe; anotação em `cut.exports`; pixels (enquadramento por corte, legenda incorporada só no intervalo da fala, vídeo sem texto com `.srt` ao lado); volumedetect (+6 dB, fades; corte sem ajuste sai igual); **repetição evitada** (`ALREADY_DONE`); QC: **H.265 1440p só avisa** (`HEVC_COMPAT`) e um corte além do fim é **erro** (`INVALID_RANGE`) que tira só ele do envio; **conflito de nome**: renomear, pular e **substituir só após a 2ª confirmação** (com "Voltar"), com a anotação do corte passando a descrever o arquivo novo e o "já exportado" do trabalho antigo deixando de valer; perfil **horizontal** com `{perfil}` no nome; o erro do QC **dentro da fila** (`export:prepare` + `queue:enqueue`) falha só aquele trabalho, com causa e solução, sem repetir |
| 7 | Interrupção | 3 cortes longos (60 s, software); app **morto** (`taskkill /T /F`) com 2 exportando e 1 na fila (sobra `.part`); ao reabrir: banner **Retomar/Descartar**, nada recomeça sozinho, "Retomar" refaz do início; 3 arquivos válidos, **nenhum `.part`, nenhuma duplicata**, os arquivos já prontos intactos (hash e data); ao reabrir o projeto, as exportações concluídas com ele fechado são anotadas nos cortes |
| 8 | Persistência | fechar normalmente e reabrir: os 12 cortes (decisões, títulos, categorias, enquadramento, áudio, legendas, exportações), `ext.*`, perfil escolhido, preferência aprendida e histórico idênticos; **o mesmo vídeo por outro caminho**: pergunta de correspondência (Cancelar não abre nem cria nada; "Abrir o projeto existente" adota cortes e decisões e leva o histórico da revisão sem alterar o original nem o vídeo; o corte que passa do fim é sinalizado, não apagado); **fonte que cresceu** (2:00 → 2:20): comparação antes de aplicar, Cancelar não altera o projeto, "Atualizar e abrir" não mexe em nenhum corte |
| 9 | Rede real | só com `BF_NETWORK_TESTS=1` (acima) |
| 10 | Fechamento | nenhum botão visível sem ação em **nenhuma das 9 abas** com a jornada inteira no estado (ajustes avançados abertos); a aba Novo projeto ainda lista só a gravação do OBS (pasta `Cortes` e `.srt` não viram gravações); zero erros **e zero avisos** de console em todas as sessões; a gravação de origem byte a byte igual e o **fluxo de áudio original idêntico** (MD5 do áudio copiado); nenhum `.part`; app encerrado e nenhum processo usando a pasta; a pasta `bf-system-*` removida |

## O que é forçado (e por quê)

- **Corte além do fim da fonte (M6)**: a barra de marcação recusa um fim maior que a duração, então o teste muda o `end` direto no projeto (`BF.project.update`). É o que acontece na vida real quando a fonte é substituída por uma gravação mais curta; o QC, a aba e a fila reagem como reagiriam. O trabalho desse corte é montado pelo próprio `export:prepare` e entregue à fila com `queue:enqueue` para provar que a fila também recusa só ele.
- **Nomes curtos**: os títulos dos cortes são digitados na própria lista (viram "personalizados").
- Tudo mais passa pela interface (cliques e campos) ou pelos mesmos canais que ela usa.

## Limites, o que não é coberto

- Só Windows foi executado (o passo 7 usa `taskkill`); o app usa NVENC se a placa funcionar (a GTX 1650 desta máquina usou), senão software: o teste não depende disso, mas os cortes longos e de "pausar/reordenar" forçam o codificador por software para durarem o bastante.
- A **geração real de legenda** e o **passo 9** só rodam sob as variáveis acima; sem elas o resumo diz **PULADO / NÃO verificado**. O código desses dois trechos segue os seletores já usados por `subtitles.e2e.js` e `sources.e2e.js`, mas só é exercitado quando as variáveis são ligadas.
- Chat de VOD (Twitch/YouTube) não faz parte da jornada de uma gravação do OBS (coberto por `sources.e2e.js` e `integration-analysis-chat`).
- O teste não "ouve" o áudio: o nível é lido do `AnalyserNode` do player e, nos arquivos, com `volumedetect`.
- Os critérios da análise são os provisórios do recurso; o teste usa mídia sintética, então confirma o encadeamento, não a qualidade das sugestões em gameplay real.

## Correções feitas pelo teste de sistema

O teste achou **um defeito de integração** (queue x exportEngine, no fluxo "Substituir") e ele foi corrigido na causa, com teste de regressão em cada ponto:

- **O que acontecia.** O usuário exporta um corte em 1080p e depois exporta o mesmo corte em 1440p H.265, que cai no conflito de nome e escolhe **Substituir**. O arquivo daquele nome passa a ser o H.265, mas (1) a anotação em `cut.exports` seguia dizendo "1080p H.264" (a anotação é idempotente por caminho e descartava o trabalho novo) e (2) o registro de concluídos da fila ainda dizia que o trabalho 1080p estava pronto naquele arquivo: pedir o 1080p de novo era pulado como "Já exportado" (`ALREADY_DONE`), embora o arquivo já não fosse o 1080p. Isso também alimentava o aprendizado de "perfil mais usado" com o perfil errado.
- **Correção.** `src/core/queue/QueueManager.js` (`_settle`): ao concluir, apaga do registro de concluídos as chaves de **outros** trabalhos que apontavam para o mesmo caminho (o arquivo já não é o resultado deles). `renderer/features/queue.js` (`applyDone`): se um trabalho **mais novo** (`finishedAt` maior que o `at` da anotação) gravou o mesmo arquivo, a anotação existente é atualizada no lugar (perfil, intervalo, chave, `jobId`); um trabalho mais antigo ou o mesmo trabalho continua não fazendo nada, o que evita que a reconciliação (que revê todos os concluídos a cada abertura do projeto) fique trocando a anotação de um lado para o outro.
- **Regressão.** `tests/queue-manager.test.js` ("substituir o arquivo por outro trabalho invalida o "já exportado"…") e `tests/queue-renderer.test.js` ("Substituir": o trabalho mais novo… atualiza a anotação…); os dois falham sem a correção (conferido revertendo-a). No teste de sistema o fluxo é exercitado de ponta a ponta (fim de `phase6C`).

## Instabilidades conhecidas e como o teste lida com elas

- **Prévia de áudio (passo 5).** Em cerca de 1 de cada 20 execuções o contexto de áudio do Chromium não aplicou o ganho do "Ajustado" a tempo (o ganho ficou parado em 1,2 ou em 1 enquanto o vídeo tocava). Não houve erro do app, e o contexto de áudio continuava "running". Por isso o teste lê o nível em **amostras** (tempo, ganho, estado do contexto) e, se o ganho não chegar a +6 dB em ~3 s, **refaz a tentativa do começo do corte** (até 4 vezes) e registra no resumo final uma linha `↻ TENTATIVA EXTRA` com as amostras; só falha se as 4 tentativas falharem. O app também é aberto com `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`, para o Chromium não desacelerar a janela quando outra a cobre. Se aparecer `TENTATIVA EXTRA` com frequência, vale investigar o `AudioContext` do player.
- **Entrega da legenda gerada pelo whisper (passo 5, fase 6D).** A entrega (`burn`/`sidecar`/`both`) é do corte e a legenda **nasce com a última entrega escolhida no projeto** (`project.ext.subtitles.mode`, regra da aba Legendas). No passo 5, M3 é posto em "Arquivo separado" antes de o whisper gerar a legenda de S3, então S3 nascia em `sidecar`: saía com o `.srt` ao lado e **sem texto gravado**, e a medição de pixels da fase 6D (que espera o texto no horizontal) achava 0 em todos os quadros (a falha `a legenda gerada deveria aparecer no horizontal (0 pixels)`; o app estava certo, a suposição do teste não). Hoje o teste escolhe "Incorporada ao vídeo" para S3 pela própria aba logo depois de gerar, e a fase 6D confere a entrega e a ausência do `.srt` antes de medir. O mesmo comportamento está fixado, sem Electron, em `tests/subtitles-burnin.test.js` (perfil horizontal, corte longe do início da fonte, fala acentuada).
- As esperas são sempre **por condição** (`waitFor`), com prazos generosos: a mesma jornada levou de 2 min 30 s a 4 min 45 s conforme a carga da máquina.

## Estabilidade medida

Série de 4 execuções completas seguidas, todas passando (160 a 181 s cada), depois das correções acima; antes delas, 3 de 3 também passaram. Durante o desenvolvimento apareceram **duas falhas intermitentes**, ambas de espera do teste e não de defeito do app, a saber:

1. A da prévia de áudio (seção acima), capturada com amostras do ganho e do contexto de áudio.
2. Uma na fase de exportação (`phase6B`), vista uma vez e **não reproduzida** em ~25 execuções seguintes, sem a mensagem completa guardada. A causa provável (não confirmada) era a conferência imediata do selo "personalizado" do corte logo depois de o dado mudar, antes de a tela redesenhar. Esse tipo de conferência e as parecidas (selo da aba Fila, motivo da falha na linha do trabalho, linha "Exportado", selo de alerta das Preferências) agora são **esperas por condição**.

O resultado final de uma série é o que vale: rode `node tests/e2e/system.e2e.js` três vezes seguidas antes de confiar numa mudança que o toque.
