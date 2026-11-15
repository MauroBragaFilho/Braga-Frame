'use strict';

/**
 * PERFIL DE CONVERSA da análise (params.profile = 'conversa'; docs/recursos/analysis.md, "Perfil de conversa"): repetição só como laço,
 * pista de estrutura, imagem que ignora as trocas de câmera, cortes em frase completa e duração de 30 a 75 s. E o perfil de gameplay
 * (o padrão) continua calculando exatamente como antes. Funções puras sobre falas e sinais sintéticos com horários conhecidos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const params = require('../src/core/analysis/params');
const { scoreText, extractEvents, loopRepeats, structureUnits } = require('../src/core/analysis/textSignal');
const { scoreImage } = require('../src/core/analysis/imageSignal');
const { analyzeSource, sentenceBounds, CONVERSA_MIN_SEC, CONVERSA_MAX_SEC } = require('../src/core/analysis/analyze');

const TH = params.thresholds(3);
const cue = (start, end, text) => ({ start, end, text });
const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
const maxIn = (series, from, to) => { let m = 0; for (let k = Math.max(0, from); k <= Math.min(series.length - 1, to); k += 1) if (series[k] > m) m = series[k]; return m; };

/** Conversa calma: uma fala de 8 palavras a cada 6 s, sem laço, sem conselho, sem pergunta. */
function chat(from, seconds) {
  const lines = ['a gente estava falando sobre o bairro onde eu cresci', 'tinha muita coisa acontecendo naquela rua na frente de casa',
    'o pessoal se reunia no fim da tarde para conversar', 'cada um trazia uma novidade diferente da semana inteira',
    'o mercado da esquina vendia de tudo um pouco', 'depois a gente ia embora cedo por causa do calor'];
  const out = [];
  for (let t = from, i = 0; t < from + seconds; t += 6, i += 1) out.push(cue(t, t + 5, `${lines[i % lines.length]}.`));
  return out;
}

test('laço: a mesma frase como miolo de várias falas em ~25 s conta; hesitação, ênfase e assunto repetido não', () => {
  const cues = [
    cue(10, 11, 'Obrigado você.'), cue(11.5, 12.5, 'Obrigado você, Carlos.'), cue(13, 14, 'Não, cara, obrigado você.'),
    cue(40, 46, 'Eu trabalhei numa agência de marketing, mas era uma agência de marketing que trabalhava pouco o digital.'),
    cue(60, 64, 'A gente fica muito nessa de rede social, rede social, rede social.'),
    cue(80, 84, 'Porque você fazer rede social para um restaurante'), cue(84, 88, 'é diferente de fazer rede social para uma loja de carros'),
    cue(88, 92, 'e é diferente de fazer rede social para um mercado.')
  ];
  const loops = loopRepeats(cues);
  assert.deepEqual([...loops.keys()].sort(), [0, 1, 2], 'só as três falas do "obrigado você"');
  const ev = extractEvents(cues, 120, null, 'conversa');
  assert.ok(ev.repeat[10] > 0 && ev.repeat[11] > 0 && ev.repeat[13] > 0);
  assert.equal(sum(ev.repeat.slice(30)), 0, 'nada de repetição fora do laço');
  // o gameplay continua lendo a repetição como sempre: a hesitação e a ênfase contam lá
  const game = extractEvents(cues, 120);
  assert.ok(game.repeat[40] > 0 || game.repeat[60] > 0, 'no gameplay a repetição colada ainda conta');
});

test('laço: frase que o vídeo inteiro repete é jeito de falar, não laço', () => {
  const cues = [];
  for (let t = 0; t < 1200; t += 20) cues.push(cue(t, t + 2, 'com certeza, né.'), cue(t + 3, t + 4, 'com certeza, né.'), cue(t + 5, t + 6, 'com certeza, né.'));
  assert.equal(loopRepeats(cues).size, 0);
});

