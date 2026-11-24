'use strict';

/**
 * Canal do recurso "Exportar para o editor de vídeo" (src/core/export/timeline.js):
 *
 *   timeline:export { cuts, source:{ path, duration? }, dir, name?, status?, formats? }
 *       -> { dir, files:[nome…], summary:{ clips, seconds, fps, cues }, warnings:[…] }
 *
 * Grava na pasta `dir` (escolhida pela pessoa, `export:pickDir`) o XML (Final Cut 7: Premiere e Resolve), o EDL, a lista de tempos e as
 * legendas alinhadas (.srt, .ass e o estilo em .json). Nada é sobrescrito: se algum nome já existe, o conjunto inteiro ganha " (2)", " (3)"…
 * O vídeo original não é lido nem alterado (só o ffprobe mede quadros por segundo, tamanho e áudio).
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildExport } = require('../../core/export/timeline');
const { probeMedia } = require('../../core/ffmpeg/probe');

const MAX_CUTS = 2000;
const FORMATS = ['xml', 'edl', 'times', 'subs'];

/** Nome de arquivo seguro (sem os caracteres que o Windows não aceita), com um limite de tamanho. */
function safeName(text) {
  // eslint-disable-next-line no-control-regex
  const clean =String(text || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (clean || 'Braga Frame').slice(0, 80);
}

/** O primeiro "nome", "nome (2)"… para o qual NENHUM arquivo do conjunto existe ainda. */
function freeBase(dir, base, names) {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    if (names.every((suffix) => !fs.existsSync(path.join(dir, `${candidate}${suffix}`)))) return candidate;
  }
  throw Object.assign(new Error('Não achei um nome livre nessa pasta. Escolha outra pasta.'), { code: 'EXPORT_NAME' });
}

function register(ctx) {
  const probe = (ctx.timelineOptions && ctx.timelineOptions.probe) || probeMedia;

  ctx.handle('timeline:export', async (payload) => {
    const p = payload || {};
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (!Array.isArray(p.cuts) || !p.cuts.length) throw fail('INVALID_ARGS', 'Não há cortes para exportar.');
    if (p.cuts.length > MAX_CUTS) throw fail('INVALID_ARGS', `Cortes demais (${p.cuts.length}); o limite é ${MAX_CUTS}.`);
    const src = p.source || {};
    if (typeof src.path !== 'string' || !src.path) throw fail('INVALID_ARGS', 'Informe o vídeo do projeto.');
    if (typeof p.dir !== 'string' || !path.isAbsolute(p.dir)) throw fail('INVALID_ARGS', 'Escolha a pasta de destino.');
    let stat;
    try { stat = fs.statSync(p.dir); } catch { throw fail('INPUT_MISSING', 'A pasta de destino não existe mais. Escolha outra.'); }
    if (!stat.isDirectory()) throw fail('INPUT_MISSING', 'O destino escolhido não é uma pasta.');

    // quadros por segundo, tamanho e áudio vêm do arquivo (ffprobe); sem ele valem os dados da tela e o editor é avisado
    const source = { path: src.path, duration: Number(src.duration) || 0, fps: Number(src.fps) || 0, width: Number(src.width) || 0, height: Number(src.height) || 0, hasAudio: src.hasAudio !== false };
    try {
      if (ctx.tools && ctx.tools.ffprobe && fs.existsSync(src.path)) {
        const info = await probe(ctx.tools.ffprobe, src.path);
        if (info.fps > 0) source.fps = info.fps;
        if (info.width > 0) source.width = info.width;
        if (info.height > 0) source.height = info.height;
        if (info.duration > 0) source.duration = info.duration;
        source.hasAudio = info.hasAudio;
      }
    } catch { /* os dados da tela valem */ }

    const formats = (Array.isArray(p.formats) ? p.formats : FORMATS).filter((f) => FORMATS.includes(f));
    if (!formats.length) throw fail('INVALID_ARGS', 'Escolha ao menos um formato.');
    const base = safeName(p.name);
    const make = (name) => buildExport({ cuts: p.cuts, source, status: p.status === 'all' ? 'all' : 'approved', formats, name });
    let out = make(base);
    if (!out.files.length) throw fail('NO_CUTS', out.warnings[out.warnings.length - 1] || 'Nada para exportar.');
    const chosen = freeBase(p.dir, base, out.files.map((f) => f.name.slice(base.length)));
    if (chosen !== base) out = make(chosen); // o título da timeline (no XML, no EDL e nas legendas) também ganha o " (2)"
    const written = [];
    try {
      for (const f of out.files) {
        fs.writeFileSync(path.join(p.dir, f.name), f.content, { encoding: 'utf8', flag: 'wx' });
        written.push(f.name);
      }
    } catch (err) {
      for (const name of written) { try { fs.rmSync(path.join(p.dir, name), { force: true }); } catch { /* sem o que limpar */ } }
      throw fail(err.code === 'EEXIST' ? 'EXPORT_NAME' : 'WRITE_FAILED', `Não foi possível gravar os arquivos na pasta escolhida (${err.message}). Escolha outra pasta ou confira as permissões.`);
    }
    ctx.log('info', `timeline: ${written.length} arquivo(s) para o editor em ${p.dir}`);
    return { dir: p.dir, files: written, summary: out.summary, warnings: out.warnings };
  });
}

module.exports = { register, safeName, freeBase };
