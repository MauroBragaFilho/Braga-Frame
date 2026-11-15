'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/core/subtitles/shared');

const cue = (start, end, text, extra = {}) => ({ start, end, text, ...extra });
const cutOf = (start, end, revision = 1) => ({ start, end, revision });

// ---------- estilo ----------

test('normalizeStyle: padrões, limites e valores inválidos', () => {
  const d = S.normalizeStyle(undefined);
  assert.deepEqual(d, S.DEFAULT_STYLE);
  assert.equal(S.normalizeStyle(null).fontFamily, 'Arial');

  const s = S.normalizeStyle({ fontSize: 9999, outlineWidth: -4, backgroundOpacity: 7, maxCharsPerLine: 2, color: 'vermelho', outlineColor: '#abc', position: 'meio', background: 'neon', bold: 'sim' });
  assert.equal(s.fontSize, 140);
  assert.equal(s.outlineWidth, 0);
  assert.equal(s.backgroundOpacity, 1);
  assert.equal(s.maxCharsPerLine, 8);
  assert.equal(s.color, '#FFFFFF', 'cor inválida volta ao padrão');
  assert.equal(s.outlineColor, '#000000');
  assert.equal(s.position, 'bottom');
  assert.equal(s.background, 'shadow');
  assert.equal(s.bold, true);

  assert.equal(S.normalizeStyle({ color: '#ff8800' }).color, '#FF8800', 'cor em maiúsculas');
  assert.equal(S.normalizeStyle({ fontSize: '72' }).fontSize, 72, 'número como texto');
  assert.equal(S.normalizeStyle({ bold: false }).bold, false);
  // nome de fonte com caracteres que quebrariam o ASS
  assert.equal(S.normalizeStyle({ fontFamily: 'Foo, Bar;{x}\\' }).fontFamily, 'Foo Barx');
  assert.equal(S.normalizeStyle({ fontFamily: '   ' }).fontFamily, 'Arial');
  assert.equal(S.normalizeStyle({ fontFamily: 'x'.repeat(61) }).fontFamily, 'Arial');
  // idempotente
  assert.deepEqual(S.normalizeStyle(s), s);
});

test('modo de entrega e formato do arquivo separado', () => {
  assert.equal(S.normalizeMode('burn'), 'burn');
  assert.equal(S.normalizeMode('sidecar'), 'sidecar');
  assert.equal(S.normalizeMode('both'), 'both');
  assert.equal(S.normalizeMode('srt'), 'sidecar');
  assert.equal(S.normalizeMode('burn+ass'), 'both');
  assert.equal(S.normalizeMode('qualquer'), 'burn');
  assert.equal(S.normalizeMode(undefined), 'burn');
  assert.equal(S.sidecarFormatOf({ sidecarFormat: 'ass' }), 'ass');
  assert.equal(S.sidecarFormatOf({ mode: 'burn+ass' }), 'ass');
  assert.equal(S.sidecarFormatOf({ sidecarFormat: 'xyz', mode: 'burn' }), 'srt');
  assert.equal(S.sidecarFormatOf(null), 'srt');
});

test('escala e margem acompanham a resolução de saída', () => {
  assert.equal(S.scaleFor(1080, 1920), 1);
  assert.ok(Math.abs(S.scaleFor(1440, 2560) - 1440 / 1080) < 1e-9);
  assert.equal(S.scaleFor(1920, 1080), 1, 'horizontal: lado menor');
  assert.ok(Math.abs(S.scaleFor(2160, 3840) - 2) < 1e-9);
  assert.equal(S.marginFor('center', 1080, 1920), 0);
  const bottomV = S.marginFor('bottom', 1080, 1920);
  const bottomH = S.marginFor('bottom', 1920, 1080);
  assert.ok(bottomV > bottomH, 'o vertical deixa mais espaço embaixo (área dos botões do Shorts)');
  assert.equal(S.marginFor('bottom', 1440, 2560), Math.round(2560 * 0.14));
  assert.ok(S.marginFor('top', 1080, 1920) < bottomV);
});

