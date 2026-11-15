'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const framing = require('../src/core/export/framing');
const { listBuiltinProfiles } = require('../src/core/export/profiles');
const fx = require('./export-fixtures');

const { buildVideoGraph, resolveFraming, normalizeFraming, defaultFraming, isCustomized, framingUpscale, centerWindow } = framing;
const P916 = { width: 1080, height: 1920 };
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual.toFixed(1)}, esperado ${expected.toFixed(1)} (±${tol})`);

// ---------- regras de resolução (sem ffmpeg) ----------

test('resolveFraming: padrão < perfil < padrão do projeto < corte, sem alterar nenhuma camada', () => {
  const profile = Object.freeze({ width: 1080, height: 1920, framing: Object.freeze({ mode: 'blur', zoom: 1.5 }) });
  const project = Object.freeze({ focusX: 0.2, zoom: 2 });
  const cut = Object.freeze({ id: 'a', framing: Object.freeze({ mode: 'center', focusX: 0.9 }) });
  const snapshot = JSON.stringify([profile, project, cut]);

  assert.deepEqual(resolveFraming({}, null, null), defaultFraming(), 'sem nada: o padrão do app');
  const forProfile = resolveFraming({}, profile, null);
  assert.equal(forProfile.mode, 'blur');
  assert.equal(forProfile.zoom, 1.5);
  const forProject = resolveFraming({}, profile, project);
  assert.equal(forProject.mode, 'blur', 'o padrão do projeto não citou o modo: vale o do perfil');
  assert.equal(forProject.zoom, 2, 'padrão do projeto vence o perfil');
  assert.equal(forProject.focusX, 0.2);
  const forCut = resolveFraming(cut, profile, project);
  assert.equal(forCut.mode, 'center', 'o corte vence');
  assert.equal(forCut.focusX, 0.9);
  assert.equal(forCut.zoom, 2, 'o que o corte não citou vem do projeto');
  assert.equal(JSON.stringify([profile, project, cut]), snapshot, 'nenhuma camada foi modificada');
  assert.equal(forCut.stack.webcamPosition, 'top');
});

test('resolveFraming é idempotente (o Job guarda o enquadramento já resolvido)', () => {
  const profile = { width: 1080, height: 1920 };
  const cut = { framing: { mode: 'stack', stack: { webcamHeightPct: 40 } } };
  const once = resolveFraming(cut, profile, { zoom: 1.4 });
  assert.deepEqual(resolveFraming(cut, profile, once), once);
});

test('normalizeFraming ajusta valores fora da faixa e ignora lixo', () => {
  const f = normalizeFraming({ mode: 'inexistente', focusX: 5, focusY: -2, zoom: 9, blur: { strength: 500 }, stack: { webcamHeightPct: 99, webcamPosition: 'meio', webcamRect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }, custom: { x: 'a' } });
  assert.equal(f.mode, 'center');
  assert.equal(f.focusX, 1);
  assert.equal(f.focusY, 0);
  assert.equal(f.zoom, 3);
  assert.equal(f.blur.strength, 80);
  assert.equal(f.stack.webcamHeightPct, 60);
  assert.equal(f.stack.webcamPosition, 'top');
  assert.ok(f.stack.webcamRect.x + f.stack.webcamRect.w <= 1 + 1e-9 && f.stack.webcamRect.y + f.stack.webcamRect.h <= 1 + 1e-9, 'o retângulo cabe na fonte');
  assert.deepEqual(f.custom, defaultFraming().custom, 'retângulo incompleto volta ao padrão');
  assert.deepEqual(normalizeFraming({ zoom: '1.5' }, { partial: true }), { zoom: 1.5 }, 'parcial guarda só o que veio');
  assert.deepEqual(normalizeFraming(null, { partial: true }), {});
});

test('isCustomized só vale para cortes com ajuste válido', () => {
  assert.equal(isCustomized({ framing: null }), false);
  assert.equal(isCustomized({ framing: {} }), false);
  assert.equal(isCustomized({ framing: { mode: 'blur' } }), true);
  assert.equal(isCustomized(null), false);
});

test('framingUpscale e centerWindow seguem a matemática de cobrir o quadro', () => {
  const src = { width: 1920, height: 1080 };
  near(framingUpscale({ framing: {}, profile: P916, sourceInfo: src }), 1920 / 1080, 1e-9, 'center 1080p: altura manda');
  near(framingUpscale({ framing: { zoom: 2 }, profile: P916, sourceInfo: src }), 2 * 1920 / 1080, 1e-9, 'zoom 2');
  near(framingUpscale({ framing: { mode: 'blur' }, profile: P916, sourceInfo: src }), 1080 / 1920, 1e-9, 'blur: a imagem inteira cabe (não amplia)');
  assert.equal(framingUpscale({ framing: {}, profile: P916, sourceInfo: {} }), null);
  const win = centerWindow({ framing: { focusX: 0, zoom: 1.5 }, profile: P916, sourceInfo: src });
  near(win.w, (1080 / 1920) / (1920 / 1080) / 1.5, 1e-9, 'largura da janela');
  near(win.x, 0, 1e-9, 'focusX 0 = encostada à esquerda');
});

test('o grafo usa o mesmo caminho para qualquer modo e termina em [vout] yuv420p', () => {
  for (const mode of framing.MODES) {
    const g = buildVideoGraph({ framing: { mode }, profile: P916 });
    assert.ok(g.startsWith('[0:v]'), mode);
    assert.ok(g.endsWith('setsar=1,format=yuv420p[vout]'), mode);
  }
  const withPost = buildVideoGraph({ framing: {}, profile: P916, postFilters: ['subtitles=a.ass', ' '] });
  assert.ok(withPost.endsWith('setsar=1,subtitles=a.ass,format=yuv420p[vout]'));
  assert.match(buildVideoGraph({ framing: {}, profile: { ...P916, fps: 30 } }), /^\[0:v\]fps=30\[bf_src\];\[bf_src\]scale/);
});

// ---------- ffmpeg real: dimensões exatas ----------

test('dimensões exatas de saída em todos os perfis embutidos e em perfis livres (todos os modos)', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1280, height: 720, fps: 5, seconds: 2, audio: false });
    const profiles = [
      ...listBuiltinProfiles(),
      { id: 'u1', width: 1080, height: 1350 }, { id: 'u2', width: 1000, height: 1000 }, { id: 'u3', width: 720, height: 1280 },
      { id: 'u4', width: 2, height: 2 }, { id: 'u5', width: 1922, height: 1082 }
    ];
    const seen = new Set();
    for (const profile of profiles) {
      const key = `${profile.width}x${profile.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // os modos mais pesados só em tamanhos menores; center em todos
      const modes = profile.width * profile.height <= 1080 * 1920 ? framing.MODES : ['center'];
      for (const mode of modes) {
        const g = buildVideoGraph({ framing: { mode, zoom: 1.3 }, profile });
        const frame = fx.renderRaw(src, g, profile.width, profile.height);
        assert.equal(frame.data.length, profile.width * profile.height * 3, `${mode} ${key}`);
      }
    }
    assert.ok(seen.size >= 8, `perfis distintos testados: ${seen.size}`);
  } finally { fx.cleanup(dir); }
});

