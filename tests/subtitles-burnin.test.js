'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const B = require('../src/core/subtitles/burnIn');
const F = require('../src/core/subtitles/formats');

const skip = H.tools.ffmpeg && H.tools.ffprobe ? false : 'ffmpeg/ffprobe não encontrados';
const support = B.detectBurnInSupport(H.tools.ffmpeg);
const skipBurn = skip || (support.supported ? false : `este ffmpeg não tem libass: ${support.reason}`);

const cue = (start, end, text, extra = {}) => ({ start, end, text, ...extra });
function cutWith(subs, over = {}) {
  const cut = { id: 'c1', title: 'Corte de teste', start: 10, end: 14, revision: 1, ...over };
  cut.subtitles = subs === null ? null : { enabled: true, basedOn: { start: cut.start, end: cut.end, revision: cut.revision }, cues: [cue(1, 2.5, 'Teste de legenda')], style: {}, mode: 'burn', ...subs };
  return cut;
}

// ---------- decisões (sem ffmpeg) ----------

test('prepareBurnIn devolve null quando não há legenda a aplicar', () => {
  const dir = H.tmpDir();
  try {
    const opts = { tmpDir: dir, width: 1080, height: 1920, support };
    assert.equal(B.prepareBurnIn(cutWith(null), opts), null, 'sem legendas');
    assert.equal(B.prepareBurnIn({ id: 'x', start: 0, end: 4 }, opts), null, 'corte sem o campo');
    assert.equal(B.prepareBurnIn(cutWith({ enabled: false }), opts), null, 'desligada');
    assert.equal(B.prepareBurnIn(cutWith({ cues: [] }), opts), null, 'sem falas');
    assert.equal(B.prepareBurnIn(cutWith({ cues: [cue(1, 2, '   ')] }), opts), null, 'só falas vazias');
    assert.equal(B.prepareBurnIn(cutWith({ cues: [cue(20, 22, 'fora do corte de 4 s')] }), opts), null, 'só falas fora do corte');
    assert.deepEqual(fs.readdirSync(dir), [], 'nada foi gravado');
  } finally { H.cleanup(dir); }
});

test('prepareBurnIn recusa tamanho e pasta inválidos, com mensagem clara', () => {
  const dir = H.tmpDir();
  try {
    assert.throws(() => B.prepareBurnIn(cutWith({}), { tmpDir: dir, width: 0, height: 1920, support }), (e) => e.code === 'INVALID_SIZE' && /tamanho/i.test(e.message));
    assert.throws(() => B.prepareBurnIn(cutWith({}), { tmpDir: dir, support }), (e) => e.code === 'INVALID_SIZE');
    assert.throws(() => B.prepareBurnIn(cutWith({}), { width: 1080, height: 1920, support }), (e) => e.code === 'NO_TMPDIR');
  } finally { H.cleanup(dir); }
});

test('entrega incorporada sem libass: erro com a causa e a solução; arquivo separado continua valendo', () => {
  const dir = H.tmpDir();
  try {
    const noLibass = { supported: false, reason: B.UNSUPPORTED_REASON, ffmpeg: 'x' };
    for (const mode of ['burn', 'both']) {
      assert.throws(() => B.prepareBurnIn(cutWith({ mode }), { tmpDir: dir, width: 1080, height: 1920, support: noLibass }),
        (e) => e.code === 'BURNIN_UNSUPPORTED' && /libass/.test(e.message) && /arquivo separado/i.test(e.message), mode);
    }
    const sidecarOnly = B.prepareBurnIn(cutWith({ mode: 'sidecar' }), { tmpDir: dir, width: 1080, height: 1920, support: noLibass });
    assert.equal(sidecarOnly.vfFilter, null);
    assert.equal(sidecarOnly.sidecars.length, 1);
  } finally { H.cleanup(dir); }
});

