'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/core/subtitles/formats');

const cue = (start, end, text, extra = {}) => ({ start, end, text, ...extra });

// ---------- tempos ----------

test('formatSrtTime e formatAssTime (arredondam como o BDS: metade vai para o par)', () => {
  assert.equal(F.formatSrtTime(0), '00:00:00,000');
  assert.equal(F.formatSrtTime(83.4), '00:01:23,400');
  assert.equal(F.formatSrtTime(3725.0005), '01:02:05,000', 'meio milissegundo vai para o par (0)');
  assert.equal(F.formatSrtTime(3725.0015), '01:02:05,002');
  assert.equal(F.formatSrtTime(-5), '00:00:00,000');
  assert.equal(F.formatSrtTime(Number.NaN), '00:00:00,000');
  assert.equal(F.formatAssTime(83.4), '0:01:23.40');
  assert.equal(F.formatAssTime(3725.456), '1:02:05.46');
  assert.equal(F.formatAssTime(0.004), '0:00:00.00');
  assert.equal(F.parseSrtTime('00:01:23,400'), 83.4);
  assert.equal(F.parseSrtTime('1:23.4'), 83.4);
  assert.equal(F.parseSrtTime('00:00:01,5'), 1.5);
  assert.ok(Number.isNaN(F.parseSrtTime('xx')));
  assert.equal(F.parseAssTime('0:01:23.45'), 83.45);
  assert.ok(Number.isNaN(F.parseAssTime('1:23')));
});

// ---------- SRT ----------

test('cuesToSrt gera o formato SRT e quebra as linhas pelo limite', () => {
  const text = F.cuesToSrt([cue(0.5, 2.25, 'Olá pessoal bem-vindos ao nosso canal'), cue(3, 4, 'segunda')], { maxChars: 22 });
  assert.equal(text, '1\n00:00:00,500 --> 00:00:02,250\nOlá pessoal bem-vindos\nao nosso canal\n\n2\n00:00:03,000 --> 00:00:04,000\nsegunda\n');
});

test('cuesToSrt ignora falas vazias, ordena e arruma fim <= início', () => {
  const text = F.cuesToSrt([cue(5, 6, 'b'), cue(1, 1, 'a'), cue(2, 3, '   ')]);
  const cues = F.parseSrt(text);
  assert.deepEqual(cues.map((c) => c.text), ['a', 'b']);
  assert.ok(cues[0].end > cues[0].start, 'fim maior que o início');
  assert.equal(F.cuesToSrt([]), '');
});

test('parseSrt: ida e volta, CRLF, BOM, marcas HTML, blocos inválidos e vírgula/ponto nos milissegundos', () => {
  const original = [cue(0.5, 2.25, 'linha 1\nlinha 2'), cue(62.125, 65, 'segunda fala')];
  assert.deepEqual(F.parseSrt(F.cuesToSrt(original, { maxChars: 40 })), original);

  const messy = '﻿1\r\n00:00:01.000 --> 00:00:02.500 X1:100\r\n<i>Oi</i> <font color="red">tudo</font> bem\r\n\r\nlixo sem tempo\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}Em cima\r\n\r\n3\r\n00:00:xx --> 00:00:05,000\r\nbloco inválido\r\n';
  const cues = F.parseSrt(messy);
  assert.deepEqual(cues, [cue(1, 2.5, 'Oi tudo bem'), cue(3, 4, 'Em cima')]);
  assert.deepEqual(F.parseSrt(''), []);
  assert.deepEqual(F.parseSrt('texto qualquer'), []);
});

// ---------- ASS ----------

test('assColor converte #RRGGBB + opacidade para &HAABBGGRR (alfa invertido)', () => {
  assert.equal(F.assColor('#FF0000', 1), '&H000000FF');
  assert.equal(F.assColor('#00FF00', 1), '&H0000FF00');
  assert.equal(F.assColor('#0000FF', 1), '&H00FF0000');
  assert.equal(F.assColor('#ffffff', 0), '&HFFFFFFFF', 'totalmente transparente');
  assert.equal(F.assColor('#123456', 0.5), '&H80563412');
});

