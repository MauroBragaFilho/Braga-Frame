'use strict';

/**
 * Motor de transcrição com aceleração por placa NVIDIA (CUDA): whisper.cpp, release OFICIAL do projeto
 * https://github.com/ggml-org/whisper.cpp (dono: subtitles). É o MESMO pacote que o BDS usa (aceleração NVIDIA).
 *
 * Versão fixada: b5130. Nome, tamanho e SHA-256 conferidos na API oficial de releases do GitHub
 * (GET /repos/ggml-org/whisper.cpp/releases/tags/b5130, campo "digest" de cada arquivo):
 *   whisper-cublas-12.4.0-bin-x64.zip   674539285   af520ddd…   (Windows 64 bits, CUDA 12.4; traz as bibliotecas da NVIDIA)
 * O conteúdo foi conferido pelo índice do zip (lido do fim do arquivo, sem baixar tudo): tudo dentro de "Release/", com
 * whisper-cli.exe, ggml-cuda.dll, cublas/cudart/nvrtc e as DLLs de CPU (por isso o pacote roda sem GPU, com -ng).
 * Só existe para Windows 64 bits: o projeto oficial não publica pacote CUDA para Linux nem macOS.
 *
 * É GRANDE (~675 MB, ~1,8 GB extraído): só é baixado quando o usuário escolhe (aba Legendas, "Motor"). Nunca é baixado
 * sozinho e não é instalado quando o módulo embutido recebe o motor do hospedeiro (BDS).
 * Para atualizar: troque versão, url, size e sha256 JUNTOS e confira com Get-FileHash.
 */

const TAG = 'b5130';
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}`;

module.exports = {
  id: 'whisper-cuda',
  label: 'Whisper para placa NVIDIA (aceleração CUDA)',
  version: TAG,
  source: `oficial: https://github.com/ggml-org/whisper.cpp/releases/tag/${TAG}`,
  assets: {
    'win32-x64': {
      url: `${BASE}/whisper-cublas-12.4.0-bin-x64.zip`,
      name: 'whisper-cublas-12.4.0-bin-x64.zip',
      size: 674539285,
      sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
      stripComponents: 1,
      exe: 'whisper-cli.exe'
    }
  }
};