test('estrutura: conselho vale 1; história, opinião e pergunta seguida de resposta valem 0,5; pergunta sem resposta não vale', () => {
  const cues = [
    cue(10, 14, 'Primeiro de tudo, se você já acredita, você já deu dez passos à frente.'),
    cue(30, 34, 'Quando eu era criança, teve um dia que a gente fugiu da igreja.'),
    cue(50, 54, 'Eu acredito que a gente precisa valorizar a nossa cultura.'),
    cue(70, 72, 'Qual é o alimento regional que você mais gosta?'),
    cue(72.5, 80, 'A farofa de banana é um clássico daqui que todo mundo ama, com certeza.'),
    cue(80.2, 88, 'Juntando com o peixe e a mandioca, pra mim é incrível.'),
    cue(200, 202, 'E aí, tudo bem?')
  ];
  const units = structureUnits(cues);
  assert.equal(units.get(0), 1, 'conselho');
  assert.equal(units.get(1), 0.5, 'história');
  assert.equal(units.get(2), 1.5, '"eu acredito" é opinião (0,5) e "acredit-" também conta como conselho (1)');
  assert.equal(units.get(3), 0.5, 'pergunta com resposta logo depois');
  assert.equal(units.has(6), false, 'pergunta sem resposta');
});

test('scoreText: a estrutura só existe no perfil de conversa e aparece no motivo; o laço tem motivo próprio', () => {
  const advice = [...chat(0, 200), cue(204, 208, 'O meu conselho é: estudem muito, porque tudo no marketing é evolução.'),
    cue(208, 212, 'Tem que acordar cedo, tem que pensar no seu sonho.'), ...chat(214, 200)];
  const game = scoreText({ cues: advice }, { n: 420, th: TH });
  assert.equal(maxIn(game.parts.structure, 0, 419), 0, 'gameplay: sem estrutura');
  const conv = scoreText({ cues: advice }, { n: 420, th: TH, profile: 'conversa' });
  assert.ok(maxIn(conv.parts.structure, 195, 220) > 0.08, 'conversa: estrutura em volta do conselho (pista branda de propósito: na live medida ela não mudou o resultado)');
  assert.ok(maxIn(conv.parts.structure, 0, 150) < 0.05, 'e não no papo calmo');
  assert.ok(conv.describe(200, 215).some((r) => r.text === 'conselho, história ou opinião'));
  const off = scoreText({ cues: advice }, { n: 420, th: TH, profile: 'conversa', textWeights: { structure: 0 } });
  assert.ok(maxIn(off.score, 195, 220) < maxIn(conv.score, 195, 220), 'peso 0 desliga a pista');

  const loop = [...chat(0, 100), cue(100, 101, 'A satisfação foi toda minha.'), cue(101.5, 103, 'Por favor, a satisfação foi toda minha.'),
    cue(103.5, 105, 'A satisfação foi toda minha.'), ...chat(106, 100)];
  const conv2 = scoreText({ cues: loop }, { n: 220, th: TH, profile: 'conversa' });
  assert.ok(conv2.describe(95, 110).some((r) => r.text === 'laço de repetição (bordão)'));
});

test('scoreImage: no perfil de conversa a troca de câmera não pontua, nem o movimento colado a ela; o resto do movimento sim', () => {
  const n = 120;
  const scene = new Array(n).fill(0);
  const motion = new Array(n).fill(2);
  for (const k of [20, 40, 60]) { scene[k] = 60; motion[k] = 30; motion[k + 1] = 25; } // trocas de câmera (com fusão)
  for (let k = 90; k < 96; k += 1) motion[k] = 30; // alguém levanta e gesticula por 6 s
  const extracted = { seconds: n, scene, motion, fast: false, partial: false };
  const game = scoreImage(extracted, { n, th: TH, baselineSec: 600 });
  const conv = scoreImage(extracted, { n, th: TH, baselineSec: 600, ignoreCuts: true });
  assert.ok(game.score[20] > 0.5, 'gameplay: mudança de cena pontua');
  assert.ok(maxIn(conv.score, 15, 65) < 0.01, 'conversa: as trocas e o movimento delas não pontuam');
  assert.ok(maxIn(conv.score, 90, 95) > 0.3, 'conversa: movimento de verdade, longe das trocas, ainda pontua');
  assert.ok(!conv.describe(15, 65).some((r) => r.text === 'mudança de cena'));
});