// ---------- ffmpeg real: o conteúdo realmente muda ----------

test('center: focusX, focusY e zoom mudam de verdade o trecho da fonte que aparece', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { audio: false });
    const render = (f) => fx.renderRaw(src, buildVideoGraph({ framing: f, profile: P916 }), 1080, 1920);
    const win = 1080 / 1920 / (1920 / 1080); // fração da largura da fonte visível (0,316)

    const left = render({ focusX: 0 });
    near(fx.avg(left, 4, 960, 0), 255 * 0, 6, 'focusX 0: borda esquerda mostra x=0');
    near(fx.avg(left, 1075, 960, 0), 255 * win, 6, 'focusX 0: borda direita mostra x=0,316');
    const mid = render({ focusX: 0.5 });
    near(fx.avg(mid, 4, 960, 0), 255 * (1 - win) / 2, 6, 'focusX 0,5: borda esquerda');
    const right = render({ focusX: 1 });
    near(fx.avg(right, 4, 960, 0), 255 * (1 - win), 6, 'focusX 1: borda esquerda mostra x=0,684');
    near(fx.avg(right, 1075, 960, 0), 255, 6, 'focusX 1: borda direita mostra x=1');
    assert.ok(fx.avg(right, 4, 960, 0) - fx.avg(left, 4, 960, 0) > 150, 'focusX 0 e 1 mostram partes muito diferentes');

    // zoom 2 cabe metade da largura: a borda direita (focusX 0) cai de 0,316 para 0,158
    const z2 = render({ focusX: 0, zoom: 2 });
    near(fx.avg(z2, 1075, 960, 0), 255 * win / 2, 6, 'zoom 2: borda direita');
    near(fx.avg(z2, 540, 4, 1), 255 * (0.5 - 0.25), 8, 'zoom 2 (focusY 0,5): topo mostra y=0,25');
    near(fx.avg(z2, 540, 1915, 1), 255 * (0.5 + 0.25), 8, 'zoom 2: base mostra y=0,75');
    assert.ok(Math.abs(fx.avg(z2, 1075, 960, 0) - fx.avg(left, 1075, 960, 0)) > 30, 'o zoom muda o conteúdo');

    // focusY (só com zoom há folga vertical em fonte horizontal)
    const top = render({ focusY: 0, zoom: 2 });
    near(fx.avg(top, 540, 4, 1), 0, 6, 'focusY 0: topo mostra y=0');
    const bottom = render({ focusY: 1, zoom: 2 });
    near(fx.avg(bottom, 540, 1915, 1), 255, 6, 'focusY 1: base mostra y=1');

    // a função da interface (centerWindow) concorda com o filtro
    const w = centerWindow({ framing: { focusX: 0.25, zoom: 1.6 }, profile: P916, sourceInfo: { width: 1920, height: 1080 } });
    const f = render({ focusX: 0.25, zoom: 1.6 });
    near(fx.avg(f, 4, 960, 0), 255 * w.x, 6, 'centerWindow: borda esquerda');
    near(fx.avg(f, 1075, 960, 0), 255 * (w.x + w.w), 6, 'centerWindow: borda direita');
  } finally { fx.cleanup(dir); }
});

