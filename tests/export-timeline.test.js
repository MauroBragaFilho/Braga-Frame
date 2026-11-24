'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planTimeline, buildXml, buildEdl, buildTimes, alignedSubtitles, buildExport, timecode, clockMs, pathUrl } = require('../src/core/export/timeline');

const SOURCE = { path: 'D:\\Vídeos\\Meu vídeo [x].mp4', duration: 4661.3, fps: 29.97, width: 1920, height: 1080, hasAudio: true };
const subs = (start, cues) => ({ basedOn: { start, end: start + 10 }, cues, style: {} });
const CUTS = [
  { id: 'b', title: 'Segundo', start: 100, end: 130.04, status: 'approved' },
  { id: 'a', title: 'Cena & "um" <dois>', start: 10.5, end: 20, status: 'approved', subtitles: subs(10.5, [{ start: 0.5, end: 2, text: 'Olá mundo' }, { start: 3, end: 4.2, text: 'segunda fala' }]) },
  { id: 'c', title: 'Rejeitado', start: 5, end: 9, status: 'rejected' },
  { id: 'd', title: 'Pendente', start: 200, end: 210, status: 'pending' }
];

/** Confere se o XML está bem formado: cada tag aberta fecha na ordem, e a raiz é uma só. */
function assertWellFormed(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const stack = [];
  let roots = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = m;
    if (self) continue;
    if (close) {
      assert.equal(stack.pop(), tag, `tag </${tag}> fora de ordem`);
    } else {
      if (!stack.length) roots += 1;
      stack.push(tag);
    }
  }
  assert.equal(stack.length, 0, `tags sem fechar: ${stack.join(',')}`);
  assert.equal(roots, 1);
}

test('planTimeline: só os aprovados, na ordem do vídeo, em quadros inteiros e um depois do outro', () => {
  const plan = planTimeline({ cuts: CUTS, source: SOURCE });
  assert.deepEqual(plan.clips.map((c) => c.id), ['a', 'b']);
  assert.equal(plan.base, 30);
  assert.equal(plan.ntsc, true);
  const [a, b] = plan.clips;
  assert.equal(a.tlIn, 0);
  assert.equal(a.tlOut, a.srcOut - a.srcIn);
  assert.equal(b.tlIn, a.tlOut, 'sem vão entre os clipes');
  assert.equal(plan.totalFrames, b.tlOut);
  assert.ok(Number.isInteger(a.srcIn) && Number.isInteger(a.srcOut));
  assert.equal(planTimeline({ cuts: CUTS, source: SOURCE, status: 'all' }).clips.length, 3, '"todos" tira só os rejeitados');
});

test('planTimeline: sem fps usa 30 e avisa; corte além do fim do vídeo é aparado; duração zero sai', () => {
  const p = planTimeline({ cuts: [{ id: 'x', start: 1, end: 3, status: 'approved' }], source: { duration: 10 } });
  assert.equal(p.fps, 30);
  assert.match(p.warnings[0], /quadros por segundo/);
  const edge = planTimeline({ cuts: [{ id: 'x', start: 8, end: 20, status: 'approved' }], source: { duration: 10, fps: 25 } });
  assert.equal(edge.clips[0].srcOut, 250);
  const zero = planTimeline({ cuts: [{ id: 'x', start: 10, end: 11, status: 'approved' }], source: { duration: 10, fps: 25 } });
  assert.equal(zero.clips.length, 0);
});

test('timecode e lista de tempos', () => {
  assert.equal(timecode(0, 30), '00:00:00:00');
  assert.equal(timecode(30 * 3661 + 7, 30), '01:01:01:07');
  assert.equal(clockMs(2), '00:00:02.000');
  assert.equal(clockMs(3725.5), '01:02:05.500');
  const plan = planTimeline({ cuts: CUTS, source: { ...SOURCE, fps: 30 } });
  assert.equal(buildTimes(plan), '00:00:10.500 -> 00:00:20.000\n00:01:40.000 -> 00:02:10.033\n');
});

test('pathUrl: unidade com %3a, espaços e acentos codificados', () => {
  assert.equal(pathUrl('D:\\Vídeos\\a b.mp4'), 'file://localhost/D%3a/V%C3%ADdeos/a%20b.mp4');
  assert.equal(pathUrl('/home/x/y.mp4'), 'file://localhost/home/x/y.mp4');
});

