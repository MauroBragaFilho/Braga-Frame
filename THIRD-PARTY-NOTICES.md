# Avisos de software de terceiros

O Braga Frame usa programas e fontes de terceiros. Este arquivo diz **o que vai dentro do instalador**, **o que o app baixa por escolha do usuário** (e de onde) e **o que o usuário instala por conta própria**, com a licença que cada projeto declara. Os textos completos das licenças acompanham o instalador (veja abaixo) ou o próprio programa baixado.

> Este arquivo é um inventário técnico, não parecer jurídico. A licença do Braga Frame em si ainda não foi definida pelo autor: até lá valem todos os direitos reservados (`"license": "UNLICENSED"` no `package.json`). Ver [docs/comercial.md](docs/comercial.md).

## 1. Dentro do instalador (distribuído junto com o app)

| Componente | Licença | Onde ficam os textos |
|---|---|---|
| **Electron** (inclui o Node.js) | MIT | `LICENSE.electron.txt`, na pasta de instalação |
| **Chromium** e as bibliotecas que ele traz (incluindo o FFmpeg interno do Chromium, só para o player da janela) | BSD e outras, uma por biblioteca | `LICENSES.chromium.html`, na pasta de instalação |
| **Inter** (fonte de texto) | SIL Open Font License 1.1 | `licenses\fonts\OFL-Inter.txt` |
| **Montserrat** (fonte de títulos) | SIL Open Font License 1.1 | `licenses\fonts\OFL-Montserrat.txt` |
| **Material Symbols Rounded** (ícones) | Apache License 2.0 | `licenses\fonts\APACHE-MaterialSymbols.txt` |

O app não tem dependências de runtime do npm (`dependencies` do `package.json` está vazio): tudo o que roda é código do projeto mais o Electron. Origem e SHA-256 das fontes: `licenses\fonts\FONTES_ORIGEM.md`.

## 2. Baixado pelo app, só quando o usuário pede (aba Configurações > Ferramentas e legendas)

O app **não redistribui** estes programas: baixa dos lançamentos oficiais de cada projeto, de URL fixa, com tamanho e SHA-256 conferidos (`src/core/tools/entries/`).

| Programa | Para que serve | Licença declarada no projeto | Origem |
|---|---|---|---|
| **yt-dlp** | baixar VODs do YouTube e da Twitch | Unlicense (domínio público) | github.com/yt-dlp/yt-dlp |
| **Deno** | ambiente que o yt-dlp usa para os desafios do YouTube | MIT | github.com/denoland/deno |
| **TwitchDownloaderCLI** | baixar o chat da Twitch | MIT | github.com/lay295/TwitchDownloader |
| **whisper.cpp** | transcrição de fala (legendas e análise por IA) | MIT | github.com/ggml-org/whisper.cpp |
| **whisper.cpp com CUDA** (opcional, placas NVIDIA) | o mesmo, mais rápido | MIT para o whisper.cpp; o pacote traz bibliotecas de execução da **NVIDIA (CUDA)**, sob a licença da NVIDIA | github.com/ggml-org/whisper.cpp |
| **Modelos do Whisper** (formato ggml) | o "cérebro" da transcrição | MIT (OpenAI Whisper) | huggingface.co/ggerganov/whisper.cpp |

## 3. FFmpeg e ffprobe

| Programa | Observação |
|---|---|
| **FFmpeg e ffprobe** | **Não vão no instalador.** O botão **Instalar o FFmpeg** (aba Ferramentas e aviso do topo) baixa, só quando o usuário clica e confirma, a compilação "full shared" **9.0.2 de Gyan Doshi** (a que ffmpeg.org/download.html indica; github.com/GyanD/codexffmpeg), com tamanho e SHA-256 conferidos. É **GPL v3** (`--enable-gpl --enable-version3`, sem `--enable-nonfree`; com x264, x265, libass e NVENC) e o texto da licença vai dentro do pacote baixado. O usuário também pode usar um FFmpeg que ele mesmo instalou (PATH ou `CORTE_FFMPEG`). O app só **executa** o programa, não o inclui no instalador nem o liga ao seu código. O projeto FFmpeg e a compilação são de terceiros: valem as licenças deles. |

## 4. Serviços externos (não são software distribuído)

A análise por IA na nuvem usa o provedor que o usuário configurar (Gemini, Groq, OpenRouter ou outro compatível com a OpenAI), com a chave do próprio usuário e só depois do aviso de privacidade aceito. Valem os termos de uso de cada provedor e de cada modelo escolhido.