test('center funciona para perfis horizontais e fontes verticais (focusY escolhe o trecho)', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'vertical.mp4');
    fx.makeCodedSource(src, { width: 720, height: 1280, audio: false });
    const profile = { width: 1920, height: 1080 };
    const top = fx.renderRaw(src, buildVideoGraph({ framing: { focusY: 0 }, profile }), 1920, 1080);
    const bottom = fx.renderRaw(src, buildVideoGraph({ framing: { focusY: 1 }, profile }), 1920, 1080);
    near(fx.avg(top, 960, 4, 1), 0, 6, 'focusY 0: topo mostra y=0');
    near(fx.avg(bottom, 960, 1075, 1), 255, 6, 'focusY 1: base mostra y=1');
    // a fonte inteira em largura: R vai de 0 a 255 de ponta a ponta
    near(fx.avg(top, 4, 540, 0), 0, 6, 'borda esquerda');
    near(fx.avg(top, 1915, 540, 0), 255, 6, 'borda direita');
  } finally { fx.cleanup(dir); }
});

test('blur: fundo desfocado do próprio vídeo e a gameplay inteira por cima', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const coded = path.join(dir, 'codificada.mp4');
    const checker = path.join(dir, 'xadrez.mp4');
    fx.makeCodedSource(coded, { audio: false });
    fx.makeCheckerSource(checker);
    const blurGraph = buildVideoGraph({ framing: { mode: 'blur' }, profile: P916 });
    const centerGraph = buildVideoGraph({ framing: { mode: 'center' }, profile: P916 });

    // gameplay inteira: no miolo (y=960) o R vai de ~0 (esquerda) a ~255 (direita), bem diferente do recorte central
    const whole = fx.renderRaw(coded, blurGraph, 1080, 1920);
    near(fx.avg(whole, 4, 960, 0), 0, 8, 'blur: borda esquerda da gameplay');
    near(fx.avg(whole, 1075, 960, 0), 255, 8, 'blur: borda direita da gameplay');
    // fundo: preenche o quadro com o próprio vídeo (recorte central), então o topo tem G de cima da fonte
    near(fx.avg(whole, 540, 20, 1), 0, 25, 'blur: o fundo do topo vem do alto do vídeo');
    near(fx.avg(whole, 540, 1900, 1), 255, 25, 'blur: o fundo da base vem do rodapé do vídeo');
    const centered = fx.renderRaw(coded, centerGraph, 1080, 1920);
    assert.ok(fx.avg(centered, 4, 960, 0) > 60, 'no modo center a borda esquerda NÃO é x=0');

    // desfoque de verdade: o xadrez some no fundo (desvio padrão baixo) e continua nítido na frente
    const sharp = fx.renderRaw(checker, centerGraph, 1080, 1920);
    const blurred = fx.renderRaw(checker, blurGraph, 1080, 1920);
    const bgSharp = fx.stddev(sharp, 100, 100, 980, 500);
    const bgBlur = fx.stddev(blurred, 100, 100, 980, 500);
    const fg = fx.stddev(blurred, 100, 800, 980, 1100);
    assert.ok(bgSharp > 100, `o xadrez no recorte central é nítido (${bgSharp.toFixed(0)})`);
    assert.ok(bgBlur < bgSharp / 3, `o fundo do blur ficou desfocado (${bgBlur.toFixed(0)} contra ${bgSharp.toFixed(0)})`);
    assert.ok(fg > 80, `a gameplay na frente continua nítida (${fg.toFixed(0)})`);
    // intensidade maior desfoca mais
    const weak = fx.renderRaw(checker, buildVideoGraph({ framing: { mode: 'blur', blur: { strength: 1 } }, profile: P916 }), 1080, 1920);
    assert.ok(fx.stddev(weak, 100, 100, 980, 500) > bgBlur, 'blur fraco mantém mais detalhe que o padrão');

    // zoom no primeiro plano: aproxima e recorta pelas bordas
    const zoomed = fx.renderRaw(coded, buildVideoGraph({ framing: { mode: 'blur', zoom: 2, focusX: 0 }, profile: P916 }), 1080, 1920);
    near(fx.avg(zoomed, 1075, 960, 0), 255 / 2, 8, 'blur com zoom 2: a borda direita mostra metade da imagem');
  } finally { fx.cleanup(dir); }
});