// ---------- tempos ----------

test('fmtClock e parseClock', () => {
  assert.equal(S.fmtClock(0), '0:00.00');
  assert.equal(S.fmtClock(62.35), '1:02.35');
  assert.equal(S.fmtClock(59.999), '1:00.00');
  assert.equal(S.fmtClock(3725.5), '62:05.50');
  assert.equal(S.fmtClock(-3), '-0:03.00', 'tempo negativo mantém o sinal (fala fora do corte)');
  assert.equal(S.fmtClock(-0.004), '0:00.00');
  assert.equal(S.parseClock(S.fmtClock(-2.02)), -2.02);
  assert.equal(S.parseClock('1:02.35'), 62.35);
  assert.equal(S.parseClock('62,35'), 62.35);
  assert.equal(S.parseClock('7'), 7);
  assert.equal(S.parseClock(' 0:07 '), 7);
  assert.equal(S.parseClock('-1.5'), -1.5);
  for (const bad of ['', 'abc', '1:2:3', '1:', ':5', '--1']) assert.ok(Number.isNaN(S.parseClock(bad)), `inválido: "${bad}"`);
  assert.ok(Number.isNaN(S.parseClock(undefined)));
});

// ---------- lista de falas ----------

test('cleanCues: ordena, arredonda, ignora inválidos e mantém só needsReview', () => {
  const out = S.cleanCues([
    cue(5, 6, 'c'), null, 'x', cue(1, 2, '  a  ', { confidence: 0.3, foo: 1 }), cue('2', '3', 'b', { needsReview: true }),
    cue(3.0004, 2.5, 'invertida'), { start: 'x', end: 1, text: 'ruim' }
  ]);
  assert.deepEqual(out.map((c) => c.text), ['a', 'b', 'invertida', 'c']);
  assert.deepEqual(out[0], { start: 1, end: 2, text: 'a' }, 'campos extras somem');
  assert.equal(out[1].needsReview, true);
  assert.deepEqual([out[2].start, out[2].end], [2.5, 3], 'início e fim invertidos são corrigidos');
  assert.deepEqual(S.cleanCues(undefined), []);
  assert.deepEqual(S.cleanCues(out), out, 'idempotente');
});

test('shiftCues desloca tudo sem cortar nada', () => {
  const out = S.shiftCues([cue(1, 2, 'a'), cue(3, 4, 'b', { needsReview: true })], -0.5);
  assert.deepEqual(out, [cue(0.5, 1.5, 'a'), cue(2.5, 3.5, 'b', { needsReview: true })]);
  const neg = S.shiftCues([cue(0.2, 1, 'a')], -1);
  assert.deepEqual([neg[0].start, neg[0].end], [-0.8, 0], 'pode ficar antes de zero (o corte decide o que aparece)');
  assert.deepEqual(S.shiftCues([cue(1, 2, 'a')], 0.1)[0], cue(1.1, 2.1, 'a'));
  assert.deepEqual(S.shiftCues([cue(1, 2, 'a')], 'x'), [cue(1, 2, 'a')]);
});