test('só arquivo separado: SRT com tempos relativos ao corte e sem filtro de vídeo', () => {
  const dir = H.tmpDir();
  try {
    const cut = cutWith({ mode: 'sidecar', cues: [cue(0.5, 2, 'Olá pessoal bem-vindos ao nosso canal'), cue(2.5, 3.9, 'Fim')], style: { maxCharsPerLine: 22 } });
    const r = B.prepareBurnIn(cut, { tmpDir: dir, width: 1080, height: 1920, support });
    assert.equal(r.vfFilter, null);
    assert.equal(r.sidecars.length, 1);
    assert.equal(r.sidecars[0].ext, 'srt');
    assert.ok(fs.existsSync(r.sidecars[0].path));
    assert.equal(path.dirname(r.sidecars[0].path), dir);
    const text = fs.readFileSync(r.sidecars[0].path, 'utf8');
    assert.equal(text, '1\n00:00:00,500 --> 00:00:02,000\nOlá pessoal bem-vindos\nao nosso canal\n\n2\n00:00:02,500 --> 00:00:03,900\nFim\n');
    assert.deepEqual(r.warnings, []);
  } finally { H.cleanup(dir); }
});

test('incorporada e arquivo ASS: o ASS do arquivo leva a aparência e o tamanho do quadro', () => {
  const dir = H.tmpDir();
  try {
    const cut = cutWith({ mode: 'both', sidecarFormat: 'ass', style: { position: 'top', color: '#FFCC00', fontSize: 80 } });
    const r = B.prepareBurnIn(cut, { tmpDir: dir, width: 1440, height: 2560, support });
    assert.match(r.vfFilter, /^subtitles=filename=/);
    assert.equal(r.sidecars[0].ext, 'ass');
    const ass = fs.readFileSync(r.sidecars[0].path, 'utf8');
    assert.match(ass, /PlayResX: 1440\r\nPlayResY: 2560/);
    const style = ass.split('\r\n').find((l) => l.startsWith('Style: Default,')).split(',');
    assert.equal(style[2], String(Math.round(80 * 1440 / 1080)), 'fonte proporcional à resolução');
    assert.equal(style[3], '&H0000CCFF', 'cor do texto (amarelo)');
    assert.equal(style[18], '8', 'superior');
    // o ASS da incorporação é gravado em tmpDir também
    assert.ok(fs.readdirSync(dir).some((f) => /\.ass$/.test(f)));
    assert.ok(r.sidecars.every((s) => fs.existsSync(s.path)));
  } finally { H.cleanup(dir); }
});

test('intervalo do corte desatualizado: o export acompanha o intervalo atual (deslocamento e recorte)', () => {
  const dir = H.tmpDir();
  try {
    // as falas foram feitas para o corte 10–14; hoje o corte é 12–16 (começa 2 s depois)
    const cut = cutWith({ mode: 'sidecar', basedOn: { start: 10, end: 14, revision: 1 }, cues: [cue(0.2, 1.2, 'saiu'), cue(1.5, 3, 'metade'), cue(3, 3.9, 'dentro')] }, { start: 12, end: 16, revision: 2 });
    const r = B.prepareBurnIn(cut, { tmpDir: dir, width: 1080, height: 1920, support });
    const cues = F.parseSrt(fs.readFileSync(r.sidecars[0].path, 'utf8'));
    assert.deepEqual(cues.map((c) => [c.text, c.start, c.end]), [['metade', 0, 1], ['dentro', 1, 1.9]]);
    assert.ok(r.warnings.some((w) => /fora do corte/.test(w)), 'avisa da fala que ficou fora');
    assert.ok(r.warnings.some((w) => /revisão/.test(w)), 'avisa da fala que ficou para revisão');
  } finally { H.cleanup(dir); }
});

test('avisos: falas para revisar são avisos, não bloqueiam', () => {
  const dir = H.tmpDir();
  try {
    const cut = cutWith({ mode: 'sidecar', cues: [cue(1, 2, 'a', { needsReview: true }), cue(2, 3, 'b', { needsReview: true }), cue(3, 3.5, 'c')] });
    const r = B.prepareBurnIn(cut, { tmpDir: dir, width: 1080, height: 1920, support });
    assert.equal(r.sidecars.length, 1, 'a legenda sai mesmo assim');
    assert.deepEqual(r.warnings, ['2 fala(s) da legenda ainda estão marcadas para revisão.']);
    assert.deepEqual(B.subtitleWarnings(cut), r.warnings);
    assert.deepEqual(B.subtitleWarnings(cutWith({ enabled: false })), []);
    assert.deepEqual(B.subtitleWarnings(cutWith(null)), []);
  } finally { H.cleanup(dir); }
});