test('stack: webcam e gameplay empilhadas com retângulos configuráveis', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { audio: false });
    const webcamRect = { x: 0, y: 0.6, w: 0.3, h: 0.4 };
    const gameRect = { x: 0.25, y: 0, w: 0.75, h: 1 };
    const base = { mode: 'stack', stack: { webcamRect, gameRect, webcamHeightPct: 30, webcamPosition: 'top' } };
    const camH = 576; // 30% de 1920, par
    const render = (f) => fx.renderRaw(src, buildVideoGraph({ framing: f, profile: P916 }), 1080, 1920);

    const top = render(base);
    const cam = fx.coverWindow(webcamRect, 1920, 1080, 1080, camH);
    const game = fx.coverWindow(gameRect, 1920, 1080, 1080, 1920 - camH);
    // faixa de cima = webcam
    near(fx.avg(top, 4, camH / 2, 0), 255 * cam.x0, 8, 'webcam: borda esquerda');
    near(fx.avg(top, 1075, camH / 2, 0), 255 * cam.x1, 8, 'webcam: borda direita');
    near(fx.avg(top, 540, 4, 1), 255 * cam.y0, 8, 'webcam: topo');
    near(fx.avg(top, 540, camH - 5, 1), 255 * cam.y1, 8, 'webcam: base');
    // faixa de baixo = gameplay
    near(fx.avg(top, 4, camH + 700, 0), 255 * game.x0, 8, 'gameplay: borda esquerda');
    near(fx.avg(top, 1075, camH + 700, 0), 255 * game.x1, 8, 'gameplay: borda direita');
    near(fx.avg(top, 540, camH + 4, 1), 255 * game.y0, 8, 'gameplay: topo');
    near(fx.avg(top, 540, 1915, 1), 255 * game.y1, 8, 'gameplay: base');

    // webcam embaixo: troca a ordem
    const bottom = render({ ...base, stack: { ...base.stack, webcamPosition: 'bottom' } });
    near(fx.avg(bottom, 4, 700, 0), 255 * game.x0, 8, 'webcam embaixo: a gameplay passou para cima');
    near(fx.avg(bottom, 4, 1920 - camH / 2, 0), 255 * cam.x0, 8, 'webcam embaixo: webcam na faixa de baixo');
    near(fx.avg(bottom, 1075, 1920 - camH / 2, 0), 255 * cam.x1, 8, 'webcam embaixo: borda direita da webcam');

    // altura da webcam em %: 50% = 960 px
    const half = render({ ...base, stack: { ...base.stack, webcamHeightPct: 50 } });
    near(fx.avg(half, 4, 955, 0), 255 * fx.coverWindow(webcamRect, 1920, 1080, 1080, 960).x0, 8, 'faixa de 960 px: ainda webcam');
    near(fx.avg(half, 4, 965, 0), 255 * fx.coverWindow(gameRect, 1920, 1080, 1080, 960).x0, 8, 'faixa de 960 px: já gameplay');

    // mudar o retângulo da webcam muda o que aparece na faixa
    const moved = render({ ...base, stack: { ...base.stack, webcamRect: { x: 0.6, y: 0, w: 0.3, h: 0.4 } } });
    assert.ok(fx.avg(moved, 4, camH / 2, 0) > 130, 'webcam vinda de outro canto da fonte');
    assert.ok(fx.avg(moved, 4, camH / 2, 0) - fx.avg(top, 4, camH / 2, 0) > 100);
  } finally { fx.cleanup(dir); }
});

