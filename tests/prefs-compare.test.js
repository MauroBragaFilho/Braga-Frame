'use strict';

/** Comparação de fonte atualizada (src/core/projects/compare.js): VOD que cresceu, arquivo regravado/recodificado. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSource, describeComparison, SIZE_TOLERANCE } = require('../src/core/projects/compare');
const { fmtDuration, fmtBytes } = require('../src/core/preferences/format');

const GB = 1024 ** 3;
const cut = (id, start, end, extra = {}) => ({ id, title: `Corte ${id}`, start, end, status: 'pending', ...extra });
const project = (over = {}) => ({
  source: { path: 'D:\\Lives\\live.mp4', size: 4 * GB, duration: 7200, width: 1920, height: 1080 },
  cuts: [cut('a', 100, 130), cut('b', 3000, 3040), cut('c', 7100, 7190)],
  ...over
});

test('formatadores em português', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(125.4), '2:05');
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(fmtDuration(NaN), '—');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1,5 KB');
  assert.equal(fmtBytes(3.1 * GB), '3,1 GB');
  assert.equal(fmtBytes(-1), '—');
});

test('arquivo igual (ou só ruído de metadados) não é mudança', () => {
  const p = project();
  assert.equal(compareSource(p, { ...p.source }).changed, false);
  const noise = { ...p.source, duration: 7200.3, size: p.source.size * (1 + SIZE_TOLERANCE / 4) };
  const r = compareSource(p, noise);
  assert.equal(r.changed, false);
  assert.equal(r.direction, 'same');
});

test('VOD que cresceu: mostra duração, tamanho, trecho novo e que nada é apagado', () => {
  const p = project();
  const r = compareSource(p, { size: 5 * GB, duration: 9000, width: 1920, height: 1080 });
  assert.equal(r.changed, true);
  assert.equal(r.direction, 'longer');
  assert.equal(r.duration.delta, 1800);
  assert.equal(r.cuts.outside.length, 0);
  const text = r.lines.join('\n');
  assert.match(text, /O vídeo ficou mais longo: 2:00:00 → 2:30:00 \(\+30:00\)/);
  assert.match(text, /Tamanho: 4,0 GB → 5,0 GB/);
  assert.match(text, /Os 3 cortes continuam dentro do vídeo/);
  assert.match(text, /O trecho novo \(de 2:00:00 em diante\) ainda não foi analisado/);
  assert.match(text, /decisões, títulos e ajustes manuais continuam como estão/);
});

test('arquivo mais curto: cortes fora do novo intervalo são SINALIZADOS (fora/parcial), nunca alterados', () => {
  const p = project();
  const snapshot = JSON.stringify(p);
  const r = compareSource(p, { size: 2 * GB, duration: 7150, width: 1920, height: 1080 });
  assert.equal(r.direction, 'shorter');
  assert.deepEqual(r.cuts.outside.map((c) => [c.id, c.kind]), [['c', 'parcial']]);
  const r2 = compareSource(p, { size: 1 * GB, duration: 3020, width: 1920, height: 1080 });
  assert.deepEqual(r2.cuts.outside.map((c) => [c.id, c.kind]), [['b', 'parcial'], ['c', 'fora']]);
  const text = r2.lines.join('\n');
  assert.match(text, /O vídeo ficou mais curto: 2:00:00 → 50:20 \(−1:09:40\)/);
  assert.match(text, /2 cortes ficam fora do novo intervalo \(“Corte b”, “Corte c”\)\. Eles serão mantidos e sinalizados; nada é apagado\./);
  assert.equal(JSON.stringify(p), snapshot, 'o projeto não é tocado pela comparação');
});

test('um corte só: texto no singular; muitos: lista resumida com reticências', () => {
  const one = compareSource(project(), { size: 2 * GB, duration: 7150 }).lines.join('\n');
  assert.match(one, /1 corte fica fora do novo intervalo \(“Corte c”\)\. Ele será mantido e sinalizado; nada é apagado\./);
  const many = project({ cuts: [1, 2, 3, 4, 5].map((i) => cut(`m${i}`, 6000 + i * 10, 6020 + i * 10)) });
  const text = compareSource(many, { size: 1 * GB, duration: 100 }).lines.join('\n');
  assert.match(text, /5 cortes ficam fora do novo intervalo \(“Corte m1”, “Corte m2”, “Corte m3”, …\)/);
});

test('mesma duração mas arquivo diferente: regravado/recodificado', () => {
  const p = project();
  const r = compareSource(p, { size: 2 * GB, duration: 7200, width: 1280, height: 720 });
  assert.equal(r.changed, true);
  assert.equal(r.direction, 'same');
  assert.equal(r.size.changed, true);
  assert.equal(r.resolution.changed, true);
  const text = r.lines.join('\n');
  assert.match(text, /A duração é a mesma \(2:00:00\), mas o arquivo mudou: foi regravado ou recodificado/);
  assert.match(text, /Resolução: 1920×1080 → 1280×720/);
});

test('não deu para medir a duração do arquivo novo: compara só o tamanho, sem inventar corte fora', () => {
  const p = project();
  const r = compareSource(p, { size: 1 * GB, duration: null });
  assert.equal(r.changed, true);
  assert.equal(r.duration.changed, false);
  assert.equal(r.cuts.outside.length, 0);
  assert.equal(compareSource(p, { size: 4 * GB, duration: null }).changed, false);
  assert.equal(compareSource({ source: {}, cuts: [] }, { size: 10, duration: 10 }).changed, false, 'projeto sem medidas anteriores');
});

test('chat salvo com mais mensagens que o registrado vira linha própria', () => {
  const p = project();
  const r = compareSource(p, { size: 5 * GB, duration: 9000 }, { chat: { recorded: 1000, actual: 1600, afterOldEnd: 450 } });
  assert.deepEqual(r.chat, { recorded: 1000, actual: 1600, added: 600, afterOldEnd: 450 });
  assert.match(r.lines.join('\n'), /O chat salvo tem 600 mensagens a mais do que o projeto registrava \(450 depois de 2:00:00\)/);
  assert.equal(compareSource(p, { size: 5 * GB, duration: 9000 }, { chat: { recorded: 10, actual: 10 } }).chat, null);
  assert.match(compareSource(p, { size: 5 * GB, duration: 9000 }, { chat: { recorded: 9, actual: 10 } }).lines.join('\n'), /1 mensagem a mais/);
});

test('describeComparison monta título e mensagem com o nome do arquivo', () => {
  const r = compareSource(project(), { size: 5 * GB, duration: 9000 });
  const d = describeComparison(r, 'live.mp4');
  assert.equal(d.title, 'A fonte mudou desde a última análise');
  assert.ok(d.message.startsWith('Este projeto foi analisado com outra versão de “live.mp4”.\n'));
  assert.ok(d.message.includes('mais longo'));
});
