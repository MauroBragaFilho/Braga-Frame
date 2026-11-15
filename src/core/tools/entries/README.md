# Entradas de ferramentas (`entries/<id>.js`)

Cada ferramenta externa oficial tem **um arquivo** aqui, com o nome igual ao `id` (`whisper.js`, `ytdlp.js`, `twitchdownloader.js`…). O `registry.js` carrega todos os `*.js` desta pasta (menos os que começam com `_` ou `.`), valida o formato e entrega ao `ToolInstaller`. Entrada inválida é descartada e não aparece na tela de Ferramentas; o teste `tests/tools-registry.test.js` falha apontando o defeito.

Quem escreve a entrada é o dono do recurso (veja a tabela de propriedade em `docs/arquitetura.md`). Não existe entrada de exemplo no código de propósito: só entra aqui ferramenta real, de **release oficial** do projeto, com versão fixa, tamanho e SHA-256 conferidos.

## Formato

```js
'use strict';

module.exports = {
  id: 'whisper',                       // = nome do arquivo; letras, números, "-" e "_"; começa com letra
  label: 'Whisper (transcrição)',      // nome na interface (pt-BR)
  version: 'b5130',                    // versão fixada; vira a pasta <tools>/<id>/<versão>/
  source: 'oficial: https://github.com/ggml-org/whisper.cpp/releases/tag/b5130', // de onde vem (aparece na interface)
  assets: {
    // "<sistema>-<arquitetura>": win32 | linux | darwin  x  x64 | arm64 | ia32 | arm
    'win32-x64': {
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip', // https, URL fixa
      name: 'whisper-bin-x64.zip',     // nome do arquivo baixado; a extensão define o tipo (veja abaixo)
      size: 8573270,                   // tamanho EXATO em bytes
      sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c', // 64 hex
      exe: 'whisper-cli.exe'           // executável, relativo à pasta instalada, com "/" (ex.: 'bin/tool.exe')
    }
    // sem a chave do sistema atual = "indisponível neste sistema" (a interface mostra o motivo)
  }
};
```

Campos opcionais do pacote:

| Campo | Para quê |
|---|---|
| `kind` | `'zip'`, `'tar.gz'` ou `'file'`. Normalmente é deduzido de `name` (`.zip`, `.tar.gz`/`.tgz`, qualquer outra coisa = arquivo único). |
| `stripComponents` | Inteiro de 0 a 5. Se o pacote traz tudo dentro de uma pasta externa (`tool-1.2/…`), `1` entra nela; `exe` passa a ser relativo à pasta de dentro. A pasta externa precisa conter só essa pasta. |

## Tipos de pacote

- **`.zip` / `.tar.gz` / `.tgz`**: extraído com o `tar` do sistema (no Windows, o `tar.exe` do Windows 10 1803+). O conteúdo vai para `<tools>/<id>/<versão>/`.
- **Arquivo único** (ex.: `yt-dlp.exe`): o próprio arquivo baixado é o executável; `exe` é só o nome final (`'yt-dlp.exe'`, sem pastas).

## Regras

1. **Só release oficial do projeto**: nunca compilar, nunca build de terceiros/espelho. `url` precisa ser `https`.
2. **Fixe tudo**: versão, `size` e `sha256` do arquivo exato que foi testado. Para atualizar, troque os três juntos (o SHA-256 geralmente aparece na página da release ou em um arquivo `SHA2-256SUMS`/`checksums`; confira também baixando e rodando `Get-FileHash`).
3. O pacote **não pode** trazer um `manifest.json` na raiz (é o nome do manifesto da instalação). Se trouxer, use `stripComponents` para ignorar a pasta externa ou fale com o dono de `src/core/tools`.
4. Links simbólicos no pacote só são aceitos se forem relativos e ficarem dentro da pasta extraída; entradas com `..`, caminho absoluto, letra de unidade ou `:` (Windows) fazem a instalação ser recusada (proteção contra zip-slip).
5. Se o projeto oficial **não publica** binário para algum sistema (ex.: macOS), simplesmente não declare a chave desse sistema.
6. O código que usa a ferramenta pega o caminho pelo `ctx.tools` (que já prefere a versão instalada pelo app e cai para `CORTE_*`/PATH), nunca monte o caminho à mão: `registry.resolveInstalled(toolsDir, id)` reconfere manifesto e executável no disco.
7. Só os ids `ytdlp`, `whisper` e `twitchdownloader` alimentam o `ctx.tools` (chaves `ytdlp`, `whisper`, `twitchDownloader`; veja `docs/recursos/tools.md`). Qualquer entrada válida aparece na aba Ferramentas e instala, mas com outro id nenhum módulo recebe o caminho.

## Como validar a entrada

```bash
node --test tests/tools-registry.test.js     # valida todas as entradas desta pasta
node -e "const r=require('./src/core/tools/registry');console.log(r.loadRegistry({strict:true}).entries.length)"
```

Para instalar de verdade (baixa o pacote oficial): use a aba **Ferramentas** do app, ou `new ToolInstaller({ toolsDir }).install('<id>')` num script — veja `docs/recursos/tools.md`. Para testar sem baixar nada da internet, veja "Entradas de teste" no mesmo documento.
