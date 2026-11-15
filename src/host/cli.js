'use strict';

/**
 * Linha de comando do Braga Frame: `BragaFrame.exe "C:\Videos\jogo.mp4"` (ou `npm start -- "C:\Videos\jogo.mp4"`) abre esse
 * vídeo como projeto. É assim que o Braga Digital Studio abre o Braga Frame como app separado.
 *
 * Regras de segurança: o argumento é tratado só como CAMINHO DE ARQUIVO. Nada dele é executado, interpretado por um shell
 * ou aberto sem conferência: precisa ser um caminho completo, de um arquivo que existe, com extensão de vídeo suportada.
 * Tudo o que começa com "-" é opção (as do Chromium/Electron, como --user-data-dir=…, são ignoradas aqui).
 */

const fs = require('node:fs');
const path = require('node:path');
const { VIDEO_EXTENSIONS } = require('../ipc/handlers/project');

const MAX_ARG_LENGTH = 4096;

function problem(code, message) {
  return { ok: false, code, message };
}

/**
 * Confere um caminho vindo da linha de comando. Devolve { ok:true, path } (normalizado) ou { ok:false, code, message }
 * com a mensagem em português (causa + o que fazer).
 * @param {*} candidate
 * @param {{ statSync?: Function }} [deps] só para testes
 */
function validateVideoPath(candidate, deps = {}) {
  const statSync = deps.statSync || fs.statSync;
  if (typeof candidate !== 'string' || !candidate.trim()) return problem('INVALID_PATH', 'Informe o caminho do vídeo.');
  if (candidate.length > MAX_ARG_LENGTH || candidate.includes('\0')) return problem('INVALID_PATH', 'O caminho do vídeo informado é inválido.');
  if (!path.isAbsolute(candidate)) {
    return problem('RELATIVE_PATH', `Informe o caminho completo do vídeo (por exemplo, C:\\Videos\\jogo.mp4). Recebido: "${candidate}".`);
  }
  const full = path.normalize(candidate);
  const extension = path.extname(full).slice(1).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(extension)) {
    return problem('UNSUPPORTED_FORMAT', `Formato não suportado${extension ? ` (.${extension})` : ''}. Use um destes: ${VIDEO_EXTENSIONS.join(', ')}.`);
  }
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return problem('INPUT_MISSING', `O arquivo não foi encontrado: ${full}`);
  }
  if (!stat.isFile()) return problem('NOT_A_FILE', `O caminho informado não é um arquivo: ${full}`);
  return { ok: true, path: full };
}

/**
 * Lê `process.argv` (ou o `argv` de um `second-instance`).
 * @param {string[]} argv lista completa: [executável, (app, se defaultApp), …argumentos]
 * @param {{ defaultApp?: boolean, statSync?: Function }} [opts] defaultApp = `process.defaultApp` (rodando com `electron .`:
 *   o primeiro argumento que não é opção é a pasta do app, não um vídeo)
 * @returns {{ videoPath: string|null, error: {code,message}|null, extra: number, requested: string|null }}
 *   videoPath: caminho validado; error: o que impediu de abrir; extra: quantos argumentos a mais foram ignorados;
 *   requested: o texto pedido (para mensagens)
 */
function parseCli(argv, opts = {}) {
  const defaultApp = opts.defaultApp === undefined ? Boolean(process.defaultApp) : Boolean(opts.defaultApp);
  const result = { videoPath: null, error: null, extra: 0, requested: null };
  if (!Array.isArray(argv)) return result;

  const positional = [];
  let afterDashes = false;
  for (const arg of argv.slice(1)) { // [0] é o executável
    if (typeof arg !== 'string') continue;
    if (!afterDashes && arg === '--') { afterDashes = true; continue; }
    if (!afterDashes && arg.startsWith('-')) continue; // opções do Chromium/Electron e do próprio app
    positional.push(arg);
  }
  if (defaultApp) positional.shift(); // `electron . vídeo`: o primeiro é a pasta do app

  if (!positional.length) return result;
  result.requested = positional[0];
  result.extra = positional.length - 1;
  const checked = validateVideoPath(positional[0], opts);
  if (checked.ok) result.videoPath = checked.path;
  else result.error = { code: checked.code, message: checked.message };
  return result;
}

module.exports = { parseCli, validateVideoPath, VIDEO_EXTENSIONS, MAX_ARG_LENGTH };
