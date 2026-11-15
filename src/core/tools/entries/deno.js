'use strict';

/**
 * Deno: ambiente de execução de JavaScript que o yt-dlp usa para resolver os desafios do YouTube (dono: sources).
 * Release OFICIAL do projeto https://github.com/denoland/deno (programa pronto, sem compilar nada).
 *
 * Confirmado na prática (yt-dlp 2026.08.19, vídeo público "Me at the zoo"): sem Deno (ou outro runtime) o yt-dlp
 * avisa "YouTube extraction without a JS runtime has been deprecated, and some formats may be missing" e, em
 * alguns clientes do YouTube, falha com "n challenge solving failed ... No video formats found!". Com o Deno
 * encontrado o aviso some. Por isso é RECOMENDADO para o YouTube; a Twitch não precisa dele. Não é obrigatório
 * para o app abrir: sem ele, a aba Novo projeto (sources) mostra o aviso e segue tentando.
 * O id "deno" não alimenta o `ctx.tools` (só ytdlp, whisper e twitchdownloader alimentam): o módulo sources
 * acha o programa instalado com registry.resolveInstalled(paths.tools, 'deno') e o entrega ao yt-dlp com
 * `--js-runtimes deno:<caminho>`.
 *
 * Versão fixada: v2.9.7. Tamanho e SHA-256: arquivo oficial "<pacote>.zip.sha256sum" da própria release, igual ao
 * campo "digest" da API de releases do GitHub e ao hash do arquivo baixado (Windows x64, testado).
 *
 *   deno-x86_64-pc-windows-msvc.zip         42630221  a0c3101b…  (testado: yt-dlp lista "JS runtimes: deno")
 *   deno-aarch64-pc-windows-msvc.zip        40847024  c4c4ac8b…  (hash e conteúdo do zip conferidos, não executado)
 *   deno-x86_64-unknown-linux-gnu.zip       41596794  c6527f24…  (idem)
 *   deno-aarch64-unknown-linux-gnu.zip      39821318  c832298b…  (idem)
 *   deno-x86_64-apple-darwin.zip            42295422  95daaff1…  (idem)
 *   deno-aarch64-apple-darwin.zip           38469316  5cd46d62…  (idem)
 * Cada zip traz só o programa (deno.exe / deno) na raiz.
 *
 * Para atualizar: https://github.com/denoland/deno/releases/latest, troque a tag e, de cada "<pacote>.zip.sha256sum",
 * o SHA-256; o tamanho está na lista de arquivos da release. Troque versão, url, size e sha256 JUNTOS.
 */

const TAG = 'v2.9.7';
const BASE = `https://github.com/denoland/deno/releases/download/${TAG}`;

module.exports = {
  id: 'deno',
  label: 'Deno (recomendado para o YouTube)',
  version: TAG.replace(/^v/, ''),
  source: `oficial: https://github.com/denoland/deno/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/deno-x86_64-pc-windows-msvc.zip`,
      name: 'deno-x86_64-pc-windows-msvc.zip',
      size: 42630221,
      sha256: 'a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238',
      exe: 'deno.exe'
    },
    'win32-arm64': {
      url: `${BASE}/deno-aarch64-pc-windows-msvc.zip`,
      name: 'deno-aarch64-pc-windows-msvc.zip',
      size: 40847024,
      sha256: 'c4c4ac8bfdaa37814bda5c05fc9cdf2154904e2ef8277673a30bdceaaa649807',
      exe: 'deno.exe'
    },
    'linux-x64': {
      url: `${BASE}/deno-x86_64-unknown-linux-gnu.zip`,
      name: 'deno-x86_64-unknown-linux-gnu.zip',
      size: 41596794,
      sha256: 'c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490',
      exe: 'deno'
    },
    'linux-arm64': {
      url: `${BASE}/deno-aarch64-unknown-linux-gnu.zip`,
      name: 'deno-aarch64-unknown-linux-gnu.zip',
      size: 39821318,
      sha256: 'c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf',
      exe: 'deno'
    },
    'darwin-x64': {
      url: `${BASE}/deno-x86_64-apple-darwin.zip`,
      name: 'deno-x86_64-apple-darwin.zip',
      size: 42295422,
      sha256: '95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a',
      exe: 'deno'
    },
    'darwin-arm64': {
      url: `${BASE}/deno-aarch64-apple-darwin.zip`,
      name: 'deno-aarch64-apple-darwin.zip',
      size: 38469316,
      sha256: '5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c',
      exe: 'deno'
    }
  }
};