test('aviso de fonte que não existe neste computador (não bloqueia)', () => {
  const cut = cutWith({ mode: 'sidecar', style: { fontFamily: 'Impact' } });
  assert.deepEqual(B.subtitleWarnings(cut, { fonts: [{ name: 'Impact', available: false }, { name: 'Arial', available: true }] }),
    ['A fonte "Impact" não foi encontrada neste computador; o FFmpeg vai usar outra no lugar.']);
  assert.deepEqual(B.subtitleWarnings(cut, { fonts: [{ name: 'Impact', available: true }] }), []);
  assert.deepEqual(B.subtitleWarnings(cutWith({ style: { fontFamily: 'Minha Fonte Própria' } }), { fonts: [{ name: 'Arial', available: true }] }), [], 'fonte fora da lista: não dá para saber, não avisa');
});

test('escapeFilterValue: dois níveis de escape para o filtro do ffmpeg', () => {
  assert.equal(B.escapeFilterValue('C:\\Users\\x\\a.ass'), 'C\\\\:/Users/x/a.ass');
  assert.equal(B.escapeFilterValue('/tmp/a b/c.ass'), '/tmp/a b/c.ass');
  assert.equal(B.escapeFilterValue("it's"), "it\\\\\\'s");
  assert.equal(B.escapeFilterValue('a,b;c[d]e'), 'a\\,b\\;c\\[d\\]e');
  assert.equal(B.subtitlesFilter('C:\\t\\x.ass', { fontsDir: null }), 'subtitles=filename=C\\\\:/t/x.ass');
  assert.equal(B.subtitlesFilter('C:\\t\\x.ass', { fontsDir: 'C:\\Windows\\Fonts' }), 'subtitles=filename=C\\\\:/t/x.ass:fontsdir=C\\\\:/Windows/Fonts');
});

test('detectBurnInSupport: este ffmpeg e um executável que não existe', { skip }, () => {
  assert.equal(typeof support.supported, 'boolean');
  if (support.supported) assert.equal(support.reason, null);
  const dir = H.tmpDir();
  try {
    const missing = B.detectBurnInSupport(path.join(dir, 'nao-existe.exe'));
    assert.equal(missing.supported, false);
    assert.match(missing.reason, /FFmpeg/);
  } finally { H.cleanup(dir); }
});

// ---------- ffmpeg de verdade ----------