test('custom: retângulo livre da fonte escalado para o quadro', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { audio: false });
    // retângulo com a proporção do quadro 9:16 (em pixels da fonte): w*1920 / (h*1080) = 0,5625
    const rect = { x: 0.6, y: 0.2, w: 0.158203125, h: 0.5 };
    const frame = fx.renderRaw(src, buildVideoGraph({ framing: { mode: 'custom', custom: rect }, profile: P916 }), 1080, 1920);
    near(fx.avg(frame, 4, 960, 0), 255 * rect.x, 8, 'custom: borda esquerda');
    near(fx.avg(frame, 1075, 960, 0), 255 * (rect.x + rect.w), 8, 'custom: borda direita');
    near(fx.avg(frame, 540, 4, 1), 255 * rect.y, 8, 'custom: topo');
    near(fx.avg(frame, 540, 1915, 1), 255 * (rect.y + rect.h), 8, 'custom: base');
    // retângulo sem a proporção do quadro: preenche cortando o excesso no centro (sem esticar)
    const wide = fx.renderRaw(src, buildVideoGraph({ framing: { mode: 'custom', custom: { x: 0, y: 0, w: 1, h: 1 } }, profile: P916 }), 1080, 1920);
    const win = fx.coverWindow({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080, 1080, 1920);
    near(fx.avg(wide, 4, 960, 0), 255 * win.x0, 8, 'custom amplo: cobre sem esticar');
  } finally { fx.cleanup(dir); }
});

test('fps do perfil: o filtro fps é aplicado antes do enquadramento', { skip: fx.skipMedia }, () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 640, height: 360, fps: 10, seconds: 2, audio: false });
    const profile = { width: 360, height: 640, fps: 25 };
    const g = buildVideoGraph({ framing: {}, profile });
    const frame = fx.renderRaw(src, g, 360, 640);
    assert.equal(frame.data.length, 360 * 640 * 3);
  } finally { fx.cleanup(dir); }
});