test('cuesToAss: cabeçalho no tamanho do quadro, estilo e eventos', () => {
  const ass = F.cuesToAss([cue(1, 2.5, 'Olá mundo')], {}, { width: 1080, height: 1920, title: 'Meu corte' });
  const lines = ass.split('\r\n');
  assert.equal(lines[0], '[Script Info]');
  assert.ok(lines.includes('PlayResX: 1080'));
  assert.ok(lines.includes('PlayResY: 1920'));
  assert.ok(lines.includes('Title: Meu corte'));
  assert.ok(lines.includes('ScaledBorderAndShadow: yes'));
  assert.ok(lines.includes('[V4+ Styles]') && lines.includes('[Events]'));
  const style = lines.find((l) => l.startsWith('Style: Default,'));
  const fields = style.slice('Style: '.length).split(',');
  const format = lines.find((l) => l.startsWith('Format: Name, Fontname')).slice('Format: '.length).split(',');
  assert.equal(fields.length, format.length, 'a linha de estilo tem um valor para cada coluna do Format');
  const get = (name) => fields[format.findIndex((c) => c.trim() === name)];
  assert.equal(get('Fontname'), 'Arial');
  assert.equal(get('Fontsize'), '64');
  assert.equal(get('PrimaryColour'), '&H00FFFFFF');
  assert.equal(get('Bold'), '-1');
  assert.equal(get('Alignment'), '2', 'inferior');
  assert.equal(get('BorderStyle'), '1');
  assert.equal(get('Outline'), '5');
  assert.equal(get('MarginV'), String(Math.round(1920 * 0.14)));
  assert.ok(lines.includes('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Olá mundo'));
});

test('cuesToAss: tamanho da fonte e do contorno são proporcionais à resolução de saída', () => {
  const sizeAt = (w, h) => {
    const ass = F.cuesToAss([cue(0, 1, 'x')], { fontSize: 60, outlineWidth: 6 }, { width: w, height: h });
    const f = ass.split('\r\n').find((l) => l.startsWith('Style: Default,')).split(',');
    return { font: Number(f[2]), outline: Number(f[16]) };
  };
  assert.deepEqual(sizeAt(1080, 1920), { font: 60, outline: 6 });
  assert.deepEqual(sizeAt(1440, 2560), { font: 80, outline: 8 });
  assert.deepEqual(sizeAt(2160, 3840), { font: 120, outline: 12 });
  assert.deepEqual(sizeAt(1920, 1080), { font: 60, outline: 6 }, 'horizontal: lado menor 1080');
});

test('cuesToAss: posição, fundo (sombra e caixa) e negrito', () => {
  const f = (style) => F.assStyleLine(style, 1080, 1920).slice('Style: '.length).split(',');
  assert.equal(f({ position: 'center' })[18], '5');
  assert.equal(f({ position: 'top' })[18], '8');
  assert.equal(f({ position: 'top' })[21], String(Math.round(1920 * 0.09)), 'margem do topo');
  assert.equal(f({ position: 'center' })[21], '0');
  const shadow = f({ background: 'shadow', backgroundColor: '#112233', backgroundOpacity: 0.5 });
  assert.equal(shadow[6], '&H80332211', 'BackColour = cor da sombra com opacidade');
  assert.notEqual(shadow[17], '0', 'sombra com profundidade');
  assert.equal(shadow[15], '1');
  const box = f({ background: 'box', backgroundColor: '#112233', backgroundOpacity: 0.5 });
  assert.equal(box[15], '3', 'BorderStyle 3 = caixa opaca');
  assert.equal(box[5], '&H80332211', 'cor da caixa vai na OutlineColour');
  assert.equal(box[17], '0', 'sem sombra com a caixa');
  const none = f({ background: 'none', bold: false });
  assert.equal(none[17], '0');
  assert.equal(none[7], '0', 'sem negrito');
  assert.equal(f({ outlineColor: '#FF0000' })[5], '&H000000FF');
});

test('assText: quebra de linha, escape de { } \\ e leitura de volta', () => {
  assert.equal(F.assText('um dois tres quatro cinco seis', 12), 'um dois\\Ntres quatro\\Ncinco seis');
  assert.equal(F.assText('a {b} c\\d', 40), 'a \\{b\\} c\\\\d');
  const ass = F.cuesToAss([cue(1, 2, 'Olá {mundo} \\ fim')], {}, { width: 1080, height: 1920 });
  assert.deepEqual(F.parseAss(ass), [cue(1, 2, 'Olá {mundo} \\ fim')]);
});