test('splitCue: no cursor do texto, no tempo do player e ao meio', () => {
  const base = [cue(0, 4, 'um dois tres quatro'), cue(5, 6, 'fim')];
  // cursor depois de "um dois" (posição 7), tempo proporcional
  let r = S.splitCue(base, 0, { charIndex: 7 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.cues.map((c) => c.text), ['um dois', 'tres quatro', 'fim']);
  assert.ok(Math.abs(r.cues[0].end - (4 * 7) / 19) < 0.01, `tempo proporcional ao texto: ${r.cues[0].end}`);
  assert.equal(r.cues[0].end, r.cues[1].start, 'sem buraco entre as metades');
  assert.equal(r.cues[0].start, 0);
  assert.equal(r.cues[1].end, 4);

  // no tempo do player (1.0 s) e sem cursor: texto dividido proporcionalmente, na fronteira de palavra
  r = S.splitCue(base, 0, { time: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.cues[0].end, 1, 'o tempo do player manda no corte do tempo');
  assert.equal(r.cues[0].text, 'um', 'um quarto do texto cai na primeira palavra');

  // ao meio
  r = S.splitCue(base, 0);
  assert.deepEqual(r.cues.slice(0, 2).map((c) => c.text), ['um dois', 'tres quatro']);

  // marca de revisão é herdada pelas duas metades
  r = S.splitCue([cue(0, 2, 'a b', { needsReview: true })], 0);
  assert.deepEqual(r.cues.map((c) => c.needsReview), [true, true]);

  // erros
  assert.equal(S.splitCue(base, 1).ok, false, 'uma palavra só');
  assert.match(S.splitCue(base, 1).message, /uma palavra só/);
  assert.equal(S.splitCue(base, 9).ok, false);
  assert.equal(S.splitCue([cue(0, 2, 'a b')], 0, { charIndex: 0 }).ok, true, 'cursor nas pontas é ignorado: divide ao meio');

  // fala curta: as duas metades continuam válidas
  r = S.splitCue([cue(1, 1.1, 'aa bb')], 0);
  assert.equal(r.ok, true);
  assert.ok(r.cues[0].end > r.cues[0].start && r.cues[1].end > r.cues[1].start);
});

test('mergeCues, removeCue e addCue', () => {
  const list = [cue(0, 1, 'a'), cue(1.2, 2, 'b', { needsReview: true }), cue(3, 4, 'c')];
  let r = S.mergeCues(list, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cues[0], { start: 0, end: 2, text: 'a b', needsReview: true });
  assert.equal(r.cues.length, 2);
  assert.equal(S.mergeCues(list, 2).ok, false, 'a última não tem seguinte');

  r = S.removeCue(list, 1);
  assert.deepEqual(r.cues.map((c) => c.text), ['a', 'c']);
  assert.equal(S.removeCue(list, 5).ok, false);

  r = S.addCue(list, { at: 2.5, length: 1, duration: 10 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.cues[r.index], { start: 2.5, end: 3.5, text: '' });
  assert.equal(r.cues.length, 4);
  // dentro do corte: não passa do fim nem fica antes de zero
  r = S.addCue([], { at: 9.9, length: 5, duration: 10 });
  assert.ok(r.cues[0].end <= 10 && r.cues[0].end > r.cues[0].start);
  r = S.addCue([], { at: -4, length: 2, duration: 10 });
  assert.equal(r.cues[0].start, 0);
});

test('cueAt: fala no ar (início incluído, fim excluído)', () => {
  const list = [cue(0, 1, 'a'), cue(1, 2, 'b'), cue(1.5, 3, 'c')];
  assert.equal(S.cueAt(list, 0), 0);
  assert.equal(S.cueAt(list, 0.999), 0);
  assert.equal(S.cueAt(list, 1), 1);
  assert.equal(S.cueAt(list, 1.7), 2, 'em sobreposição vale a que começou por último');
  assert.equal(S.cueAt(list, 3), -1);
  assert.equal(S.cueAt(list, -1), -1);
  assert.equal(S.cueAt([], 1), -1);
});

test('rangeState', () => {
  assert.equal(S.rangeState(cue(1, 2, 'x'), 10), 'inside');
  assert.equal(S.rangeState(cue(-1, 2, 'x'), 10), 'partial');
  assert.equal(S.rangeState(cue(9, 11, 'x'), 10), 'partial');
  assert.equal(S.rangeState(cue(-3, -1, 'x'), 10), 'outside');
  assert.equal(S.rangeState(cue(10, 12, 'x'), 10), 'outside');
  assert.equal(S.rangeState(null, 10), 'outside');
});

// ---------- quebra de linhas ----------

test('wrapText equilibra as linhas e respeita o limite', () => {
  assert.equal(S.wrapText('oi', 22), 'oi');
  assert.equal(S.wrapText('Olá pessoal bem-vindos ao nosso canal', 22), 'Olá pessoal bem-vindos\nao nosso canal');
  const lines = S.wrapText('uma frase bem comprida para precisar de três linhas inteiras aqui', 20).split('\n');
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(l.length <= 20, `linha longa demais: "${l}"`);
  assert.equal(S.wrapText('supercalifragilisticexpialidocious curta', 10).split('\n')[0], 'supercalifragilisticexpialidocious', 'palavra maior que o limite fica sozinha');
  assert.equal(S.wrapText('a\nb c', 22), 'a\nb c', 'quebras manuais são respeitadas');
  assert.equal(S.wrapText('', 22), '');
  assert.equal(S.wrapText('  muitos   espaços  ', 22), 'muitos espaços');
  // emoji conta como um caractere
  assert.equal(S.wrapText('😀😀😀😀 😀😀😀😀', 9), '😀😀😀😀 😀😀😀😀');
});

// ---------- rebase ao mudar o intervalo do corte ----------

const subsFor = (cut, cues, extra = {}) => ({ enabled: true, basedOn: S.rangeOf(cut), cues, style: {}, mode: 'burn', ...extra });

test('rebase: sem mudança nada acontece; só a revisão muda -> só basedOn', () => {
  const cut = cutOf(10, 40, 1);
  const subs = subsFor(cut, [cue(1, 2, 'a')]);
  let r = S.rebaseSubtitles(subs, cut);
  assert.equal(r.changed, false);
  assert.equal(r.subtitles, subs, 'mesmo objeto');

  r = S.rebaseSubtitles(subs, cutOf(10, 40, 3));
  assert.equal(r.changed, true);
  assert.equal(r.shifted, false);
  assert.deepEqual(r.subtitles.cues, subs.cues, 'falas intactas');
  assert.deepEqual(r.subtitles.basedOn, { start: 10, end: 40, revision: 3 });

  // sem basedOn (legenda feita à mão por outro caminho): assume o intervalo atual, sem deslocar
  r = S.rebaseSubtitles({ enabled: true, cues: [cue(1, 2, 'a')] }, cut);
  assert.equal(r.changed, true);
  assert.deepEqual(r.subtitles.cues, [cue(1, 2, 'a')]);
  assert.deepEqual(r.subtitles.basedOn, { start: 10, end: 40, revision: 1 });
  assert.equal(S.rebaseSubtitles(null, cut).changed, false);
  assert.equal(S.rebaseSubtitles(subs, null).changed, false);
});

test('rebase: início mais cedo desloca tudo, sem sinalizar (acompanha o áudio exatamente)', () => {
  const subs = subsFor(cutOf(10, 40), [cue(1, 2, 'a'), cue(5, 6, 'b')]);
  const r = S.rebaseSubtitles(subs, cutOf(7, 40, 2));
  assert.equal(r.changed, true);
  assert.equal(r.shifted, true);
  assert.deepEqual(r.subtitles.cues, [cue(4, 5, 'a'), cue(8, 9, 'b')]);
  assert.equal(r.clipped, 0);
  assert.equal(r.outside, 0);
  assert.deepEqual(r.subtitles.basedOn, { start: 7, end: 40, revision: 2 });
});

test('rebase: início mais tarde sinaliza; a que passa da borda e a que sai por completo são mantidas, sem recorte', () => {
  const subs = subsFor(cutOf(10, 40), [cue(0, 1.5, 'fora'), cue(1.5, 3, 'metade'), cue(5, 6, 'dentro')]);
  const r = S.rebaseSubtitles(subs, cutOf(12, 40, 2));
  assert.equal(r.shifted, true);
  assert.equal(r.clipped, 1);
  assert.equal(r.outside, 1);
  const [fora, metade, dentro] = r.subtitles.cues;
  assert.equal(fora.text, 'fora');
  assert.equal(fora.needsReview, true);
  assert.deepEqual([fora.start, fora.end], [-2, -0.5], 'mantida, fora do intervalo (volta se o corte voltar a cobri-la)');
  assert.equal(metade.needsReview, true);
  assert.deepEqual([metade.start, metade.end], [-0.5, 1], 'só deslocada: o tempo guardado NÃO é recortado (quem mostra ou exporta recorta)');
  assert.equal(S.rangeState(metade, 28), 'partial');
  assert.equal(dentro.needsReview, undefined, 'a que ficou inteira só foi deslocada');
  assert.deepEqual([dentro.start, dentro.end], [3, 4]);
  assert.equal(r.subtitles.cues.length, 3, 'nada foi descartado');
  assert.equal(S.needsReviewCount(r.subtitles), 2);
  // o que aparece no vídeo é recortado ao corte
  assert.deepEqual(S.visibleCues(r.subtitles, cutOf(12, 40, 2)).map((c) => [c.text, c.start, c.end]), [['metade', 0, 1], ['dentro', 3, 4]]);
});

test('rebase: fim mais cedo sinaliza as falas que passam do novo fim, sem cortar o tempo delas', () => {
  const subs = subsFor(cutOf(0, 30), [cue(1, 2, 'a'), cue(18, 22, 'cruza'), cue(25, 27, 'fora')]);
  const r = S.rebaseSubtitles(subs, cutOf(0, 20, 2));
  assert.equal(r.shifted, false);
  assert.equal(r.clipped, 1);
  assert.equal(r.outside, 1);
  assert.deepEqual(r.subtitles.cues.map((c) => [c.text, c.start, c.end, c.needsReview === true]), [
    ['a', 1, 2, false], ['cruza', 18, 22, true], ['fora', 25, 27, true]
  ]);
  assert.deepEqual(S.visibleCues(r.subtitles, cutOf(0, 20, 2)).map((c) => [c.text, c.start, c.end]), [['a', 1, 2], ['cruza', 18, 20]]);
});

test('rebase: aparar o corte e desfazer devolve os tempos EXATOS das falas das bordas (nada é recortado de forma permanente)', () => {
  // corte 10-20 com falas coladas nas bordas: [0,5-2,5] e [8-10] (relativas ao início)
  const original = subsFor(cutOf(10, 20, 1), [cue(0.5, 2.5, 'começo'), cue(5, 6, 'meio'), cue(8, 10, 'fim')]);
  // "aparar": início +1 e fim -1 (BF.review.adjust)
  const trimmed = S.rebaseSubtitles(original, cutOf(11, 19, 2));
  assert.equal(trimmed.clipped, 2, '"começo" passa da borda esquerda e "fim" da direita');
  assert.deepEqual(trimmed.subtitles.cues.map((c) => [c.text, c.start, c.end]), [['começo', -0.5, 1.5], ['meio', 4, 5], ['fim', 7, 9]], 'tempos guardados sem recorte');
  assert.deepEqual(trimmed.subtitles.cues.map((c) => c.needsReview === true), [true, false, true]);
  // Ctrl+Z da aba Cortes (duas vezes: o fim e o início voltam)
  const undone = S.rebaseSubtitles(trimmed.subtitles, cutOf(10, 20, 3));
  assert.deepEqual(undone.subtitles.cues.map((c) => [c.text, c.start, c.end]), [['começo', 0.5, 2.5], ['meio', 5, 6], ['fim', 8, 10]],
    'os tempos são exatamente os de antes de aparar');
  // aparar mais de uma vez em seguida (cada passo parte do anterior) e voltar de uma vez também é exato
  const step1 = S.rebaseSubtitles(original, cutOf(11, 20, 2)).subtitles;
  const step2 = S.rebaseSubtitles(step1, cutOf(12, 18, 3)).subtitles;
  const back = S.rebaseSubtitles(step2, cutOf(10, 20, 4)).subtitles;
  assert.deepEqual(back.cues.map((c) => [c.start, c.end]), [[0.5, 2.5], [5, 6], [8, 10]]);
});

test('rebase: ida e volta preserva as falas que ficaram fora', () => {
  const original = subsFor(cutOf(10, 40), [cue(0.5, 1.5, 'início'), cue(10, 11, 'meio')]);
  const cut2 = cutOf(13, 40, 2);
  const stage1 = S.rebaseSubtitles(original, cut2).subtitles;
  assert.equal(S.rangeState(stage1.cues[0], 27), 'outside');
  const stage2 = S.rebaseSubtitles(stage1, cutOf(10, 40, 3)).subtitles;
  assert.deepEqual(stage2.cues.map((c) => [c.text, c.start, c.end]), [['início', 0.5, 1.5], ['meio', 10, 11]], 'a fala de fora voltou ao tempo original');
  assert.equal(stage2.cues[0].needsReview, true, 'a marca de revisão fica até o usuário revisar');
});

test('visibleCues: recorta ao corte, tira vazias e as de fora; acompanha intervalo desatualizado', () => {
  const cut = cutOf(10, 20, 2);
  const subs = { enabled: true, basedOn: { start: 10, end: 20, revision: 2 }, cues: [cue(-1, 1, 'ini'), cue(2, 3, '   '), cue(4, 5, 'ok'), cue(9, 12, 'fim'), cue(11, 12, 'fora')] };
  const v = S.visibleCues(subs, cut);
  assert.deepEqual(v.map((c) => [c.text, c.start, c.end]), [['ini', 0, 1], ['ok', 4, 5], ['fim', 9, 10]]);
  // basedOn antigo: o corte começava 2 s antes (8 s) e agora começa em 10 s -> a fala em 3 s relativo ao início antigo fica em 1 s
  const stale = { enabled: true, basedOn: { start: 8, end: 20, revision: 1 }, cues: [cue(3, 4, 'x')] };
  assert.deepEqual(S.visibleCues(stale, cut).map((c) => [c.start, c.end]), [[1, 2]]);
  assert.deepEqual(S.visibleCues(null, cut), []);
});

test('importCuesForCut: só o que cruza o corte, deslocado pelo início', () => {
  const file = [cue(5, 8, 'antes'), cue(18, 22, 'cruza o início'), cue(25, 27, 'dentro'), cue(38, 45, 'cruza o fim'), cue(60, 62, 'depois')];
  const r = S.importCuesForCut(file, cutOf(20, 40));
  assert.equal(r.total, 5);
  assert.deepEqual(r.cues.map((c) => [c.text, c.start, c.end, c.needsReview === true]), [
    ['cruza o início', 0, 2, true], ['dentro', 5, 7, false], ['cruza o fim', 18, 20, true]
  ]);
  assert.equal(r.clipped, 2);
  assert.deepEqual(S.importCuesForCut([cue(1, 2, 'x')], cutOf(20, 40)).cues, []);
});

// ---------- japonês e chinês: sem espaço entre as palavras ----------

test('textWidth: caractere de largura total (CJK, hangul) vale 2; o resto vale 1', () => {
  assert.equal(S.textWidth('abc'), 3);
  assert.equal(S.textWidth('こんにちは'), 10);
  assert.equal(S.textWidth('今日は天気'), 10);
  assert.equal(S.textWidth('안녕'), 4);
  assert.equal(S.textWidth('Switchで'), 8);
  assert.equal(S.textWidth('😀😀'), 2, 'emoji conta um');
  assert.equal(S.textWidth(''), 0);
  assert.equal(S.hasCjk('Olá mundo'), false);
  assert.equal(S.hasCjk('Switchで'), true);
  assert.equal(S.hasCjk('안녕'), false, 'o coreano usa espaços');
});

test('wrapText em japonês/chinês: quebra entre os caracteres, pela largura, sem abrir linha com pontuação que fecha', () => {
  const ja = '今日はみんなでゲームをします。よろしくお願いします。';
  const lines = S.wrapText(ja, 22).split('\n');
  assert.ok(lines.length >= 2, 'o texto passa de uma linha de 11 caracteres de largura total');
  for (const line of lines) assert.ok(S.textWidth(line) <= 22, `linha larga demais (${S.textWidth(line)}): ${line}`);
  assert.equal(lines.join(''), ja, 'não perde nem inclui caractere (e não põe espaço dentro do texto)');
  assert.ok(lines.every((l) => !/^[。、！？）」]/.test(l)), 'pontuação que fecha não abre linha');
  // as linhas ficam equilibradas, não uma cheia e uma com sobra
  assert.ok(Math.max(...lines.map(S.textWidth)) - Math.min(...lines.map(S.textWidth)) <= 6, lines.join(' | '));
  // mais curto que o limite: uma linha só
  assert.equal(S.wrapText('こんにちは', 22), 'こんにちは');
  // chinês, limite pequeno
  assert.equal(S.wrapText('大家好欢迎来到我的频道', 12), '大家好欢迎来\n到我的频道');
  // latino misturado: a palavra latina não se parte, e entre ela e o CJK não entra espaço
  const mixed = S.wrapText('Nintendo Switchでゲームをします', 16).split('\n');
  assert.ok(mixed.join('').includes('Switchで'), mixed.join(' | '));
  assert.ok(mixed.every((l) => S.textWidth(l) <= 16 || /^\S+$/.test(l)));
  // o texto latino segue como antes
  assert.equal(S.wrapText('Olá pessoal bem-vindos ao nosso canal', 22), 'Olá pessoal bem-vindos\nao nosso canal');
});

test('breakUnits e joinUnits: cada caractere japonês/chinês é uma unidade, grudada na anterior', () => {
  assert.deepEqual(S.breakUnits('Olá mundo'), [{ text: 'Olá', glue: false }, { text: 'mundo', glue: false }]);
  assert.deepEqual(S.breakUnits('今日は。'), [{ text: '今', glue: false }, { text: '日', glue: true }, { text: 'は。', glue: true }]);
  assert.deepEqual(S.breakUnits('「こ」ん'), [{ text: '「こ」', glue: false }, { text: 'ん', glue: true }]);
  assert.deepEqual(S.breakUnits('Switchで 好'), [{ text: 'Switch', glue: false }, { text: 'で', glue: true }, { text: '好', glue: false }]);
  assert.equal(S.joinUnits(S.breakUnits('Switchで 好')), 'Switchで 好');
  assert.deepEqual(S.breakUnits('好,世.'), [{ text: '好,', glue: false }, { text: '世.', glue: true }], 'pontuação ASCII colada também não abre linha');
  assert.equal(S.joinUnits([]), '');
});

test('splitCue e mergeCues em japonês/chinês (sem espaços no texto)', () => {
  const ja = [cue(0, 4, 'こんにちは、みなさん')];
  let r = S.splitCue(ja, 0);
  assert.equal(r.ok, true, 'dá para dividir uma fala sem espaços');
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text + r.cues[1].text, 'こんにちは、みなさん', 'nenhum caractere se perde');
  assert.ok(!/^[、。]/.test(r.cues[1].text), 'a vírgula não abre a segunda fala');
  r = S.splitCue(ja, 0, { time: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.cues[0].text.length < r.cues[1].text.length, 'perto do começo: a primeira metade é a menor');
  assert.equal(S.splitCue([cue(0, 2, '好')], 0).ok, false, 'um caractere só não divide');
  assert.equal(S.mergeCues([cue(0, 1, 'こんにちは。'), cue(1, 2, '今日は')], 0).cues[0].text, 'こんにちは。今日は', 'sem espaço entre falas japonesas');
  assert.equal(S.mergeCues([cue(0, 1, 'Olá'), cue(1, 2, 'mundo')], 0).cues[0].text, 'Olá mundo', 'o resto continua com espaço');
  assert.equal(S.mergeCues([cue(0, 1, 'Hello'), cue(1, 2, '')], 0).cues[0].text, 'Hello');
});

test('trimLineEnds: tira espaços e tabs do fim das linhas (menos da última), em tempo linear', () => {
  assert.equal(S.trimLineEnds('a  \nb\t \n c  '), 'a\nb\n c  ');
  assert.equal(S.trimLineEnds(''), '');
  assert.equal(S.trimLineEnds('sem quebra   '), 'sem quebra   ');
  const t0 = Date.now();
  S.trimLineEnds(`x${' '.repeat(2000000)}y\n`);
  assert.ok(Date.now() - t0 < 1000);
});
