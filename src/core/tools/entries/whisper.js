'use strict';

/**
 * Motor de transcrição das legendas automáticas: whisper.cpp (`whisper-cli`), release OFICIAL do projeto
 * https://github.com/ggml-org/whisper.cpp (dono: subtitles). Só pacotes de CPU, sem compilar nada.
 *
 * Versão fixada: b5130 (a mesma validada no BDS). Tamanho e SHA-256 conferidos na API oficial de releases do
 * GitHub (GET /repos/ggml-org/whisper.cpp/releases, campo "digest" de cada arquivo) e baixando os pacotes:
 *   whisper-bin-x64.zip              8573270  f9ec6c52…  (Windows 64 bits; testado: roda no app)
 *   whisper-bin-win-cpu-arm64.zip    4361895  799543b9…  (Windows ARM; hash e conteúdo conferidos, não executado)
 *   whisper-bin-ubuntu-x64.tar.gz    9793438  53e7fd8b…  (Linux x64; hash e conteúdo conferidos, não executado)
 *   whisper-bin-ubuntu-arm64.tar.gz  4605905  93532a0e…  (Linux ARM; hash e conteúdo conferidos, não executado)
 * macOS: a release só traz um xcframework (biblioteca para apps Xcode), não o whisper-cli: sem pacote.
 * Os pacotes do Windows trazem tudo dentro de "Release/"; os do Linux, dentro de "whisper-bin-ubuntu-<arq>/".
 *
 * Para atualizar: escolha outra tag "bNNNN" em https://github.com/ggml-org/whisper.cpp/releases (as tags "vX.Y.Z"
 * não trazem binários), troque versão, url, size e sha256 JUNTOS e confira com Get-FileHash.
 * Os modelos (.bin) não entram aqui (nem na aba Ferramentas): a revisão, o tamanho e o SHA-256 de cada um ficam fixados
 * no catálogo de src/core/subtitles/models.js e a aba Legendas os instala.
 */

const TAG = 'b5130';
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}`;

module.exports = {
  id: 'whisper',
  label: 'Whisper (legendas automáticas)',
  version: TAG,
  source: `oficial: https://github.com/ggml-org/whisper.cpp/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/whisper-bin-x64.zip`,
      name: 'whisper-bin-x64.zip',
      size: 8573270,
      sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
      stripComponents: 1,
      exe: 'whisper-cli.exe'
    },
    'win32-arm64': {
      url: `${BASE}/whisper-bin-win-cpu-arm64.zip`,
      name: 'whisper-bin-win-cpu-arm64.zip',
      size: 4361895,
      sha256: '799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc',
      stripComponents: 1,
      exe: 'whisper-cli.exe'
    },
    'linux-x64': {
      url: `${BASE}/whisper-bin-ubuntu-x64.tar.gz`,
      name: 'whisper-bin-ubuntu-x64.tar.gz',
      size: 9793438,
      sha256: '53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32',
      stripComponents: 1,
      exe: 'whisper-cli'
    },
    'linux-arm64': {
      url: `${BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
      name: 'whisper-bin-ubuntu-arm64.tar.gz',
      size: 4605905,
      sha256: '93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6',
      stripComponents: 1,
      exe: 'whisper-cli'
    }
  }
};
