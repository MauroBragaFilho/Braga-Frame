'use strict';

/**
 * Comportamento da aba Áudio (renderer/features/audio.js) com as regras reais (audioFilter/audioHistory) num contexto
 * isolado: medição que nunca mostra os números de outro corte, nada de ffmpeg com a aba escondida, prévia ajustada só
 * com a aba à vista, Ctrl+Z/Ctrl+Y do áudio e textos da barra de status. O DOM, a Web Audio e o relógio são falsos
 * (tests/audio-tab-fixtures.js); o som e o foco de verdade são conferidos em tests/e2e/audio.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, measureResult } = require('./audio-tab-fixtures');

const CUTS = [
  { id: 'a', title: 'Corte A', start: 0, end: 10 },
  { id: 'b', title: 'Corte B', start: 20, end: 30, audio: { gainDb: 5 } },
  { id: 'c', title: 'Corte C', start: 40, end: 50 }
];
const select = (env, id) => env.BF.bus.emit('cut:selected', { id });
const measureLine = (env) => env.cls('audio-measure').textContent;
const noteTexts = (env) => env.byClass('audio-note').map((n) => n.textContent);
const hasDistortion = (env) => noteTexts(env).some((t) => /distor/.test(t));
const setField = (env, id, value) => { const input = env.ui(id); input.value = String(value); input.fire('change'); };
const lastLog = (env) => env.logs[env.logs.length - 1].message;
const stored = (env, id) => env.BF.project.cut(id).audio;

// ---------- medição ----------

test('a medição de outro corte nunca aparece no corte selecionado (resposta atrasada, cache e troca de corte)', async () => {
  const env = await createEnv({ cuts: CUTS });
  await env.show();

  select(env, 'b'); // corte B: ganho +5 dB, trecho alto (pico -2 dB): 3 dB acima de 0 => aviso de distorção
  await env.advance(300);
  assert.equal(env.measureCalls.length, 1);
  await env.respond(0, measureResult(-2, -9));
  assert.match(measureLine(env), /pico -2,0 dB · média -9,0 dB/);
  assert.equal(hasDistortion(env), true);

  select(env, 'c'); // corte novo, ainda não medido
  await env.advance(300);
  assert.equal(env.measureCalls.length, 2);
  assert.deepEqual([env.measureCalls[1].payload.start, env.measureCalls[1].payload.end], [40, 50]);

  select(env, 'b'); // volta ao B (vem do cache) enquanto a medição do C ainda está no ffmpeg
  await env.advance(300);
  assert.match(measureLine(env), /pico -2,0 dB/);
  await env.respond(1, measureResult(-38, -41)); // chega a resposta atrasada do C (trecho baixo)
  assert.match(measureLine(env), /pico -2,0 dB · média -9,0 dB/, 'o B continua mostrando a medição DELE');
  assert.equal(hasDistortion(env), true, 'e o aviso de distorção do B não é falseado pelo pico do C');

  select(env, 'c'); // a resposta atrasada não foi perdida: está no cache e é a do C
  await env.advance(300);
  assert.equal(env.measureCalls.length, 2, 'não mede de novo');
  assert.match(measureLine(env), /pico -38,0 dB · média -41,0 dB/);
});

test('ao trocar de corte, a medição do corte anterior sai da tela na hora (sem esperar o ffmpeg do novo)', async () => {
  const env = await createEnv({ cuts: CUTS });
  await env.show();
  select(env, 'b');
  await env.advance(300);
  await env.respond(0, measureResult(-2, -9));
  assert.equal(hasDistortion(env), true);
  select(env, 'c');
  assert.equal(measureLine(env), 'Medindo o trecho…', 'antes mesmo do atraso de 250 ms e do ffmpeg');
  assert.equal(hasDistortion(env), false, 'o aviso de distorção do B também sai');
  await env.advance(300);
  assert.equal(measureLine(env), 'Medindo o trecho…');
});

test('mudar o trecho do corte descarta a medição velha e uma resposta atrasada dela', async () => {
  const env = await createEnv({ cuts: CUTS });
  await env.show();
  select(env, 'a');
  await env.advance(300);
  assert.equal(env.measureCalls.length, 1);

  env.BF.project.update((p) => { p.cuts[0].end = 12; }, { reason: 'review' }); // a revisão ajustou o fim do corte
  env.BF.bus.emit('cuts:changed', { ids: ['a'], from: 'review' });
  assert.equal(measureLine(env), 'Medindo o trecho…');
  await env.advance(300);
  assert.equal(env.measureCalls.length, 2);
  assert.deepEqual([env.measureCalls[1].payload.start, env.measureCalls[1].payload.end], [0, 12]);

  await env.respond(0, measureResult(-30, -33)); // resposta do trecho antigo (0 a 10 s)
  assert.equal(measureLine(env), 'Medindo o trecho…', 'a medição do trecho antigo não vale para o novo');
  await env.respond(1, measureResult(-6, -12));
  assert.match(measureLine(env), /pico -6,0 dB/);
});

test('uma falha de medição não gruda em outro corte', async () => {
  const env = await createEnv({ cuts: CUTS });
  await env.show();
  select(env, 'a');
  await env.advance(300);
  await env.respond(0, { ok: false, code: 'MEASURE_FAILED', message: 'O ffmpeg não conseguiu ler o áudio deste trecho: arquivo incompleto.' });
  assert.ok(noteTexts(env).some((t) => /Não foi possível medir o trecho: O ffmpeg não conseguiu ler/.test(t)));
  select(env, 'c');
  assert.equal(noteTexts(env).some((t) => /Não foi possível medir/.test(t)), false);
});

test('sem FFmpeg a aba avisa na hora e mede sozinha quando ele aparece (tools:changed)', async () => {
  const env = await createEnv({ cuts: CUTS, ffmpeg: null });
  await env.show();
  select(env, 'a');
  assert.ok(noteTexts(env).some((t) => /FFmpeg não foi encontrado/.test(t)));
  await env.advance(500);
  assert.equal(env.measureCalls.length, 0);
  env.BF.state.tools.ffmpeg = 'ffmpeg';
  env.BF.bus.emit('tools:changed', { tools: env.BF.state.tools });
  await env.advance(300);
  assert.equal(env.measureCalls.length, 1);
  assert.equal(noteTexts(env).some((t) => /FFmpeg não foi encontrado/.test(t)), false);
});

test('com a aba Áudio escondida nenhum ffmpeg é chamado, mesmo selecionando e ajustando cortes pelas outras abas', async () => {
  const env = await createEnv({ cuts: CUTS });
  for (const id of ['a', 'b', 'c', 'a', 'c']) { select(env, id); await env.advance(400); }
  for (let i = 0; i < 4; i += 1) {
    env.BF.project.update((p) => { p.cuts[0].end += 1; }, { reason: 'review' });
    env.BF.bus.emit('cuts:changed', { ids: ['a'], from: 'review' });
    await env.advance(400);
  }
  assert.equal(env.measureCalls.length, 0, 'seis seleções e quatro ajustes de tempo não geram nenhuma medição');

  await env.show(); // quem abre a aba vê a medição do corte atual (um único pedido)
  await env.advance(300);
  assert.equal(env.measureCalls.length, 1);
  assert.deepEqual([env.measureCalls[0].payload.start, env.measureCalls[0].payload.end], [40, 50]);
  await env.respond(0, measureResult(-8, -14));
  assert.match(measureLine(env), /pico -8,0 dB/);

  env.hide(); // saiu da aba: trocar de corte de novo não pede nada
  select(env, 'a');
  select(env, 'b');
  await env.advance(500);
  assert.equal(env.measureCalls.length, 1);
  assert.equal(env.counter.contexts, 0, 'só o corte B tem ajuste, mas selecioná-lo com a aba escondida não liga o áudio do player à Web Audio');
});

// ---------- prévia ----------

test('o áudio do player só passa pelo ajuste com a aba Áudio à vista (corte mudo não vira silêncio escondido)', async () => {
  const env = await createEnv({ cuts: [{ id: 'm', title: 'Mudo', start: 10, end: 20, audio: { mute: true } }], mutationObserver: true });
  env.video.currentTime = 12;
  env.video.paused = false;

  select(env, 'm'); // como ao dar "Ver" na aba Cortes: o corte mudo é selecionado com a aba Áudio escondida
  env.video.emit('playing');
  assert.equal(env.counter.contexts, 0, 'a aba escondida nem liga o áudio do player à Web Audio');

  await env.show(); // na aba Áudio o corte mudo soa mudo (é a prévia do que será exportado)
  assert.equal(env.counter.contexts, 1);
  assert.equal(env.gainNow(), 0);

  env.hide(); // trocou de aba: o som volta ao original na hora (o painel perdeu a visibilidade)
  env.observers[0]();
  assert.equal(env.gainNow(), 1);

  await env.show();
  assert.equal(env.gainNow(), 0, 'e ao voltar à aba, a prévia ajustada volta');
});

test('trocar de aba com o som tocando devolve o áudio original no próximo tempo do player', async () => {
  const env = await createEnv({ cuts: [{ id: 'm', title: 'Mudo', start: 10, end: 20, audio: { mute: true } }] });
  await env.show();
  select(env, 'm');
  env.video.currentTime = 12;
  env.video.paused = false;
  env.video.emit('playing');
  assert.equal(env.gainNow(), 0);
  env.hide(); // sem observador de atributos: quem avisa é o timeupdate do player
  env.video.emit('timeupdate');
  assert.equal(env.gainNow(), 1);
});

// ---------- Ctrl+Z / Ctrl+Y ----------

test('Ctrl+Z, Ctrl+Y e Ctrl+Shift+Z na aba Áudio desfazem e refazem o AJUSTE DE ÁUDIO, e não chegam à revisão', async () => {
  const env = await createEnv({ cuts: CUTS });
  const reviewSaw = []; // o atalho da revisão (cuts.js) ignora o que já teve preventDefault
  env.doc.addEventListener('keydown', (event) => { if (!event.defaultPrevented) reviewSaw.push(event.key); });
  await env.show();
  select(env, 'a');
  setField(env, 'audioGainNum', 6);
  assert.equal(stored(env, 'a').gainDb, 6);

  env.ui('audioMute').focus(); // foco num checkbox da aba: fora de campo de texto
  let event = env.key({ key: 'z' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(stored(env, 'a').gainDb, 0, 'Ctrl+Z desfez o ganho');
  assert.equal(lastLog(env), 'Desfeito: Ganho +6 dB.');

  env.key({ key: 'y' });
  assert.equal(stored(env, 'a').gainDb, 6, 'Ctrl+Y refez');
  env.key({ key: 'Z', shiftKey: true });
  assert.equal(stored(env, 'a').gainDb, 6, 'nada a refazer: continua 6');
  assert.equal(lastLog(env), 'Nada para refazer no áudio deste corte.');
  env.key({ key: 'z', ctrlKey: false, metaKey: true }); // Cmd+Z (macOS)
  assert.equal(stored(env, 'a').gainDb, 0);
  env.key({ key: 'Z', shiftKey: true }); // Ctrl+Shift+Z refaz
  assert.equal(stored(env, 'a').gainDb, 6);

  // o controle deslizante também não é um campo de texto
  env.ui('audioGain').focus();
  env.key({ key: 'z' });
  assert.equal(stored(env, 'a').gainDb, 0);
  assert.deepEqual(reviewSaw, [], 'nenhum Ctrl+Z/Y chegou à revisão');
  const adjusts = env.events.filter(([evt, d]) => evt === 'decision' && d.scope === 'audio');
  assert.ok(adjusts.length >= 5, 'cada desfazer/refazer também avisa o app (decision adjust do áudio)');
});

test('Ctrl+Z sem nada a desfazer no áudio não desfaz a revisão por baixo dos panos', async () => {
  const env = await createEnv({ cuts: CUTS });
  const reviewSaw = [];
  env.doc.addEventListener('keydown', (event) => { if (!event.defaultPrevented) reviewSaw.push(event.key); });
  await env.show();
  const event = env.key({ key: 'z' }); // nenhum corte escolhido
  assert.equal(event.defaultPrevented, true);
  assert.equal(lastLog(env), 'Nada para desfazer no áudio deste corte.');
  select(env, 'c');
  env.key({ key: 'z' });
  assert.equal(lastLog(env), 'Nada para desfazer no áudio deste corte.');
  assert.deepEqual(reviewSaw, []);
});

test('o atalho do áudio não interfere em campo de texto, com a aba escondida, com modal aberto nem com Alt', async () => {
  const env = await createEnv({ cuts: CUTS });
  const reviewSaw = [];
  env.doc.addEventListener('keydown', (event) => { if (!event.defaultPrevented) reviewSaw.push(event.key); });
  await env.show();
  select(env, 'a');
  setField(env, 'audioGainNum', 6);

  env.ui('audioGainNum').focus(); // campo numérico: vale o desfazer do próprio campo
  assert.equal(env.key({ key: 'z' }).defaultPrevented, false);
  assert.equal(stored(env, 'a').gainDb, 6);

  env.ui('audioMute').focus();
  assert.equal(env.key({ key: 'z', altKey: true }).defaultPrevented, false);
  env.modal = {}; // um modal do app está aberto
  assert.equal(env.key({ key: 'z' }).defaultPrevented, false);
  env.modal = null;
  env.hide(); // outra aba aberta: o atalho é da revisão
  assert.equal(env.key({ key: 'z' }).defaultPrevented, false);
  assert.equal(stored(env, 'a').gainDb, 6);
  assert.deepEqual(reviewSaw, ['z', 'z', 'z', 'z']);
});

// ---------- barra de status ----------

test('a barra de status conta o que aconteceu: desfeito, refeito, restaurado', async () => {
  const env = await createEnv({ cuts: CUTS });
  await env.show();
  select(env, 'a');
  setField(env, 'audioGainNum', 6);
  assert.equal(lastLog(env), 'Áudio do corte: Ganho +6 dB.');

  env.ui('audioUndo').click();
  assert.equal(stored(env, 'a').gainDb, 0);
  assert.equal(lastLog(env), 'Desfeito: Ganho +6 dB.', 'o ganho voltou a 0 e a mensagem diz que foi desfeito');

  env.ui('audioRedo').click();
  assert.equal(stored(env, 'a').gainDb, 6);
  assert.equal(lastLog(env), 'Refeito: Ganho +6 dB.');

  env.ui('audioMute').checked = true;
  env.ui('audioMute').fire('change');
  assert.equal(lastLog(env), 'Áudio do corte: Mudo ligado.');
  const restoreButtons = env.byClass('audio-restore');
  restoreButtons[restoreButtons.length - 1].click(); // a entrada mais antiga: Ganho +6 dB
  assert.equal(lastLog(env), 'Restaurado: Ganho +6 dB.');
  assert.equal(stored(env, 'a').mute, false);

  env.ui('audioReset').click();
  assert.equal(lastLog(env), 'Áudio do corte: Voltar ao original.');
});
