'use strict';

/**
 * yt-dlp: baixa VODs do YouTube e da Twitch e consulta metadados e chat de replay (dono: sources).
 * Release OFICIAL do projeto https://github.com/yt-dlp/yt-dlp (programa único e pronto, sem compilar nada).
 *
 * Versão fixada: 2026.08.19. Tamanho e SHA-256 vêm do arquivo oficial SHA2-256SUMS da própria release e foram
 * conferidos três vezes: SHA2-256SUMS, campo "digest" da API de releases do GitHub e o hash do arquivo baixado
 * (yt-dlp.exe: 17840399 bytes, 66674953fe25…, testado: roda e baixa).
 *
 *   yt-dlp.exe             17840399  66674953…  Windows 64 bits (testado)
 *   yt-dlp_arm64.exe       21159286  05b43899…  Windows ARM (hash conferido, não executado)
 *   yt-dlp_x86.exe         13199160  a8f91bd4…  Windows 32 bits (hash conferido, não executado)
 *   yt-dlp_linux           40446224  58162f9b…  Linux x64 (hash conferido, não executado)
 *   yt-dlp_linux_aarch64   40167448  b16e4dab…  Linux ARM 64 (hash conferido, não executado)
 *   yt-dlp_macos           37146048  0f192b7e…  macOS (universal; hash conferido, não executado)
 *
 * Para atualizar: abra https://github.com/yt-dlp/yt-dlp/releases/latest, copie a tag (ex.: 2026.09.01) e, do arquivo
 * "SHA2-256SUMS" da release, o SHA-256 de cada arquivo acima; o tamanho exato está na lista de arquivos da release
 * (ou em `Get-Item <arquivo>`). Troque versão, url, size e sha256 JUNTOS e confira com Get-FileHash depois de baixar.
 * O app nunca usa a atualização interna do yt-dlp (-U): a versão é a fixada aqui.
 */

const TAG = '2026.08.19';
const BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}`;

module.exports = {
  id: 'ytdlp',
  label: 'yt-dlp (VODs do YouTube e da Twitch)',
  version: TAG,
  source: `oficial: https://github.com/yt-dlp/yt-dlp/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/yt-dlp.exe`,
      name: 'yt-dlp.exe',
      size: 17840399,
      sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
      exe: 'yt-dlp.exe'
    },
    'win32-arm64': {
      url: `${BASE}/yt-dlp_arm64.exe`,
      name: 'yt-dlp_arm64.exe',
      size: 21159286,
      sha256: '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0',
      exe: 'yt-dlp.exe'
    },
    'win32-ia32': {
      url: `${BASE}/yt-dlp_x86.exe`,
      name: 'yt-dlp_x86.exe',
      size: 13199160,
      sha256: 'a8f91bd41452506bc81ebd2f369b186fea0ee7075413ba00cef9fd346a0a5d0c',
      exe: 'yt-dlp.exe'
    },
    'linux-x64': {
      url: `${BASE}/yt-dlp_linux`,
      name: 'yt-dlp_linux',
      size: 40446224,
      sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
      exe: 'yt-dlp'
    },
    'linux-arm64': {
      url: `${BASE}/yt-dlp_linux_aarch64`,
      name: 'yt-dlp_linux_aarch64',
      size: 40167448,
      sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc',
      exe: 'yt-dlp'
    },
    'darwin-x64': {
      url: `${BASE}/yt-dlp_macos`,
      name: 'yt-dlp_macos',
      size: 37146048,
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
      exe: 'yt-dlp'
    },
    'darwin-arm64': {
      url: `${BASE}/yt-dlp_macos`,
      name: 'yt-dlp_macos',
      size: 37146048,
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
      exe: 'yt-dlp'
    }
  }
};