test('XML: bem formado, uma sequência, um clipe de vídeo e dois de áudio por corte, o arquivo declarado uma vez só', () => {
  const plan = planTimeline({ cuts: CUTS, source: SOURCE });
  const xml = buildXml(plan, { name: 'Projeto & teste', source: SOURCE });
  assertWellFormed(xml);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="4">/);
  assert.equal((xml.match(/<sequence /g) || []).length, 1);
  assert.equal((xml.match(/<clipitem id="clipitem-v-/g) || []).length, 2);
  assert.equal((xml.match(/<clipitem id="clipitem-a[12]-/g) || []).length, 4);
  assert.equal((xml.match(/<file id="file-1">/g) || []).length, 1);
  assert.match(xml, /<timebase>30<\/timebase><ntsc>TRUE<\/ntsc>/);
  assert.match(xml, /<name>Projeto &amp; teste<\/name>/);
  assert.match(xml, /<name>Cena &amp; &quot;um&quot; &lt;dois&gt;<\/name>/);
  assert.match(xml, /<pathurl>file:\/\/localhost\/D%3a\/V%C3%ADdeos\/Meu%20v%C3%ADdeo%20%5Bx%5D\.mp4<\/pathurl>/);
  const first = plan.clips[0];
  assert.match(xml, new RegExp(`<start>0</start><end>${first.tlOut}</end><in>${first.srcIn}</in><out>${first.srcOut}</out>`));
  assert.match(xml, /<width>1920<\/width><height>1080<\/height>/);
});

test('XML sem áudio: nenhuma faixa de áudio; EDL só com vídeo', () => {
  const src = { ...SOURCE, hasAudio: false };
  const plan = planTimeline({ cuts: CUTS, source: src });
  const xml = buildXml(plan, { name: 'x', source: src });
  assertWellFormed(xml);
  assert.ok(!xml.includes('<audio>'));
  assert.match(buildEdl(plan, { name: 'x', source: src }), /001 {2}AX {7}V {5}C /);
});

test('EDL: colunas do CMX 3600, tempos de origem e de destino, título do corte como comentário', () => {
  const plan = planTimeline({ cuts: CUTS, source: { ...SOURCE, fps: 30 } });
  const edl = buildEdl(plan, { name: 'Meu projeto', source: SOURCE });
  const lines = edl.split('\r\n');
  assert.equal(lines[0], 'TITLE: Meu projeto');
  assert.equal(lines[1], 'FCM: NON-DROP FRAME');
  assert.equal(lines[3], '001  AX       B     C        00:00:10:15 00:00:20:00 00:00:00:00 00:00:09:15');
  assert.equal(lines[4], '* FROM CLIP NAME: Meu vídeo [x].mp4');
  assert.equal(lines[5], '* COMMENT: Cena & "um" <dois>');
  assert.match(lines[7], /^002 {2}AX {7}B {5}C {8}00:01:40:00 00:02:10:01 00:00:09:15 /);
});

test('legendas alinhadas: tempos da timeline, deslocadas quando o corte mudou de borda e aparadas ao clipe (a que fica toda depois do fim sai)', () => {
  const cuts = [
    { id: 'a', start: 10, end: 20, status: 'approved', subtitles: subs(10, [{ start: 1, end: 2, text: 'um' }]) },
    // o corte começava em 50 quando as falas foram feitas e agora começa em 48: tudo anda 2 s
    { id: 'b', start: 48, end: 58, status: 'approved', subtitles: subs(50, [{ start: 1, end: 2, text: 'dois' }, { start: 7, end: 12, text: 'passa do fim' }, { start: 9, end: 12, text: 'depois do fim' }]) },
    { id: 'c', start: 100, end: 110, status: 'approved' }
  ];
  const plan = planTimeline({ cuts, source: { ...SOURCE, fps: 25, duration: 500 } });
  const out = alignedSubtitles(plan);
  assert.deepEqual(out.cues.map((c) => [c.start, c.end, c.text]), [[1, 2, 'um'], [13, 14, 'dois'], [19, 20, 'passa do fim']]);
  assert.equal(out.cutsWith, 2);
  assert.equal(out.cutsWithout, 1);
});

test('buildExport: arquivos pedidos, resumo e avisos; sem aprovados avisa; sem legenda não cria o .srt', () => {
  const all = buildExport({ cuts: CUTS, source: SOURCE, name: 'Projeto' });
  assert.deepEqual(all.files.map((f) => f.name), ['Projeto.xml', 'Projeto.edl', 'Projeto - tempos.txt', 'Projeto.srt', 'Projeto.ass', 'Projeto - estilo da legenda.json']);
  assert.equal(all.summary.clips, 2);
  assert.equal(all.summary.cues, 2);
  assert.ok(all.warnings.some((w) => /não têm legenda/.test(w)));
  const srt = all.files.find((f) => f.kind === 'srt').content;
  assert.match(srt, /^1\n00:00:00,500 --> 00:00:02,000\nOlá mundo\n/);
  assert.ok(JSON.parse(all.files.find((f) => f.kind === 'style').content).fontFamily);
  assert.match(all.files.find((f) => f.kind === 'ass').content, /PlayResX: 1920/);

  const onlyXml = buildExport({ cuts: CUTS, source: SOURCE, formats: ['xml'] });
  assert.deepEqual(onlyXml.files.map((f) => f.kind), ['xml']);

  const none = buildExport({ cuts: [{ id: 'p', start: 1, end: 5, status: 'pending' }], source: SOURCE });
  assert.equal(none.files.length, 0);
  assert.match(none.warnings.at(-1), /Nenhum corte aprovado/);

  const noSubs = buildExport({ cuts: [CUTS[0]], source: SOURCE });
  assert.ok(!noSubs.files.some((f) => f.kind === 'srt'));
  assert.ok(noSubs.warnings.some((w) => /Nenhum corte tem legenda/.test(w)));
});
