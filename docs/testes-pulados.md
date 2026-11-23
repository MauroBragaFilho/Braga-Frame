# Testes pulados e e2e no CI

Esta página lista todo teste que o `npm test` pula, com o motivo e como ligá-lo. Nenhum teste é pulado sem uma condição escrita no próprio teste: quando ela não é atendida, a saída mostra `# SKIP` e o motivo.

Levantamento de 23/11/2026: **26 pulados no CI** (GitHub Actions, `windows-latest`) e **12 na máquina de desenvolvimento**. A diferença são os 14 que dependem do que só existe na máquina de desenvolvimento: voz pt-BR do Windows, yt-dlp no PATH, motor CUDA e Whisper do BDS.

## Testes opcionais: pulados nos dois lugares (12)

Eles só rodam quando alguém pede, porque usam a rede, uma chave paga ou um arquivo pessoal, ou demoram.

| Teste | Quantos | Motivo | Como ligar |
|---|---|---|---|
| Catálogo público do OpenRouter | 1 | rede real | `BF_NETWORK_TESTS=1` |
| OpenRouter com chave de teste | 1 | precisa de chave | `BF_AI_TEST_KEY` |
| Provedor de IA genérico | 1 | precisa de chave e endereço | `BF_AI_TEST_KEY`, `BF_AI_TEST_URL`, `BF_AI_TEST_MODEL` |
| Análise de 20 minutos de vídeo (desempenho) | 1 | demora | `BF_PERF_TESTS=1` ou `npm run test:perf` |
| Transcrição real do dono | 1 | arquivo pessoal, fora do repositório | `BF_TEST_SRT=<arquivo .srt>` |
| FFmpeg: entrada fixada x release do GitHub | 1 | rede real | `BF_NETWORK_TESTS=1` |
| FFmpeg: instalação real pelo ToolInstaller | 1 | baixa cerca de 100 MB | `BF_NETWORK_TESTS=1` e `BF_NETWORK_FFMPEG=1` |
| yt-dlp, TwitchDownloaderCLI e Deno: releases oficiais, instalação e download real | 5 | rede real | `BF_NETWORK_TESTS=1` (Twitch e Deno também `BF_NETWORK_TOOLS_ALL=1`) |

`npm run test:network` roda o grupo de rede de uma vez.

## Testes pulados só no CI (14)

O runner do GitHub não tem estas ferramentas. Na máquina de desenvolvimento eles rodam.

| Teste | Quantos | Falta no runner |
|---|---|---|
| Whisper com fala em português gerada pelo Windows (`tests/subtitles-whisper.test.js`) | 6 | voz pt-BR do System.Speech |
| yt-dlp real: metadados em UTF-8, download, cancelar e retomar, descartar, erro em português, TEMP próprio sem `_MEI` | 6 | yt-dlp no PATH |
| Whisper na placa NVIDIA | 1 | GPU e motor CUDA |
| Transcrição do vídeo com o Whisper do BDS | 1 | motor e modelo do BDS (`BF_WHISPER_DIR`) |

Um desses, o teste do `_MEI` do yt-dlp, **falha** na máquina de desenvolvimento quando o Windows nega a remoção de uma pasta temporária (EPERM). O código não muda o resultado. No CI ele é pulado, então essa falha não aparece lá.

## E2E no CI

O job `e2e` do `.github/workflows/ci.yml` abre o app Electron de verdade, com perfil temporário, vídeos gerados com o FFmpeg e sem rede (`BF_E2E_OFFLINE=1`). Ele cobre a jornada principal:

| Etapa | Arquivo |
|---|---|
| Abrir um vídeo, criar cortes, exportar pela fila e conferir com ffprobe | `app` |
| Analisar e adicionar sugestões sem aprovar nada sozinho | `analysis` |
| Revisar, aprovar, rejeitar, desfazer e reiniciar o app | `review` |
| Legendar sem motor e com a transcrição do vídeo | `subtitles-ui`, `subtitles-transcript` |
| Exportar com áudio, legenda e enquadramento, conferindo o arquivo final | `integration-export` |
| A jornada inteira junta, conferida em disco | `system` |

Quando o job falha, as capturas da janela ficam no artefato `e2e-shots` da execução.

Os outros e2e continuam rodando só na máquina de desenvolvimento (`npm run test:e2e`). Os que precisam de rede, GPU ou Whisper real (`sources`, `subtitles`, `subtitles-gpu`, `transcription`) não teriam o que testar no runner.

## Versões do Node

O job `test` roda lint e testes unitários no Node 22 e no Node 24. O `package.json` declara `"engines": { "node": ">=22" }`. Os jobs `e2e` e `installer` usam o Node 22, porque o app roda no Node embutido no Electron e o Node do sistema só executa os scripts de teste.
