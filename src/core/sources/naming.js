'use strict';

/**
 * Nomes de arquivo e pastas dos downloads (dono: sources): nome seguro no Windows, nome ÚNICO (nunca sobrescreve
 * o que já existe) e consulta de espaço livre.
 */

const fs = require('node:fs');
const path = require('node:path');

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// marcas invisíveis (largura zero, controle de direção do texto, BOM) que atrapalham nomes de arquivo
const INVISIBLE = new RegExp('[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]', 'g');
const MAX_PATH_BUDGET = 240; // o Windows clássico limita o caminho completo a 260 caracteres

/**
 * Nome-base do arquivo de um VOD: só o título da transmissão (o código do vídeo, como o id do YouTube, NÃO vai no nome: o vínculo
 * com a origem fica guardado no projeto e no registro de downloads; dois vídeos de mesmo título viram "título (2)" pelo moveUnique,
 * nunca um sobrescreve o outro). Troca caracteres proibidos, evita nomes reservados do Windows, tira pontos/espaços do fim e
 * encurta o título para o caminho completo caber.
 * @param {{ title:string, dir:string, ext?:string }} o
 */
function vodFileBase({ title, dir, ext = '.mp4' }) {
  const room = Math.max(24, MAX_PATH_BUDGET - String(dir).length - 1 - ext.length - 6); // 6 = " (999)"
  let t = String(title || '')
    .normalize('NFC')
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > room) t = Array.from(t).slice(0, room).join('').trim();
  t = t.replace(/[. ]+$/g, '');
  if (!t) t = 'video';
  if (RESERVED.test(t)) t = `_${t}`;
  return t;
}

const BUSY_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repete `op` enquanto o arquivo estiver "ocupado" (antivírus, indexador e OneDrive seguram arquivos recém-gravados por instantes). */
async function retryBusy(op, { tries = 5, delayMs = 200 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await op(); } catch (err) {
      if (attempt >= tries || !BUSY_CODES.includes(err.code)) throw err;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * Move `src` para `dir/<base><ext>` sem NUNCA sobrescrever: se o nome existir, usa "base (2)", "base (3)"…
 * Usa um link físico (falha se o destino existe) e, onde o sistema de arquivos não suporta (FAT/exFAT), confere
 * a existência e renomeia. Devolve o caminho final.
 *
 * Depois que o link existe o arquivo FINAL já está em `dest`: apagar o original é só arrumação. Se o original estiver
 * preso por outro programa (EBUSY), repete algumas vezes e, se persistir, devolve `dest` mesmo assim (quem chamou
 * apaga a pasta de trabalho depois). Nunca falha nem avança para "(2)" quando o arquivo final já foi criado.
 */
async function moveUnique(src, dir, base, ext) {
  await fs.promises.mkdir(dir, { recursive: true });
  for (let i = 1; i <= 9999; i += 1) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
    const dest = path.join(dir, name);
    try {
      await fs.promises.link(src, dest);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK', 'ENOSYS', 'EISDIR', 'UNKNOWN', 'EOPNOTSUPP'].includes(err.code)) {
        let taken = true;
        try { await fs.promises.access(dest); } catch { taken = false; }
        if (taken) continue;
        await retryBusy(() => fs.promises.rename(src, dest));
        return dest;
      }
      throw err;
    }
    // o link existe: o original e o arquivo final são o mesmo conteúdo
    try { await retryBusy(() => fs.promises.unlink(src)); } catch { /* preso por outro programa: a pasta de trabalho é apagada depois */ }
    return dest;
  }
  const err = new Error('Não foi possível achar um nome livre para o arquivo.');
  err.code = 'NO_FREE_NAME';
  throw err;
}

/** Bytes livres na unidade da pasta (usa a primeira pasta existente acima dela); null se não der para saber. */
async function freeBytes(dir) {
  let probe = path.resolve(dir);
  for (let i = 0; i < 64; i += 1) {
    try {
      const st = await fs.promises.statfs(probe);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return null;
}

/** Tamanho somado dos arquivos de uma pasta (não recursivo) cujo nome casa com `filter`; 0 se não existir. */
function sumFiles(dir, filter = () => true) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !filter(entry.name)) continue;
      try { total += fs.statSync(path.join(dir, entry.name)).size; } catch { /* sumiu */ }
    }
  } catch { return 0; }
  return total;
}

module.exports = { vodFileBase, moveUnique, retryBusy, freeBytes, sumFiles, RESERVED };