test('parseAss: colunas em outra ordem, vírgulas no texto, comandos e comentários', () => {
  const ass = [
    '[Script Info]', 'Title: x', '',
    '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,isto é comentário',
    'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8\\i1}Olá, mundo\\Nsegunda linha',
    'Dialogue: 1,0:01:00.25,0:01:02.00,Default,,0,0,0,,com\\hespaço duro',
    'Dialogue: 0,xx,0:00:03.00,Default,,0,0,0,,inválida',
    ''
  ].join('\n');
  assert.deepEqual(F.parseAss(ass), [cue(1.5, 3, 'Olá, mundo\nsegunda linha'), cue(60.25, 62, 'com espaço duro')]);

  const reordered = ['[Events]', 'Format: Start, End, Text', 'Dialogue: 0:00:01.00,0:00:02.00,texto, com vírgula'].join('\n');
  assert.deepEqual(F.parseAss(reordered), [cue(1, 2, 'texto, com vírgula')]);
  assert.deepEqual(F.parseAss('[Script Info]\nTitle: vazio'), []);
});

test('ida e volta SRT e ASS com o texto de falas reais', () => {
  const cues = [cue(0.11, 4.2, 'Olá pessoal, bem-vindos ao nosso canal.'), cue(4.2, 8.74, 'Hoje vamos jogar uma partida muito divertida.', { needsReview: true }), cue(8.74, 10.74, 'Vamos lá!')];
  const plain = cues.map(({ start, end, text }) => ({ start, end, text }));
  const viaSrt = F.parseSrt(F.cuesToSrt(cues));
  const viaAss = F.parseAss(F.cuesToAss(cues, {}, { width: 1080, height: 1920 }));
  for (const parsed of [viaSrt, viaAss]) {
    assert.equal(parsed.length, 3);
    parsed.forEach((c, i) => {
      assert.equal(c.text.replace(/\n/g, ' '), plain[i].text);
      assert.ok(Math.abs(c.start - plain[i].start) < 0.0101 && Math.abs(c.end - plain[i].end) < 0.0101, 'tempo preservado (centésimos)');
    });
  }
});

test('parseSubtitleFile: escolhe o formato pela extensão e explica os erros', () => {
  const srt = F.cuesToSrt([cue(1, 2, 'a')]);
  assert.deepEqual(F.parseSubtitleFile(srt, '.srt'), [cue(1, 2, 'a')]);
  assert.deepEqual(F.parseSubtitleFile(srt, 'SRT'), [cue(1, 2, 'a')]);
  const ass = F.cuesToAss([cue(1, 2, 'a')], {}, { width: 100, height: 200 });
  assert.deepEqual(F.parseSubtitleFile(ass, '.ass'), [cue(1, 2, 'a')]);
  assert.deepEqual(F.parseSubtitleFile(ass, '.ssa'), [cue(1, 2, 'a')]);
  assert.throws(() => F.parseSubtitleFile('x', '.vtt'), (err) => err.code === 'BAD_FORMAT' && /\.srt ou \.ass/.test(err.message));
  assert.throws(() => F.parseSubtitleFile('nada de legenda', '.srt'), (err) => err.code === 'EMPTY' && /nenhuma fala/i.test(err.message));
});

// ---------- legenda importada hostil (vem da internet; o parse roda no processo principal) ----------

/** Milissegundos que `fn` leva. */
const timed = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
const BUDGET_MS = 2000; // o conserto leva alguns milissegundos; o defeito levava de 7 s a minutos nestes tamanhos
const srtHead = '1\n00:00:01,000 --> 00:00:02,000\n';
const assHead = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const assDialogue = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,';

test('legenda hostil: "<a" repetido sem ">" não trava o parse do SRT (era quadrático)', () => {
  const hostile = `${srtHead}${'<a'.repeat(80000)}`; // 160 KB: o defeito levava ~7 s
  let cues;
  const ms = timed(() => { cues = F.parseSrt(hostile); });
  assert.ok(ms < BUDGET_MS, `parseSrt levou ${ms.toFixed(0)} ms`);
  assert.equal(cues.length, 1, 'a fala existe; o texto fica como veio (não há marca fechada)');
  assert.equal(cues[0].text.length, 160000);
  // as marcas de verdade continuam saindo
  assert.equal(F.parseSrt(`${srtHead}<i>um</i> <b>dois</b> <font color="red">três</font> a < b > c`)[0].text, 'um dois três a < b > c');
});

