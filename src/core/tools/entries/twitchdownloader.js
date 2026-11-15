'use strict';

/**
 * TwitchDownloaderCLI: baixa o chat de VODs da Twitch (dono: sources). Release OFICIAL do projeto
 * https://github.com/lay295/TwitchDownloader (programa único e pronto, sem compilar nada). Só o chat é usado
 * (`chatdownload`); o vídeo do VOD é baixado pelo yt-dlp.
 *
 * Versão fixada: 1.56.5. Tamanho e SHA-256 vêm do campo "digest" de cada arquivo na API oficial de releases do
 * GitHub (GET /repos/lay295/TwitchDownloader/releases/latest; o projeto não publica arquivo de somas) e, para o
 * pacote do Windows, também do hash do arquivo baixado (testado: roda e responde "Invalid VOD" a um VOD que não existe):
 *
 *   TwitchDownloaderCLI-1.56.5-Windows-x64.zip   52226305  8b1b0695…  (testado)
 *   TwitchDownloaderCLI-1.56.5-Linux-x64.zip     46731535  f2bcee00…  (hash e conteúdo do zip conferidos, não executado)
 *   TwitchDownloaderCLI-1.56.5-LinuxArm64.zip    46109413  2fde836f…  (idem)
 *   TwitchDownloaderCLI-1.56.5-MacOS-x64.zip     50052910  efaa61d6…  (idem)
 *   TwitchDownloaderCLI-1.56.5-MacOSArm64.zip    49601971  17a0182f…  (idem)
 * Cada zip traz o programa na raiz (o do Windows também traz COPYRIGHT, licenças e um .pdb que o app ignora).
 *
 * Para atualizar: abra https://github.com/lay295/TwitchDownloader/releases/latest, troque a tag e, para cada arquivo
 * da lista, o tamanho e o SHA-256 mostrados na release (ou `Get-FileHash` do arquivo baixado). Troque os três JUNTOS.
 */

const TAG = '1.56.5';
const BASE = `https://github.com/lay295/TwitchDownloader/releases/download/${TAG}`;

module.exports = {
  id: 'twitchdownloader',
  label: 'TwitchDownloaderCLI (chat de VODs da Twitch)',
  version: TAG,
  source: `oficial: https://github.com/lay295/TwitchDownloader/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/TwitchDownloaderCLI-${TAG}-Windows-x64.zip`,
      name: `TwitchDownloaderCLI-${TAG}-Windows-x64.zip`,
      size: 52226305,
      sha256: '8b1b0695f2b1b6bf0d2535fab4b84032951cded8cf4078dfdf4d58e391c813a0',
      exe: 'TwitchDownloaderCLI.exe'
    },
    'linux-x64': {
      url: `${BASE}/TwitchDownloaderCLI-${TAG}-Linux-x64.zip`,
      name: `TwitchDownloaderCLI-${TAG}-Linux-x64.zip`,
      size: 46731535,
      sha256: 'f2bcee00d0e6da759d97c23767345634cb9cdb10cdff96cfa96f97983d51bf55',
      exe: 'TwitchDownloaderCLI'
    },
    'linux-arm64': {
      url: `${BASE}/TwitchDownloaderCLI-${TAG}-LinuxArm64.zip`,
      name: `TwitchDownloaderCLI-${TAG}-LinuxArm64.zip`,
      size: 46109413,
      sha256: '2fde836f07c3ebfcf61cace23742a2c43543fc30fda96071eb96ab8e10c24f7f',
      exe: 'TwitchDownloaderCLI'
    },
    'darwin-x64': {
      url: `${BASE}/TwitchDownloaderCLI-${TAG}-MacOS-x64.zip`,
      name: `TwitchDownloaderCLI-${TAG}-MacOS-x64.zip`,
      size: 50052910,
      sha256: 'efaa61d6109dfbce4ddedc28da55e23dc1de30caa2f6a35dc611f9b3bb48b724',
      exe: 'TwitchDownloaderCLI'
    },
    'darwin-arm64': {
      url: `${BASE}/TwitchDownloaderCLI-${TAG}-MacOSArm64.zip`,
      name: `TwitchDownloaderCLI-${TAG}-MacOSArm64.zip`,
      size: 49601971,
      sha256: '17a0182f83689a0ae429f48cf03c26f1701eed7edcd787fa3d261898a6023d76',
      exe: 'TwitchDownloaderCLI'
    }
  }
};
