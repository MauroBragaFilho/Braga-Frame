# Proxy de visualização (cópia leve para o player)

Dono: base (`src/core/proxy/ProxyManager.js`, `src/ipc/handlers/proxy.js`, `renderer/features/proxy.js`). **Estado: implementado e testado, inclusive no app Electron de verdade (`tests/e2e/proxy.e2e.js`).**

## Para que serve

O player do app é o do Chromium. Ele não toca tudo o que o FFmpeg lê: MPEG-4 parte 2 (.avi), HEVC quando a máquina não tem decodificador, alguns MKV/TS do OBS (erro no player) e **áudio AC-3/E-AC-3/DTS/TrueHD** (o vídeo toca **mudo, sem erro**). Antes, o app só avisava "não toca no player"; dava para cortar e exportar, mas sem ver nada.

Agora o app cria uma **cópia leve** só para o player: H.264 (`libx264 veryfast`, CRF 28), até 720p na menor medida (1280x720 em paisagem, 720x1280 em retrato), quadro-chave a cada 30 quadros (avançar e voltar são rápidos), AAC estéreo 96 kb/s alinhado ao vídeo, `+faststart`. A cópia tem **a mesma duração e os mesmos tempos** do original (testado: diferença abaixo de 0,15 s), então um instante do player é o mesmo instante do vídeo.

**O que NÃO muda**: o projeto continua apontando para o arquivo original (`project.source.path`, `BF.state.url`); os cortes, a análise (áudio, imagem, transcrição) e a **exportação sempre usam o original**. A cópia é só do player (`<video>`).

## Quando é criada

1. **Ao abrir o vídeo**, se o ffprobe diz que o Chromium não toca (`renderer/features/proxy.js`, `needed`): áudio em `ac3`, `eac3`, `dts`, `truehd`, `mlp`, `dca`; ou vídeo `hevc`/`h265` quando `video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')` volta vazio.
2. **Pelo erro do player** (`BF.player.onUnplayable`, chamado pelo `app.js` no evento `error` do `<video>`): qualquer outro formato que falhe.

O app diz o que está fazendo (aviso, e a barra de estado mostra "Criando a cópia leve do vídeo para o player… 42% · cerca de 2 min restantes"). Quando fica pronta, o player troca para ela **na mesma posição** (volta a tocar se estava tocando) e avisa que a exportação usa o original. Se a criação falha (sem FFmpeg, disco cheio, codificador ausente), o aviso traz a causa **junto** da mensagem de sempre ("o corte e a exportação não dependem do player") e o app não tenta de novo para aquele vídeo. Um erro da própria cópia cai na mensagem de sempre.

## Cache e limites

- Pasta: `<cache>/proxy/<chave>.mp4`, onde a chave é a da análise (tamanho + 3 trechos do arquivo): copiar ou renomear o vídeo reaproveita a cópia; reabrir o mesmo vídeo não roda o ffmpeg de novo.
- A cópia é gravada como `.part` e **renomeada só no fim**: nunca existe cópia pela metade. Cancelar (outro vídeo aberto, ou fechar o app) mata o ffmpeg e apaga o `.part`.
- **Uma cópia por vez**; abrir outro vídeo cancela a anterior.
- A pasta é limitada a **8 GB**: ao terminar uma cópia, as mais antigas (pela data de uso; reabrir atualiza) saem até caber; a que acabou de ficar pronta nunca sai.
- O ffmpeg roda com prioridade abaixo do normal.

## Canais (IPC)

`proxy:ensure { path }` -> `{ state:'ready'|'running', proxyPath, url, p?, etaSec? }` (caminho completo de um vídeo existente de extensão suportada); `proxy:status { path }` -> `{ state:'none'|'ready'|'running', … }`; `proxy:cancel` -> `{ cancelled }`. Eventos: `proxy:progress { path, p, etaSec }`, `proxy:done { path, proxyPath, url }`, `proxy:failed { path, code, message }`, `proxy:cancelled { path }`. Códigos: `INVALID_PATH`, `UNSUPPORTED_FORMAT`, `INPUT_MISSING`, `NO_FFMPEG`, `NO_DISK_SPACE`, `CODEC_UNSUPPORTED`, `PROXY_FAILED`, `FFMPEG_START_FAILED`.

## Limites conhecidos

- **HDR** (`smpte2084`, `arib-std-b67`): a cópia sai sem mapeamento de tons, então as cores ficam lavadas no player. A exportação não é afetada.
- Um vídeo muito longo (uma live de horas) leva minutos para ficar pronto (o `libx264 veryfast` em 720p costuma andar bem acima do tempo real, mas **não foi medido numa live de 3 h**); o player só troca quando a cópia termina (não toca a parte já pronta).
- Só a **primeira faixa de áudio** vai para a cópia (a mesma que a exportação usa).
- Vídeo com tempo inicial diferente de zero no contêiner (`start_time`) não foi testado: a conversão de quadro constante pode deslocar o início em alguns centésimos.
- A decisão por codec usa o ffprobe do momento de abrir (`BF.state.info`); formatos que o ffprobe lê mas o ffmpeg não codifica falham com `PROXY_FAILED` e a causa.

## Testes

```bash
node --test tests/proxy-manager.test.js tests/proxy-ipc.test.js tests/proxy-renderer.test.js
npm run test:e2e -- proxy      # abre o app: .avi MPEG-4 (erro do player), .mkv com AC-3 (já ao abrir), .mp4 comum (nada), reabrir (cache)
```