test('legenda hostil: "{" repetido sem "}" no ASS e corridas de espaços não travam o parse', () => {
  const cases = [
    ['ASS "{"', () => F.parseAss(`${assHead}${assDialogue}${'{'.repeat(400000)}`)], // o defeito levava ~8,6 s
    ['ASS "}{"', () => F.parseAss(`${assHead}${assDialogue}${'}{'.repeat(200000)}`)],
    ['ASS espaços', () => F.parseAss(`${assHead}${assDialogue}x${' '.repeat(100000)}y`)], // /[ \t]+\n/ era quadrático (~15 s)
    ['SRT espaços', () => F.parseSrt(`${srtHead}x${' '.repeat(100000)}y`)], // idem (~8 s)
    ['SRT tabs e espaços', () => F.parseSrt(`${srtHead}x${' \t'.repeat(60000)}y`)],
    ['cue com espaços (normalizeCue)', () => require('../src/core/subtitles/shared').cleanCues([{ start: 0, end: 1, text: `a${' '.repeat(100000)}b` }])]
  ];
  for (const [name, run] of cases) {
    const ms = timed(run);
    assert.ok(ms < BUDGET_MS, `${name}: ${ms.toFixed(0)} ms`);
  }
  // "{" sem fechamento continua sendo texto; comandos fechados continuam saindo
  assert.equal(F.parseAss(`${assHead}${assDialogue}a {b e {c`)[0].text, 'a {b e {c');
  assert.equal(F.parseAss(`${assHead}${assDialogue}{\\i1}a{\\i0} {x}b {y`)[0].text, 'a b {y');
});

test('legenda hostil: "Format:" com milhares de colunas não multiplica o trabalho por fala', () => {
  const columns = `Format: ${'zz,'.repeat(20000)}Text`;
  const lines = Array.from({ length: 100000 }, () => 'Dialogue: 0,0,0');
  let cues;
  const ms = timed(() => { cues = F.parseAss(`[Events]\n${columns}\n${lines.join('\n')}`); });
  assert.ok(ms < BUDGET_MS, `parseAss levou ${ms.toFixed(0)} ms`);
  assert.deepEqual(cues, [], 'sem a coluna Start nada vira fala');
});

test('importar: mais falas que o limite não é uma legenda (TOO_BIG) e a mensagem fala de codificação quando não acha nada', () => {
  const many = Array.from({ length: F.MAX_IMPORT_CUES + 1 }, (_, i) => cue(i, i + 0.5, 'x'));
  assert.throws(() => F.parseSubtitleFile(F.cuesToSrt(many), '.srt'), (e) => e.code === 'TOO_BIG' && /falas demais/.test(e.message) && /20\.000/.test(e.message));
  assert.equal(F.parseSubtitleFile(F.cuesToSrt(many.slice(0, F.MAX_IMPORT_CUES)), '.srt').length, F.MAX_IMPORT_CUES);
  assert.throws(() => F.parseSubtitleFile('1\u0000\r\u0000\n\u0000', '.srt'), (e) => e.code === 'EMPTY' && /UTF-8, UTF-16 ou Windows-1252/.test(e.message));
});

// ---------- linha em branco no texto da fala ----------

test('fala com linha em branco no texto: o SRT não fica com bloco órfão (ida e volta mantém todo o texto)', () => {
  const original = [cue(0, 2, 'primeira linha\n\nsegunda linha'), cue(3, 4, 'a\n   \n\n b'), cue(5, 6, 'outra fala')];
  const srt = F.cuesToSrt(original, { maxChars: 40 });
  assert.ok(!/\n\n\S*$/.test(srt.split('\n\n')[0]) && srt.split('\n\n').length === 3, 'três blocos, sem linha vazia dentro de nenhum');
  for (const block of srt.trim().split('\n\n')) assert.ok(block.split('\n').every((l) => l.trim() !== ''), `bloco com linha vazia: ${JSON.stringify(block)}`);
  const back = F.parseSrt(srt);
  assert.deepEqual(back.map((c) => c.text), ['primeira linha\nsegunda linha', 'a\nb', 'outra fala'], 'nada se perde');
  assert.deepEqual(back.map((c) => [c.start, c.end]), [[0, 2], [3, 4], [5, 6]]);
  // no ASS (vídeo e arquivo .ass) a linha em branco continua: o \N faz o espaço
  const ass = F.cuesToAss([cue(0, 2, 'primeira linha\n\nsegunda linha')], {}, { width: 1080, height: 1920 });
  assert.ok(ass.includes('primeira linha\\N\\Nsegunda linha'));
  assert.deepEqual(F.parseAss(ass).map((c) => c.text), ['primeira linha\n\nsegunda linha']);
  // e o ASS importado com \N\N vai para SRT sem perder o resto
  const imported = F.parseAss(ass);
  assert.deepEqual(F.parseSrt(F.cuesToSrt(imported)).map((c) => c.text), ['primeira linha\nsegunda linha']);
});