test('limites de frase: o corte começa depois de um ponto e termina em ponto, nunca numa pergunta; sem pontuação, fica o de sempre', () => {
  const cues = [cue(0, 2, 'Você poderia dar uma dica?'), cue(2, 5, 'Olha, Paulo,'), cue(5, 9, 'faça acontecer.'), cue(9, 12, 'Venha aqui')];
  const b = sentenceBounds(cues);
  assert.deepEqual(b.starts, [0, 2, 9]);
  assert.deepEqual(b.ends, [9, 12], 'a pergunta não fecha corte; a última fala fecha');
  assert.ok(b.reach.endForward > 4, 'o fim de frase pode estar mais longe que o fim de fala');
  assert.equal(sentenceBounds([cue(0, 2, 'sem pontuação nenhuma'), cue(2, 4, 'legenda automática do youtube'), cue(4, 6, 'continua assim')]), null);
});

test('analyzeSource (só texto, sem ffmpeg): no perfil de conversa os cortes têm 30 a 75 s e terminam em frase; o gameplay não muda', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-conversa-'));
  const file = path.join(tmp, 'live.mp4');
  fs.writeFileSync(file, 'só texto: o arquivo não é lido (sinais de áudio e imagem desligados), mas a chave do cache vem dele');
  try {
    const cues = [...chat(0, 300),
      cue(300, 303, 'E qual é o conselho que você deixa para quem está começando?'),
      cue(303.5, 310, 'Primeiro de tudo, se você já acredita, você já deu dez passos à frente de muita gente.'),
      cue(310.5, 316, 'Tem que acordar cedo, tem que ir trabalhar, mas tem que pensar no seu sonho.'),
      cue(316.5, 319, 'Faça acontecer.'),
      cue(319.5, 321, 'Obrigado você.'), cue(321.5, 323, 'Obrigado você, cara.'), cue(323.5, 325, 'Não, obrigado você.'),
      ...chat(326, 300)];
    const request = (profile) => ({
      file, duration: 630, hasAudio: false, transcript: { cues },
      params: { profile, signals: { audio: false, image: false, chat: false, calm: false, text: true }, sensitivity: 4 }
    });
    const deps = { ffmpeg: path.join(tmp, 'sem-ffmpeg.exe'), cacheDir: path.join(tmp, 'cache') };
    const conv = await analyzeSource(request('conversa'), deps);
    assert.ok(conv.suggestions.length >= 1, 'o trecho do conselho vira sugestão');
    const best = conv.suggestions[0];
    assert.ok(best.start <= 303.5 && best.end >= 316, `o conselho inteiro fica dentro (${best.start}–${best.end})`);
    for (const s of conv.suggestions) {
      assert.ok(s.end - s.start >= CONVERSA_MIN_SEC - 0.5 && s.end - s.start <= CONVERSA_MAX_SEC + 0.5, `duração de conversa (${s.end - s.start})`);
    }
    const endsAt = new Set(cues.map((c) => c.end));
    assert.ok(endsAt.has(best.end), 'termina no fim de uma fala');
    assert.ok(!/\?$/.test(cues.find((c) => c.end === best.end).text), 'e não numa pergunta');

    const game = await analyzeSource(request('gameplay'), deps);
    for (const s of game.suggestions) assert.ok(s.end - s.start <= 60 + 0.5, 'gameplay: as durações de sempre');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