/** Grafo igual ao do exportEngine (src/core/export/framing.js): o filtro entra depois do enquadramento. */
const graphWith = (vf) => `[0:v]setsar=1${vf ? `,${vf}` : ''},format=yuv420p[vout]`;
function render(src, out, vf) {
  H.ffmpeg(['-i', src, '-filter_complex', graphWith(vf), '-map', '[vout]', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-an', out]);
}

const SIZES = [{ w: 1080, h: 1920 }, { w: 1440, h: 2560 }];
const boxes = {};

for (const { w, h } of SIZES) {
  for (const position of ['bottom', 'center', 'top']) {
    test(`legenda queimada de verdade ${w}x${h}, posição ${position}: só aparece na hora certa, na região certa`, { skip: skipBurn }, () => {
      const dir = H.tmpDir();
      try {
        const base = path.join(dir, 'base.mp4');
        H.ffmpeg(['-f', 'lavfi', '-i', `color=c=0x202830:s=${w}x${h}:r=10:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
        const cut = cutWith({ style: { position } });
        const work = path.join(dir, 'job');
        const r = B.prepareBurnIn(cut, { tmpDir: work, width: w, height: h });
        assert.ok(r.vfFilter, 'filtro de vídeo');
        const plain = path.join(dir, 'plain.mp4');
        const burned = path.join(dir, 'burned.mp4');
        render(base, plain, null);
        render(base, burned, r.vfFilter);

        const frame = (file, t) => H.grayFrame(file, t, { width: w, height: h });
        assert.equal(H.diffBox(frame(plain, 0.5), frame(burned, 0.5), w, h), null, 'antes da fala: quadro igual ao sem legenda');
        assert.equal(H.diffBox(frame(plain, 2.8), frame(burned, 2.8), w, h), null, 'depois da fala: quadro igual ao sem legenda');
        const box = H.diffBox(frame(plain, 1.7), frame(burned, 1.7), w, h);
        assert.ok(box, 'durante a fala: o quadro tem texto');
        boxes[`${w}x${h}-${position}`] = box;

        // horizontal: centralizado e dentro do quadro
        assert.ok(box.x0 > w * 0.1 && box.x1 < w * 0.9, `texto dentro do quadro (x ${box.x0}..${box.x1} de ${w})`);
        assert.ok(Math.abs((box.x0 + box.x1) / 2 - w / 2) < w * 0.02, 'texto centralizado');
        // vertical: a região pedida
        if (position === 'bottom') assert.ok(box.y0 > h * 0.7 && box.y1 < h * 0.9, `inferior: y ${box.y0}..${box.y1} de ${h}`);
        if (position === 'top') assert.ok(box.y0 > h * 0.04 && box.y1 < h * 0.2, `superior: y ${box.y0}..${box.y1} de ${h}`);
        if (position === 'center') assert.ok(Math.abs((box.y0 + box.y1) / 2 - h / 2) < h * 0.03, `centro: y ${box.y0}..${box.y1} de ${h}`);
      } finally { H.cleanup(dir); }
    });
  }
}

test('o tamanho do texto acompanha a resolução: 1440x2560 tem 1,33x o texto de 1080x1920', { skip: skipBurn }, () => {
  for (const position of ['bottom', 'center', 'top']) {
    const a = boxes[`1080x1920-${position}`];
    const b = boxes[`1440x2560-${position}`];
    assert.ok(a && b, 'os testes de quadro rodaram antes');
    const ratioH = b.h / a.h;
    const ratioW = b.w / a.w;
    assert.ok(ratioH > 1.22 && ratioH < 1.45, `altura do texto ${position}: x${ratioH.toFixed(2)}`);
    assert.ok(ratioW > 1.22 && ratioW < 1.45, `largura do texto ${position}: x${ratioW.toFixed(2)}`);
  }
});

test('aparência de verdade: cor do texto, caixa de fundo e fonte mudam o quadro', { skip: skipBurn }, () => {
  const dir = H.tmpDir();
  try {
    const w = 1080; const h = 1920;
    const base = path.join(dir, 'base.mp4');
    H.ffmpeg(['-f', 'lavfi', '-i', `color=c=0x202830:s=${w}x${h}:r=10:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
    const rgbFrame = (file, x, y) => {
      const data = H.ffmpeg(['-ss', '1.7', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      const i = (y * w + x) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const burnWith = (style, name) => {
      const out = path.join(dir, `${name}.mp4`);
      const r = B.prepareBurnIn(cutWith({ style }), { tmpDir: path.join(dir, name), width: w, height: h });
      render(base, out, r.vfFilter);
      return out;
    };
    const plain = path.join(dir, 'plain.mp4');
    render(base, plain, null);

    // caixa de fundo: o pixel logo ao lado do texto fica da cor da caixa (vermelha), não do fundo do vídeo
    const box = burnWith({ background: 'box', backgroundColor: '#FF0000', backgroundOpacity: 1, outlineWidth: 0 }, 'box');
    const bb = H.diffBox(H.grayFrame(plain, 1.7), H.grayFrame(box, 1.7), w, h);
    assert.ok(bb);
    const inside = rgbFrame(box, bb.x0 + 4, Math.round((bb.y0 + bb.y1) / 2));
    assert.ok(inside[0] > 200 && inside[1] < 60 && inside[2] < 60, `pixel da caixa deveria ser vermelho: ${inside}`);
    const noBox = burnWith({ background: 'none', outlineWidth: 0 }, 'nobox');
    const nb = H.diffBox(H.grayFrame(plain, 1.7), H.grayFrame(noBox, 1.7), w, h);
    assert.ok(nb.count < bb.count / 2, 'sem caixa o texto muda bem menos pixels');

    // cor do texto: o centro de uma letra grossa fica na cor pedida
    const yellow = burnWith({ color: '#FFFF00', outlineColor: '#000000', background: 'none', fontSize: 140, bold: true }, 'yellow');
    const frame = H.ffmpeg(['-ss', '1.7', '-i', yellow, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    let yellowPixels = 0;
    for (let i = 0; i < frame.length; i += 3) if (frame[i] > 220 && frame[i + 1] > 220 && frame[i + 2] < 90) yellowPixels++;
    assert.ok(yellowPixels > 500, `pixels amarelos do texto: ${yellowPixels}`);

    // fonte: Impact e Arial dão formas diferentes (se as duas existirem)
    const fonts = require('../src/core/subtitles/fonts').listFonts();
    if (fonts.find((f) => f.name === 'Impact').available && fonts.find((f) => f.name === 'Arial').available) {
      const impact = burnWith({ fontFamily: 'Impact', bold: false }, 'impact');
      const arial = burnWith({ fontFamily: 'Arial', bold: false }, 'arial');
      const d = H.diffBox(H.grayFrame(impact, 1.7), H.grayFrame(arial, 1.7), w, h);
      assert.ok(d && d.count > 2000, 'a fonte escolhida é a usada de verdade (Impact diferente de Arial)');
    }
  } finally { H.cleanup(dir); }
});

test('caminhos difíceis do Windows na pasta temporária (espaço, vírgula, aspas, colchetes, acentos, #, %, &)', { skip: skipBurn }, () => {
  const root = H.tmpDir();
  try {
    const w = 640; const h = 360;
    const base = path.join(root, 'base.mp4');
    H.ffmpeg(['-f', 'lavfi', '-i', `color=c=0x202830:s=${w}x${h}:r=10:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
    const plain = path.join(root, 'plain.mp4');
    render(base, plain, null);
    const names = ['simples', 'com espaço', "vírgula, e 'aspas' [colch];x", 'Usuário João (teste) #1 & 50% =x', 'a`b~c@d!e$f^g+h'];
    for (const name of names) {
      const tmpDir = path.join(root, name);
      const r = B.prepareBurnIn(cutWith({ style: { fontSize: 40 } }), { tmpDir, width: w, height: h });
      const out = path.join(root, `out-${names.indexOf(name)}.mp4`);
      render(base, out, r.vfFilter);
      const box = H.diffBox(H.grayFrame(plain, 1.7), H.grayFrame(out, 1.7), w, h);
      assert.ok(box && box.count > 300, `a legenda apareceu com a pasta "${name}"`);
    }
  } finally { H.cleanup(root); }
});

test('integração com o jobRunner do exportEngine: legenda queimada e arquivo separado ao lado do vídeo', { skip: skipBurn, timeout: 180000 }, async (t) => {
  let runner;
  let profiles;
  try {
    runner = require('../src/core/export/jobRunner');
    profiles = require('../src/core/export/profiles');
  } catch (err) {
    t.skip(`o jobRunner do exportEngine não está disponível ainda (${err.message})`);
    return;
  }
  const dir = H.tmpDir();
  try {
    const src = path.join(dir, 'origem.mp4');
    H.makeVideo(src, [{ tone: 6 }], { size: '640x360', still: true });
    const profile = { ...profiles.listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264'), encoder: 'software' };
    const cut = { id: 'c1', title: 'Integração', start: 1, end: 5, revision: 1, status: 'approved', category: '', audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, framing: null, exports: [], notes: '',
      subtitles: { enabled: true, mode: 'both', sidecarFormat: 'srt', basedOn: { start: 1, end: 5, revision: 1 }, cues: [cue(1, 3, 'Legenda do job real')], style: { position: 'center' } } };
    const job = { id: 'j1', projectId: 'p1', projectTitle: 'x', sourcePath: src, sourceInfo: { width: 640, height: 360, fps: 10, duration: 6, hasAudio: true }, cut, profile, framing: null, outputDir: path.join(dir, 'saida'), baseName: 'corte', onConflict: 'rename', createdAt: new Date().toISOString() };
    const res = await runner.runExportJob(job, { tools: { ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe }, tmpDir: path.join(dir, 'tmp') });
    assert.ok(fs.existsSync(res.output), 'vídeo exportado');
    const sidecar = res.output.replace(/\.mp4$/, '.srt');
    assert.ok(fs.existsSync(sidecar), 'arquivo .srt ao lado do vídeo');
    assert.deepEqual(F.parseSrt(fs.readFileSync(sidecar, 'utf8')), [cue(1, 3, 'Legenda do job real')]);
    assert.ok(!res.warnings.some((w) => /legenda/i.test(w.message) && /dispon/i.test(w.message)), 'sem aviso de módulo indisponível');

    // quadro com legenda x quadro sem legenda do MESMO vídeo exportado: o texto está no centro (posição pedida), de 1 s a 3 s
    const w = 1080; const h = 1920;
    const during = H.grayFrame(res.output, 1.5, { width: w, height: h });
    const before = H.grayFrame(res.output, 0.3, { width: w, height: h });
    const after = H.grayFrame(res.output, 3.5, { width: w, height: h });
    assert.equal(H.diffBox(before, after, w, h, 40), null, 'antes e depois da fala o quadro é o mesmo');
    const box = H.diffBox(before, during, w, h, 40);
    assert.ok(box, 'durante a fala há texto no vídeo exportado');
    assert.ok(Math.abs((box.y0 + box.y1) / 2 - h / 2) < h * 0.06, `texto no centro: y ${box.y0}..${box.y1}`);
  } finally { H.cleanup(dir); }
});

/**
 * Regressão do teste de sistema (phase6D): a legenda gerada pelo whisper de um corte (aqui 91-106 s de uma fonte longa, falas
 * acentuadas perto do fim do corte, como o `tiny` devolve) exportada pelo perfil HORIZONTAL 1920x1080 do jobRunner real.
 * Quem decide se o texto vai gravado no vídeo é a ENTREGA do corte (`mode`): com `burn` o texto está no quadro na hora da fala,
 * embaixo; com `sidecar` (a entrega que o projeto herda de um corte anterior) o vídeo sai SEM texto e o .srt vem ao lado.
 * O teste de sistema media pixels num corte cuja legenda tinha nascido em `sidecar` e achava 0.
 */
test('perfil horizontal 1920x1080, corte longe do início da fonte e fala acentuada: a entrega decide se o texto vai no vídeo', { skip: skipBurn, timeout: 240000 }, async (t) => {
  let runner;
  let profiles;
  let qc;
  try {
    runner = require('../src/core/export/jobRunner');
    profiles = require('../src/core/export/profiles');
    qc = require('../src/core/export/qc');
  } catch (err) {
    t.skip(`o exportEngine não está disponível (${err.message})`);
    return;
  }
  const dir = H.tmpDir();
  try {
    const src = path.join(dir, 'origem.mp4');
    H.makeVideo(src, [{ tone: 108 }], { size: '640x360', still: true });
    const profile = { ...profiles.listBuiltinProfiles().find((p) => p.id === 'horizontal-1080-h264'), encoder: 'software' };
    const tools = { ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe };
    const cues = [cue(7.92, 10.08, 'Esse foi um lance incrível,', { needsReview: true }), cue(10.225, 11.82, 'vamos ver de novo.')];
    const jobWith = (id, mode) => ({
      id, projectId: 'p1', projectTitle: 'x', sourcePath: src, sourceInfo: { width: 640, height: 360, fps: 10, duration: 108, hasAudio: true }, profile, framing: null,
      outputDir: path.join(dir, 'saida'), baseName: `corte-${id}`, onConflict: 'rename', createdAt: new Date().toISOString(),
      cut: { id: 'c1', title: 'Sugestão 1:31', start: 91, end: 106, revision: 1, status: 'pending', category: '', audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, framing: null, exports: [], notes: '',
        subtitles: { enabled: true, mode, sidecarFormat: 'srt', basedOn: { start: 91, end: 106, revision: 1 }, cues, style: {},
          generated: { at: '2026-10-21T00:00:00.000Z', language: 'pt', model: 'tiny', modelLabel: 'Tiny', start: 91, end: 106, noSpeech: false } } }
    });
    const w = 1920; const h = 1080;
    const mid = (cues[0].start + cues[0].end) / 2;
    const exportMode = async (mode) => {
      const job = jobWith(mode, mode);
      assert.deepEqual(qc.preflight(job, { tools }).errors, [], `${mode}: o QC não bloqueia`);
      const res = await runner.runExportJob(job, { tools, tmpDir: path.join(dir, `tmp-${mode}`) });
      assert.ok(fs.existsSync(res.output), `${mode}: vídeo exportado`);
      // grayFrame confere o tamanho do quadro decodificado: a saída tem mesmo 1920x1080
      const before = H.grayFrame(res.output, 0.3, { width: w, height: h });
      const during = H.grayFrame(res.output, mid, { width: w, height: h });
      const sidecar = res.output.replace(/\.mp4$/, '.srt');
      return { res, box: H.diffBox(before, during, w, h, 40), sidecar };
    };

    const burn = await exportMode('burn');
    assert.ok(burn.box && burn.box.count > 300, `entrega incorporada: o texto da fala (${mid.toFixed(1)} s do corte) está no quadro horizontal (${burn.box && burn.box.count} pixels)`);
    assert.ok(burn.box.y0 > h * 0.6 && burn.box.y1 < h * 0.97, `na parte de baixo do quadro: y ${burn.box.y0}..${burn.box.y1} de ${h}`);
    assert.ok(Math.abs((burn.box.x0 + burn.box.x1) / 2 - w / 2) < w * 0.02, 'texto centralizado');
    assert.ok(!fs.existsSync(burn.sidecar), 'incorporada: sem arquivo .srt ao lado');

    const side = await exportMode('sidecar');
    assert.equal(side.box, null, 'arquivo separado: o vídeo sai SEM texto gravado (por isso um teste que mede pixels precisa da entrega incorporada)');
    assert.ok(fs.existsSync(side.sidecar), 'arquivo separado: o .srt vem ao lado do vídeo');
    // o .srt quebra as linhas pelo máximo de caracteres do estilo (22): o texto é o mesmo
    assert.deepEqual(F.parseSrt(fs.readFileSync(side.sidecar, 'utf8')).map((c) => c.text.replace(/\n/g, ' ')), ['Esse foi um lance incrível,', 'vamos ver de novo.']);
  } finally { H.cleanup(dir); }
});

// ---------- legenda ligada, mas sem nenhuma fala para mostrar ----------

test('subtitleWarnings: legenda ligada sem nenhuma fala visível avisa que o vídeo sai sem legenda (não bloqueia)', () => {
  const empty = (subs, over) => B.subtitleWarnings(cutWith(subs, over), { fonts: [] });
  assert.deepEqual(empty({ cues: [] }), [B.EMPTY_WARNING], 'lista vazia');
  assert.deepEqual(empty({ cues: [cue(1, 2, '   ')] }), [B.EMPTY_WARNING], 'só falas vazias');
  const outside = empty({ cues: [cue(20, 22, 'fora do corte de 4 s')] });
  assert.equal(outside[0], B.EMPTY_WARNING, 'tudo fora do corte: sem legenda no vídeo');
  assert.ok(outside.some((w) => /fora do corte e não entram/.test(w)), 'e continua dizendo quantas ficaram fora');
  assert.match(B.EMPTY_WARNING, /ligada, mas nenhuma fala aparece neste corte.*sai sem legenda/);
  for (const mode of ['burn', 'sidecar', 'both']) assert.deepEqual(empty({ mode, cues: [] }), [B.EMPTY_WARNING], mode);
  // com ao menos uma fala visível, nada disso
  assert.deepEqual(empty({ cues: [cue(1, 2, 'oi')] }), []);
  // desligada ou sem o campo: nada a avisar
  assert.deepEqual(empty({ enabled: false, cues: [] }), []);
  assert.deepEqual(B.subtitleWarnings(cutWith(null)), []);
  // o corte mudou depois de gerar: a fala que já não aparece conta como "sem falas"
  assert.ok(empty({ basedOn: { start: 10, end: 14, revision: 1 }, cues: [cue(0.2, 1.2, 'saiu')] }, { start: 12, end: 16, revision: 2 }).includes(B.EMPTY_WARNING));
  // prepareBurnIn segue devolvendo null (o jobRunner é quem repassa o aviso)
  const dir = H.tmpDir();
  try { assert.equal(B.prepareBurnIn(cutWith({ cues: [] }), { tmpDir: dir, width: 1080, height: 1920, support }), null); } finally { H.cleanup(dir); }
});

test('jobRunner e QC reais: legenda ligada sem falas exporta o vídeo e AVISA (SUBTITLES_WARNING), sem bloquear', { skip: skipBurn, timeout: 180000 }, async (t) => {
  let runner;
  let profiles;
  let qc;
  try {
    runner = require('../src/core/export/jobRunner');
    profiles = require('../src/core/export/profiles');
    qc = require('../src/core/export/qc');
  } catch (err) {
    t.skip(`o exportEngine não está disponível (${err.message})`);
    return;
  }
  const dir = H.tmpDir();
  try {
    const src = path.join(dir, 'origem.mp4');
    H.makeVideo(src, [{ tone: 6 }], { size: '640x360', still: true });
    const profile = { ...profiles.listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264'), encoder: 'software' };
    const tools = { ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe };
    const jobWith = (id, subtitles) => ({
      id, projectId: 'p1', projectTitle: 'x', sourcePath: src, sourceInfo: { width: 640, height: 360, fps: 10, duration: 6, hasAudio: true }, profile, framing: null,
      outputDir: path.join(dir, 'saida'), baseName: `corte-${id}`, onConflict: 'rename', createdAt: new Date().toISOString(),
      cut: { id: 'c1', title: 'Sem falas', start: 1, end: 5, revision: 1, status: 'approved', category: '', audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, framing: null, exports: [], notes: '', subtitles }
    });
    for (const mode of ['burn', 'sidecar']) {
      const subs = { enabled: true, mode, sidecarFormat: 'srt', basedOn: { start: 1, end: 5, revision: 1 }, cues: [], style: {} };
      const job = jobWith(`vazio-${mode}`, subs);
      const pre = qc.preflight(job, { tools });
      assert.deepEqual(pre.errors, [], `${mode}: avisar não é bloquear`);
      assert.ok(pre.warnings.some((w) => w.code === 'SUBTITLES_WARNING' && w.message === B.EMPTY_WARNING), `${mode}: o QC avisa antes de enfileirar (${JSON.stringify(pre.warnings.map((w) => w.code))})`);
      const res = await runner.runExportJob(job, { tools, tmpDir: path.join(dir, 'tmp') });
      assert.ok(fs.existsSync(res.output), `${mode}: o vídeo foi exportado`);
      assert.ok(!fs.existsSync(res.output.replace(/\.mp4$/, '.srt')), `${mode}: sem falas não há arquivo de legenda`);
      assert.ok(res.warnings.some((w) => w.code === 'SUBTITLES_WARNING' && w.message === B.EMPTY_WARNING), `${mode}: o resultado do job leva o aviso (a fila mostra) (${JSON.stringify(res.warnings)})`);
    }
    // com fala visível o aviso não aparece
    const ok = await runner.runExportJob(jobWith('com-fala', { enabled: true, mode: 'sidecar', sidecarFormat: 'srt', basedOn: { start: 1, end: 5, revision: 1 }, cues: [cue(1, 2, 'oi')], style: {} }), { tools, tmpDir: path.join(dir, 'tmp') });
    assert.ok(!ok.warnings.some((w) => w.message === B.EMPTY_WARNING));
    // legenda desligada: nenhum aviso de legenda
    const off = await runner.runExportJob(jobWith('desligada', { enabled: false, mode: 'burn', cues: [], style: {} }), { tools, tmpDir: path.join(dir, 'tmp') });
    assert.ok(!off.warnings.some((w) => w.code === 'SUBTITLES_WARNING'));
  } finally { H.cleanup(dir); }
});
