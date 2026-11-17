'use strict';

/**
 * FFmpeg e FFprobe (dono: base). O projeto FFmpeg NÃO publica programas prontos (só código-fonte); o instalador de Windows que a própria
 * página https://ffmpeg.org/download.html indica é a compilação do Gyan Doshi, publicada nas releases do GitHub dele
 * (https://github.com/GyanD/codexffmpeg), que é a que esta entrada usa. Por isso a origem aqui NÃO é "oficial": é uma compilação de terceiros.
 *
 * Versão fixada: 9.0.2, pacote "full_build-shared" (a "full" tem o que o Braga Frame usa: libx264, libx265, libass para legendas e NVENC;
 * a "shared" é a de menor download: ffmpeg.exe e ffprobe.exe pequenos com as DLLs ao lado, na mesma pasta bin/).
 *   ffmpeg-9.0.2-full_build-shared.zip   99899672   8d31e162…
 * Tamanho e SHA-256 vêm do campo "digest" da API de releases do GitHub (GET /repos/GyanD/codexffmpeg/releases/latest) e conferem com o
 * arquivo baixado. O conteúdo foi conferido: uma pasta de topo (ffmpeg-9.0.2-full_build-shared/) com bin/ffmpeg.exe, bin/ffprobe.exe, as
 * DLLs, LICENSE (GPL v3), doc/, include/ e lib/. A configuração gravada nas DLLs tem --enable-gpl --enable-version3 e NÃO tem --enable-nonfree;
 * traz libx264, libx265, libass, ffnvcodec e nvenc. NÃO foi executado aqui: só lido como dados (hash, índice do zip e a configuração).
 *
 * É GPL v3 e NÃO vai dentro do instalador do Braga Frame: só é baixado quando o usuário clica em "Instalar" (o app não redistribui nada).
 * ~100 MB de download, ~260 MB instalado. Só existe para Windows 64 bits; nos outros sistemas a aba Ferramentas explica como instalar à mão.
 * Para atualizar: troque versão, url, size e sha256 JUNTOS (o "digest" da release) e confira com Get-FileHash depois de baixar.
 */

const TAG = '9.0.2';
const BASE = `https://github.com/GyanD/codexffmpeg/releases/download/${TAG}`;

module.exports = {
  id: 'ffmpeg',
  label: 'FFmpeg (ler, converter e gravar vídeo)',
  version: TAG,
  source: `compilação de terceiros (Gyan Doshi, a indicada em ffmpeg.org/download.html): https://github.com/GyanD/codexffmpeg/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/ffmpeg-${TAG}-full_build-shared.zip`,
      name: `ffmpeg-${TAG}-full_build-shared.zip`,
      size: 99899672,
      sha256: '8d31e162f1616e37aab3fa2db991b97e1b8dbeb1c8465fd81a81be16ff91b328',
      stripComponents: 1,
      exe: 'bin/ffmpeg.exe',
      alsoExe: { ffprobe: 'bin/ffprobe.exe' } // o ffprobe vem do mesmo pacote: alimenta ctx.tools.ffprobe
    }
  }
};
