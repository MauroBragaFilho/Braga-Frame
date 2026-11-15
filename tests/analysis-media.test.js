'use strict';

/**
 * Análise com mídia SINTÉTICA de verdade: o ffmpeg gera vídeos com rajadas de áudio, cortes de luminância e
 * flashes em instantes conhecidos, e a análise tem que achar esses instantes (e não achar nada no ruído).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tools, skipMedia, mkTmp, rmrf, makeMedia, makeGatedAudio, makeChat, covers, peakNear } = require('./analysis-fixtures');
const { analyzeSource } = require('../src/core/analysis/analyze');
const { AnalysisCache } = require('../src/core/analysis/cache');
const { AnalysisManager } = require('../src/core/analysis/manager');
const { probeMedia } = require('../src/core/ffmpeg/probe');

const T = { skip: skipMedia };
let tmp;
const files = {};
let seq = 0;

/** spawn que conta (e deixa passar) as chamadas ao ffmpeg. */
function countingSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push(args); return childProcess.spawn(cmd, args, opts); };
  fn.calls = calls;
  fn.audio = () => calls.filter((a) => a.includes('0:a:0')).length;
  fn.image = () => calls.filter((a) => a.includes('0:v:0')).length;
  return fn;
}

const run = (file, { duration, hasAudio = true, params = {}, chatPath = null, transcript = null, ...deps } = {}) => analyzeSource(
  { file, duration, hasAudio, params, chatPath, transcript },
  { ffmpeg: tools.ffmpeg, cacheDir: path.join(tmp, `cache-${deps.cacheName || 'x'}-${seq++}`), ...deps }
);

test.before(() => {
  if (skipMedia) return;
  tmp = mkTmp('analysis-media');
  // áudio: fundo -50 dB, rajadas de 3 s a -20 dB em 20 e 41; imagem estática
  files.burst = makeMedia(path.join(tmp, 'burst.mp4'), { seconds: 60, audio: { baseDb: -50, bursts: [{ at: 20, dur: 3, db: -20 }, { at: 41, dur: 3, db: -20 }] } });
  // só ruído: fundo -40 dB com variação lenta de +-3 dB, sem nada acontecendo
  files.noise = makeMedia(path.join(tmp, 'noise.mp4'), { seconds: 120, audio: { baseDb: -40, wobbleDb: 3 } });
  // imagem: flash branco em 12,0-12,4, salto fraco de luminância em 25 (60->110) e forte em 40 (->210); áudio constante
  files.visual = makeMedia(path.join(tmp, 'visual.mp4'), {
    seconds: 60,
    audio: { baseDb: -50 },
    luma: { base: 60, steps: [{ at: 25, level: 110 }, { at: 40, level: 210 }], flashes: [{ at: 12, dur: 0.4, level: 235 }] }
  });
  // imagem: 8 s de chuvisco (movimento contínuo e intenso) de 30 a 38
  files.motion = makeMedia(path.join(tmp, 'motion.mp4'), { seconds: 60, audio: { baseDb: -50 }, luma: { base: 60, noise: [{ at: 30, dur: 8 }] } });
  // vídeo sem faixa de áudio
  files.silent = makeMedia(path.join(tmp, 'silent.mp4'), { seconds: 40, audio: null, luma: { base: 60, flashes: [{ at: 15, dur: 0.4, level: 235 }] } });
  // os três sinais no mesmo lance: rajada de áudio em 30-33, corte de luminância em 31,5
  files.combo = makeMedia(path.join(tmp, 'combo.mp4'), {
    seconds: 90,
    audio: { baseDb: -50, bursts: [{ at: 30, dur: 3, db: -20 }] },
    luma: { base: 60, steps: [{ at: 31.5, level: 200 }, { at: 33, level: 60 }] }
  });
  // faixa de áudio que começa 2 s depois do vídeo
  files.late = path.join(tmp, 'late.mp4');
  childProcess.execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=30', '-itsoffset', '2',
    '-f', 'lavfi', '-i', "anoisesrc=d=28:c=white:r=44100:a=1,volume='0.003+0.5*between(t,10,12)':eval=frame,aformat=channel_layouts=mono",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-map', '0:v', '-map', '1:a', files.late], { windowsHide: true });
});

test.after(() => { if (tmp) rmrf(tmp); });

test('áudio: acha as rajadas nos instantes certos, com motivos legíveis, e mais nada', T, async () => {
  const events = [];
  const r = await run(files.burst, { duration: 60, params: { signals: { image: false, chat: false } }, onProgress: (e) => events.push(e) });
  assert.equal(r.fromCache, false);
  assert.deepEqual(r.usedSignals, ['audio', 'calm']);
  assert.equal(r.suggestions.length, 2, JSON.stringify(r.suggestions));
  const [a, b] = [...r.suggestions].sort((x, y) => x.start - y.start);
  for (const [s, at] of [[a, 20], [b, 41]]) {
    assert.ok(Math.abs(s.peak - (at + 1.5)) <= 1.5, `pico em ${s.peak}, rajada ${at}-${at + 3}`);
    assert.ok(s.start <= at && s.end >= at + 3, `o trecho ${s.start}-${s.end} cobre a rajada ${at}-${at + 3}`);
    assert.ok(s.end - s.start >= 15 && s.end - s.start <= 60, 'durações vêm dos parâmetros (15 a 60 s)');
    assert.ok(s.relevance >= 0.7 && s.relevance < 0.8 + 1e-9, `relevância ${s.relevance}: o áudio sozinho vale, no máximo, o peso dele (0,8)`);
    assert.ok(s.reasons.some((x) => /^volume acima do normal de fala \(\+\d+ dB\)$/.test(x)), s.reasons.join('|'));
    assert.ok(s.reasons.some((x) => /^subida brusca de volume \(\+\d+ dB\)$/.test(x)), s.reasons.join('|'));
  }
  assert.ok(r.suggestions[0].relevance >= r.suggestions[1].relevance);
  // progresso: cresce, nunca passa de 1, termina em 1
  assert.ok(events.length >= 2);
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i].p >= events[i - 1].p - 1e-9, 'progresso monotônico');
  assert.equal(events.at(-1).p, 1);
});

test('áudio: ruído estacionário e variação lenta do fundo não geram sugestão (nem com sensibilidade máxima)', T, async () => {
  for (const sensitivity of [3, 5]) {
    const r = await run(files.noise, { duration: 120, params: { sensitivity, minRelevance: 0.05, signals: { image: false, chat: false } } });
    assert.deepEqual(r.suggestions, [], `sensibilidade ${sensitivity}`);
    assert.deepEqual(r.warnings, []);
  }
});

test('áudio: a faixa que começa atrasada mantém o tempo do vídeo', T, async () => {
  const r = await run(files.late, { duration: 30, params: { signals: { image: false, chat: false }, minDurationSec: 6 } });
  assert.equal(r.suggestions.length, 1);
  assert.ok(r.suggestions[0].peak >= 11.5 && r.suggestions[0].peak <= 14, `pico em ${r.suggestions[0].peak} (rajada no tempo do vídeo: 12-14)`);
});

test('imagem: flash e saltos de luminância viram pico perto dos instantes; sozinhos pesam menos (peso 0,6)', T, async () => {
  const lenient = await run(files.visual, { duration: 60, params: { signals: { audio: false, chat: false }, minRelevance: 0.3, minDurationSec: 6, maxSuggestions: 10 } });
  assert.deepEqual(lenient.usedSignals, ['image']);
  assert.ok(peakNear(lenient.suggestions, 12.5, 2), `flash: ${JSON.stringify(lenient.suggestions.map((s) => s.peak))}`);
  assert.ok(peakNear(lenient.suggestions, 25.5, 2), 'salto fraco em 25');
  assert.ok(peakNear(lenient.suggestions, 40.5, 2), 'salto forte em 40');
  assert.equal(lenient.suggestions.length, 3);
  assert.ok(lenient.suggestions.every((s) => s.reasons.includes('mudança de cena')));
  // com a relevância mínima padrão (0,5) o salto fraco fica de fora: imagem sozinha é evidência fraca
  const strict = await run(files.visual, { duration: 60, params: { signals: { audio: false, chat: false }, minDurationSec: 6 } });
  assert.equal(strict.suggestions.length, 2, JSON.stringify(strict.suggestions.map((s) => [s.peak, s.relevance])));
  assert.ok(peakNear(strict.suggestions, 12.5, 2) && peakNear(strict.suggestions, 40.5, 2));
  assert.equal(peakNear(strict.suggestions, 25.5, 2), undefined);
  // pesos configuráveis: com peso 2 o salto fraco também passa
  const heavy = await run(files.visual, { duration: 60, params: { signals: { audio: false, chat: false }, weights: { image: 2 }, minDurationSec: 6, minRelevance: 0.5 } });
  assert.equal(heavy.suggestions.length, 3);
});

test('imagem: movimento contínuo e intenso (chuvisco) vira sugestão com motivo de movimento', T, async () => {
  const r = await run(files.motion, { duration: 60, params: { signals: { audio: false, chat: false }, minDurationSec: 6, maxSuggestions: 5 } });
  assert.equal(r.suggestions.length, 1, JSON.stringify(r.suggestions));
  const s = r.suggestions[0];
  assert.ok(covers(s, 30, 1) && covers(s, 38, 1), `${s.start}-${s.end} cobre 30-38`);
  assert.ok(s.reasons.some((x) => /^movimento intenso na imagem \(\d+(,\d)?σ\)$/.test(x)), s.reasons.join('|'));
});

test('imagem em modo rápido (só quadros-chave) acha o flash com a precisão do intervalo de quadros-chave', T, async () => {
  const r = await run(files.visual, { duration: 60, params: { signals: { audio: false, chat: false }, image: { fast: true }, minRelevance: 0.3, minDurationSec: 6, maxSuggestions: 10 } });
  assert.ok(peakNear(r.suggestions, 12.5, 3.5), JSON.stringify(r.suggestions.map((s) => s.peak)));
  assert.equal(r.signals.image.used, true);
});

test('vídeo sem áudio: o sinal de áudio é ignorado com aviso, a imagem segue e nada quebra', T, async () => {
  const r = await run(files.silent, { duration: 40, hasAudio: false, params: { minRelevance: 0.3, minDurationSec: 6 } });
  assert.deepEqual(r.usedSignals, ['image']);
  assert.equal(r.signals.audio.used, false);
  assert.match(r.signals.audio.reason, /não tem faixa de áudio/);
  assert.ok(r.warnings.some((w) => w.code === 'NO_AUDIO' && /ignorado/.test(w.message)));
  assert.ok(peakNear(r.suggestions, 15.5, 2));
});

test('informação de áudio errada (diz que tem, mas não tem): o ffmpeg falha só nesse sinal, vira aviso e o resultado não é guardado em cache', T, async () => {
  const cacheDir = path.join(tmp, 'cache-wrong');
  const deps = { ffmpeg: tools.ffmpeg, cacheDir };
  const req = { file: files.silent, duration: 40, hasAudio: true, params: { minRelevance: 0.3, minDurationSec: 6 } };
  const r = await analyzeSource(req, deps);
  assert.deepEqual(r.usedSignals, ['image']);
  assert.ok(r.warnings.some((w) => w.code === 'AUDIO_FAILED' && /áudio/.test(w.message)), JSON.stringify(r.warnings));
  assert.equal(r.signals.audio.used, false);
  const again = await analyzeSource(req, deps);
  assert.equal(again.fromCache, false, 'resultado degradado não é reaproveitado');
  assert.equal(again.signals.image.cached, true, 'mas o que deu certo (imagem) continua em cache');
});

test('três sinais no mesmo lance: o trecho cobre o instante, a relevância é máxima e os motivos citam cada sinal', T, async () => {
  const chatPath = path.join(tmp, 'combo-chat.json');
  // reação do chat 6 s depois do lance (que está em 30-33): rajada em 36-44
  makeChat(chatPath, { duration: 90, baseRate: 0.3, bursts: [{ at: 36, dur: 8, rate: 6 }] });
  const r = await run(files.combo, { duration: 90, chatPath, params: { chat: { lagSec: 6, keywords: [] } } });
  assert.deepEqual(r.usedSignals, ['audio', 'image', 'chat', 'calm']);
  assert.equal(r.signals.chat.used, true);
  assert.ok(r.signals.chat.messages > 50);
  const hit = r.suggestions.find((s) => covers(s, 31.5));
  assert.ok(hit, JSON.stringify(r.suggestions));
  assert.ok(hit.relevance >= 0.99 && hit.relevance < 1, `relevância ${hit.relevance}: três sinais concordando, quase certeza, mas nunca 1,0`);
  assert.ok(hit.reasons.some((x) => /^volume acima do normal de fala/.test(x)));
  assert.ok(hit.reasons.some((x) => x === 'mudança de cena'));
  assert.ok(hit.reasons.some((x) => /^chat .*× a média$/.test(x)), hit.reasons.join('|'));
  assert.ok(hit.signals.audio > 0 && hit.signals.image > 0 && hit.signals.chat > 0);
  assert.equal(r.suggestions.length, 1, 'um único momento');
});

test('chat sozinho: o pico do chat vira sugestão deslocada pelo atraso; palavras-chave citadas no motivo', T, async () => {
  const chatPath = path.join(tmp, 'solo-chat.json');
  makeChat(chatPath, {
    duration: 90, baseRate: 0.3,
    bursts: [{ at: 50, dur: 8, rate: 6, text: 'clipa isso!!' }]
  });
  const r = await run(files.silent, { duration: 40, hasAudio: false, chatPath, params: { signals: { image: false }, chat: { lagSec: 6, windowSec: 10, keywords: ['clip'] } } }).catch((e) => e);
  // o vídeo "silent" só tem 40 s: a rajada em 50 s está fora e não pode gerar sugestão nem erro
  assert.ok(!(r instanceof Error), r && r.message);
  assert.deepEqual(r.suggestions, []);

  const long = await run(files.combo, { duration: 90, chatPath, params: { signals: { audio: false, image: false }, chat: { lagSec: 6, windowSec: 10, keywords: ['clip'] } } });
  assert.deepEqual(long.usedSignals, ['chat']);
  assert.equal(long.suggestions.length, 1);
  const s = long.suggestions[0];
  // rajada do chat em 50-58 -> lance por volta de 44-52 (atraso 6 s)
  assert.ok(covers(s, 47.5, 1), `${s.start}-${s.end}`);
  assert.ok(!covers(s, 62), 'o trecho não vai até a reação inteira do chat');
  assert.ok(s.reasons.some((x) => /^chat .*× a média$/.test(x)));
  assert.ok(s.reasons.some((x) => /^palavras-chave no chat: clip ×\d+/.test(x)), s.reasons.join('|'));
  // sem atraso, o trecho acompanha a reação do chat
  const noLag = await run(files.combo, { duration: 90, chatPath, params: { signals: { audio: false, image: false }, chat: { lagSec: 0, windowSec: 10, keywords: [] } } });
  assert.ok(covers(noLag.suggestions[0], 54, 0));
  assert.ok(noLag.suggestions[0].peak > s.peak, 'sem atraso o pico anda para frente');
});

test('sinais ausentes são só ignorados e a resposta diz por quê (sem chat, chat ilegível, tudo desligado)', T, async () => {
  const noChat = await run(files.burst, { duration: 60, params: { signals: { image: false } } });
  assert.equal(noChat.signals.chat.used, false);
  assert.match(noChat.signals.chat.reason, /não tem chat baixado/);
  assert.equal(noChat.suggestions.length, 2);

  const bad = path.join(tmp, 'chat-quebrado.json');
  fs.writeFileSync(bad, '{ isto não é json');
  const unreadable = await run(files.burst, { duration: 60, chatPath: bad, params: { signals: { image: false } } });
  assert.equal(unreadable.suggestions.length, 2, 'o chat ruim não impede os outros sinais');
  assert.equal(unreadable.signals.chat.used, false);
  assert.ok(unreadable.warnings.some((w) => w.code === 'CHAT_UNREADABLE' && /Novo projeto/.test(w.message)));

  await assert.rejects(run(files.burst, { duration: 60, params: { signals: { audio: false, image: false, chat: false } } }),
    (e) => e.code === 'NO_SIGNALS' && /Ligue ao menos um sinal/.test(e.message));
});

test('arquivo que não é mídia: NO_SIGNALS com explicação; ffmpeg inexistente: FFMPEG_START_FAILED', T, async () => {
  const bogus = path.join(tmp, 'falso.mp4');
  fs.writeFileSync(bogus, Buffer.alloc(4096, 7));
  await assert.rejects(run(bogus, { duration: 10, hasAudio: true }), (e) => e.code === 'NO_SIGNALS' && /FFmpeg/.test(e.message) && e.details && e.details.warnings.length === 2);
  await assert.rejects(analyzeSource({ file: files.burst, duration: 60, params: {} }, { ffmpeg: path.join(tmp, 'nao-existe.exe'), cacheDir: path.join(tmp, 'cache-nf') }),
    (e) => e.code === 'FFMPEG_START_FAILED' && /FFmpeg/.test(e.message));
});

test('cache: repetir não roda o ffmpeg; mudar sensibilidade/margens reaproveita os sinais; arquivo diferente recalcula', T, async () => {
  const cacheDir = path.join(tmp, 'cache-reuse');
  const spawn = countingSpawn();
  const base = { ffmpeg: tools.ffmpeg, cacheDir, spawn };
  const req = (params) => ({ file: files.burst, duration: 60, hasAudio: true, params });

  const first = await analyzeSource(req({}), base);
  assert.equal(first.fromCache, false);
  assert.deepEqual([spawn.audio(), spawn.image()], [1, 1]);

  const second = await analyzeSource(req({}), base);
  assert.equal(second.fromCache, true);
  assert.deepEqual([spawn.audio(), spawn.image()], [1, 1], 'resultado em cache: nenhum ffmpeg');
  assert.deepEqual(second.suggestions, first.suggestions);

  // outros parâmetros de combinação: recalcula a combinação, mas os sinais vêm do cache
  const other = await analyzeSource(req({ sensitivity: 5, padBeforeSec: 8, minDurationSec: 30, weights: { image: 1 } }), base);
  assert.equal(other.fromCache, false);
  assert.deepEqual([spawn.audio(), spawn.image()], [1, 1], 'nenhum ffmpeg novo');
  assert.equal(other.signals.audio.cached, true);
  assert.equal(other.signals.image.cached, true);
  assert.ok(other.suggestions.every((s) => s.end - s.start >= 30 - 1e-9));
  assert.notDeepEqual(other.suggestions.map((s) => [s.start, s.end]), first.suggestions.map((s) => [s.start, s.end]));

  // modo rápido da imagem: outra extração (só a imagem roda; o áudio continua em cache)
  await analyzeSource(req({ image: { fast: true } }), base);
  assert.deepEqual([spawn.audio(), spawn.image()], [1, 2]);

  // arquivo diferente (outro conteúdo/tamanho): cache não vale
  const copy = path.join(tmp, 'burst-copia.mp4');
  fs.copyFileSync(files.burst, copy);
  const copied = await analyzeSource({ ...req({}), file: copy }, base);
  assert.equal(copied.fromCache, true, 'mesma fonte copiada com outro nome: mesmo cache');
  fs.appendFileSync(copy, Buffer.alloc(16));
  const grown = await analyzeSource({ ...req({}), file: copy }, base);
  assert.equal(grown.fromCache, false, 'arquivo que cresceu é outra fonte');
  assert.deepEqual([spawn.audio(), spawn.image()], [2, 3]);

  // o cache respeita o limite e é só da análise
  assert.ok(fs.readdirSync(cacheDir).every((f) => /^(sig|res)-[a-z0-9-]+\.json$/.test(f)), 'só arquivos de cache nossos');
  assert.ok(new AnalysisCache(cacheDir).get('res', fs.readdirSync(cacheDir).find((f) => f.startsWith('res-')).slice(4, -5)));
});

test('cancelamento: encerra os ffmpeg, rejeita com CANCELLED e não deixa cache nem processo', T, async () => {
  const cacheDir = path.join(tmp, 'cache-cancel');
  const spawned = [];
  const exits = [];
  const priorities = [];
  const ctl = new AbortController();
  const started = Date.now();
  const promise = analyzeSource(
    { file: files.noise, duration: 120, hasAudio: true, params: {} },
    {
      ffmpeg: tools.ffmpeg,
      cacheDir,
      signal: ctl.signal,
      inputArgs: ['-re'], // lê na velocidade do vídeo: sem isto o teste terminaria antes de cancelar
      onSpawn: (child) => { spawned.push(child); exits.push(new Promise((resolve) => child.once('close', resolve))); },
      onProgress: (e) => {
        if (e.p > 0 && priorities.length === 0 && spawned[0]) {
          try { priorities.push(os.getPriority(spawned[0].pid)); } catch { priorities.push(null); }
        }
        if (e.p > 0 && !ctl.signal.aborted) setTimeout(() => ctl.abort(), 300);
      }
    }
  );
  await assert.rejects(promise, (e) => e.code === 'CANCELLED' && /cancelada/.test(e.message));
  // com '-re' a análise inteira levaria 2 min ou mais; cancelar tem que acontecer muito antes (o prazo aceita um computador ocupado)
  assert.ok(Date.now() - started < 90000, `cancelou em ${Date.now() - started} ms (a análise inteira levaria ~2 min)`);
  assert.ok(spawned.length >= 1);
  if (priorities[0] !== null && priorities[0] !== undefined) {
    assert.equal(priorities[0], os.constants.priority.PRIORITY_BELOW_NORMAL, 'o ffmpeg roda com prioridade abaixo do normal (não trava a interface nem uma live)');
  }
  await Promise.race([Promise.all(exits), new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg não encerrou')), 60000))]);
  for (const child of spawned) assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'processo encerrado');
  assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [], 'cancelar não grava cache');

  // já cancelado antes de começar: nem inicia o ffmpeg
  const pre = new AbortController();
  pre.abort();
  const spawn = countingSpawn();
  await assert.rejects(analyzeSource({ file: files.burst, duration: 60, params: {} }, { ffmpeg: tools.ffmpeg, cacheDir, signal: pre.signal, spawn }), (e) => e.code === 'CANCELLED');
  assert.equal(spawn.calls.length, 0);
});

/** Analisa pelo caminho real do app (ffprobe -> AnalysisManager -> analyzeSource) e devolve o resultado (ou o erro). */
function analyzeViaManager(file, params, cacheName) {
  const mgr = new AnalysisManager({ getTools: () => tools, cacheDir: path.join(tmp, `cache-mgr-${cacheName}-${seq++}`) });
  return new Promise((resolve, reject) => {
    mgr.once('done', ({ result }) => resolve(result));
    mgr.once('failed', (e) => reject(Object.assign(new Error(e.message), { code: e.code })));
    mgr.start({ path: file, params });
  });
}

test('duração fracionária (40,4 s) com rajada no fim: nenhuma sugestão termina depois do fim real do vídeo', T, async () => {
  const video = makeMedia(path.join(tmp, 'fracionario.mp4'), { seconds: 40.4, audio: { baseDb: -50, bursts: [{ at: 36, dur: 4, db: -20 }] } });
  const probed = await probeMedia(tools.ffprobe, video);
  assert.ok(probed.duration > 40.3 && probed.duration < 40.6, `o ffprobe diz ${probed.duration} s`);
  for (const [name, signals] of [['só áudio', { image: false, chat: false }], ['áudio e imagem', { chat: false }]]) {
    const r = await analyzeViaManager(video, { signals, minDurationSec: 6 }, 'frac');
    assert.equal(r.source.duration, probed.duration, `${name}: a duração do resultado é a do ffprobe, não a grade arredondada para cima (era 41)`);
    assert.ok(r.suggestions.length >= 1, name);
    for (const s of r.suggestions) {
      assert.ok(s.start >= 0 && s.end <= probed.duration + 1e-9, `${name}: sugestão ${s.start}-${s.end} passa do fim do vídeo (${probed.duration}); a exportação recusaria este corte`);
      assert.ok(s.peak <= probed.duration + 1e-9, `${name}: pico ${s.peak}`);
    }
    assert.ok(r.suggestions.some((s) => s.start <= 36 && s.end >= 40), `${name}: a rajada de 36 a 40 s está coberta: ${JSON.stringify(r.suggestions.map((s) => [s.start, s.end]))}`);
  }
});

test('ffmpeg que sai com erro depois de dar dados (resultado parcial): avisa, NÃO guarda o resultado e a análise seguinte lê tudo de novo', T, async () => {
  const cacheDir = path.join(tmp, 'cache-partial');
  // ffmpeg de verdade, mas o código de saída que a análise recebe é 1 (antivírus, disco, processo morto no fim da leitura)
  const flaky = (cmd, args, opts) => {
    const child = childProcess.spawn(cmd, args, opts);
    const on = child.on.bind(child);
    child.on = (event, cb) => (event === 'close' ? on('close', (_code, signal) => cb(1, signal)) : on(event, cb));
    return child;
  };
  const req = { file: files.burst, duration: 60, hasAudio: true, params: { signals: { image: false, chat: false } } };
  const first = await analyzeSource(req, { ffmpeg: tools.ffmpeg, cacheDir, spawn: flaky });
  assert.equal(first.fromCache, false);
  assert.ok(first.warnings.some((w) => w.code === 'AUDIO_PARTIAL'), JSON.stringify(first.warnings));
  assert.equal(first.suggestions.length, 2, 'o que deu para ler ainda rende sugestões');
  assert.deepEqual(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [], [], 'resultado incompleto não vai para o cache (nem o resultado final, nem o sinal)');

  const spawn = countingSpawn();
  const second = await analyzeSource(req, { ffmpeg: tools.ffmpeg, cacheDir, spawn });
  assert.equal(second.fromCache, false, 'a análise seguinte não herda o resultado incompleto');
  assert.deepEqual(second.warnings, []);
  assert.equal(spawn.audio(), 1, 'o vídeo foi lido de novo');
  const third = await analyzeSource(req, { ffmpeg: tools.ffmpeg, cacheDir, spawn });
  assert.equal(third.fromCache, true, 'o resultado completo, sim, é guardado');
  assert.equal(spawn.audio(), 1);
});

test('fresh: true ignora o resultado e os sinais guardados e lê o vídeo de novo (e o cache continua valendo depois)', T, async () => {
  const cacheDir = path.join(tmp, 'cache-fresh');
  const spawn = countingSpawn();
  const base = { ffmpeg: tools.ffmpeg, cacheDir, spawn };
  const req = { file: files.burst, duration: 60, hasAudio: true, params: { signals: { chat: false } } };
  const first = await analyzeSource(req, base);
  assert.deepEqual([first.fromCache, spawn.audio(), spawn.image()], [false, 1, 1]);
  assert.equal((await analyzeSource(req, base)).fromCache, true);
  assert.deepEqual([spawn.audio(), spawn.image()], [1, 1]);

  const again = await analyzeSource({ ...req, fresh: true }, base);
  assert.equal(again.fromCache, false);
  assert.deepEqual([spawn.audio(), spawn.image()], [2, 2], 'os dois sinais foram lidos de novo');
  assert.equal(again.signals.audio.cached, false);
  assert.deepEqual(again.suggestions.map((s) => [s.start, s.end]), first.suggestions.map((s) => [s.start, s.end]), 'mesmo vídeo, mesmas sugestões');
  assert.equal((await analyzeSource(req, base)).fromCache, true, 'o resultado refeito ficou guardado');
  assert.deepEqual([spawn.audio(), spawn.image()], [2, 2]);

  // também pelo AnalysisManager (o caminho do IPC)
  const mgr = new AnalysisManager({ getTools: () => tools, cacheDir, spawn });
  const run = (fresh) => new Promise((resolve, reject) => {
    mgr.once('done', ({ result }) => resolve(result));
    mgr.once('failed', (e) => reject(new Error(e.message)));
    mgr.start({ path: files.burst, params: { signals: { chat: false } }, ...(fresh ? { fresh: true } : {}) });
  });
  assert.equal((await run(false)).fromCache, true);
  assert.equal((await run(true)).fromCache, false);
  assert.deepEqual([spawn.audio(), spawn.image()], [3, 3]);
});

test('arquivo truncado (o ffmpeg sai sem erro): avisa até onde o áudio e a imagem foram lidos', T, async () => {
  const whole = makeMedia(path.join(tmp, 'completo.mkv'), { seconds: 40, audio: { baseDb: -50, bursts: [{ at: 12, dur: 3, db: -20 }] } });
  const cut = path.join(tmp, 'cortado.mkv');
  fs.writeFileSync(cut, fs.readFileSync(whole).subarray(0, Math.floor(fs.statSync(whole).size * 0.55)));
  const probed = await probeMedia(tools.ffprobe, cut);
  assert.ok(probed.duration > 39 && probed.duration < 41, `o cabeçalho ainda declara a duração inteira (${probed.duration} s)`);

  const r = await analyzeViaManager(cut, { minDurationSec: 6 }, 'trunc');
  assert.ok(r.suggestions.length >= 1, 'o que foi lido ainda rende sugestão');
  const audio = r.warnings.find((w) => w.code === 'AUDIO_SHORT');
  const image = r.warnings.find((w) => w.code === 'IMAGE_SHORT');
  assert.ok(audio && /até 0:2\d \(o vídeo tem 0:40\)/.test(audio.message), JSON.stringify(r.warnings));
  assert.ok(image && /a imagem até 0:2\d/.test(image.message), JSON.stringify(r.warnings));
  assert.ok(/incompleto/.test(audio.message) && /não foi analisado/.test(audio.message));
  assert.ok(!r.warnings.some((w) => /PARTIAL/.test(w.code)), 'o ffmpeg terminou sem erro: não é o caso do resultado parcial');

  // o arquivo inteiro, no mesmo formato, não gera aviso nenhum
  const ok = await analyzeViaManager(whole, { minDurationSec: 6 }, 'whole');
  assert.deepEqual(ok.warnings, []);
});

test('primeira faixa de áudio sem som (várias faixas): avisa que o áudio está mudo em vez de só não achar nada', T, async () => {
  const multi = path.join(tmp, 'multi.mkv');
  childProcess.execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=40',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=40',
    '-f', 'lavfi', '-i', "anoisesrc=d=40:c=white:r=44100:a=1,volume='0.003+0.5*between(t,20,23)':eval=frame,aformat=channel_layouts=mono",
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', multi], { windowsHide: true });
  const r = await analyzeViaManager(multi, { signals: { image: false, chat: false }, minDurationSec: 6 }, 'multi');
  assert.deepEqual(r.suggestions, [], 'a análise lê só a primeira faixa, que é muda');
  const silent = r.warnings.find((w) => w.code === 'AUDIO_SILENT');
  assert.ok(silent && /sem som/.test(silent.message) && /primeira faixa/.test(silent.message), JSON.stringify(r.warnings));
  // um áudio de verdade (fundo baixo, mas com som) não gera esse aviso
  const normal = await run(files.burst, { duration: 60, params: { signals: { image: false, chat: false } } });
  assert.ok(!normal.warnings.some((w) => w.code === 'AUDIO_SILENT'));
});

test('tudo desligado: NO_SIGNALS aponta os ajustes (não o FFmpeg); com leitura que falhou, aponta o FFmpeg', T, async () => {
  const off = await run(files.burst, { duration: 60, params: { signals: { audio: false, image: false, chat: false } } }).catch((e) => e);
  assert.equal(off.code, 'NO_SIGNALS');
  assert.match(off.message, /Ligue ao menos um sinal/);
  assert.doesNotMatch(off.message, /FFmpeg/, 'nada foi lido: o problema não é o FFmpeg');
  const bogus = path.join(tmp, 'falso2.mp4');
  fs.writeFileSync(bogus, Buffer.alloc(4096, 7));
  const failed = await run(bogus, { duration: 10, hasAudio: true }).catch((e) => e);
  assert.equal(failed.code, 'NO_SIGNALS');
  assert.match(failed.message, /FFmpeg consegue abrir o arquivo/);
});

test('o áudio é decodificado em fluxo: a memória do processo não cresce com a duração', T, async () => {
  const before = process.memoryUsage().rss;
  const r = await run(files.noise, { duration: 120, params: { signals: { image: false, chat: false } } });
  assert.deepEqual(r.suggestions, []);
  assert.ok(process.memoryUsage().rss - before < 150 * 1024 * 1024, 'sem crescimento absurdo de memória');
});

// ---------- recalibragem (v4): silêncio->fala, distribuição no tempo, texto ----------

const calmCues = (from, to) => {
  const list = [];
  const filler = ['hoje a gente vai explorar essa região do mapa', 'preciso encontrar uns materiais para construir a base', 'depois eu volto aqui para conferir o que sobrou',
    'acho que o servidor está mais estável do que ontem', 'vou testar essa ferramenta nova que eu consegui agora', 'amanhã eu penso em como organizar o baú todo'];
  for (let t = from, i = 0; t < to; t += 6, i += 1) list.push({ start: t, end: t + 5, text: `${filler[i % filler.length]} ${i}` });
  return list;
};

test('áudio de fala com porta de ruído: de silêncio para fala NÃO é destaque (nem a abertura, nem cada frase); um grito sustentado é', T, async () => {
  // 2 min de silêncio digital e fala "ligando e desligando" a cada 3 s: cada início de frase é um salto de ~70 dB sobre o silêncio anterior,
  // que a linha de base antiga lia como pico máximo (relevância 100%). O único destaque de verdade é o grito de 6 s em 300.
  const file = makeGatedAudio(path.join(tmp, 'porta.m4a'), { seconds: 420, silentUntil: 120, shouts: [{ at: 300, dur: 6 }] });
  const r = await run(file, { duration: 420, params: { signals: { image: false, chat: false } } });
  assert.deepEqual(r.usedSignals, ['audio', 'calm']);
  assert.equal(r.signals.text.used, false);
  assert.equal(r.suggestions.length, 1, JSON.stringify(r.suggestions));
  const s = r.suggestions[0];
  assert.ok(s.start <= 300 && s.end >= 306, `o grito de 300 a 306 está coberto: ${s.start}-${s.end}`);
  assert.ok(s.relevance >= 0.7 && s.relevance < 1, `${s.relevance}`);
  assert.ok(s.reasons.some((x) => /^volume acima do normal de fala/.test(x)), s.reasons.join('|'));
  assert.ok(!r.suggestions.some((x) => x.peak < 250), 'nada na abertura nem no começo da fala');
  // com o grito removido não sobra sugestão nenhuma (fala normal de ponta a ponta)
  const calm = makeGatedAudio(path.join(tmp, 'porta-calma.m4a'), { seconds: 420, silentUntil: 120 });
  const none = await run(calm, { duration: 420, params: { signals: { image: false, chat: false }, sensitivity: 5, minRelevance: 0.2 } });
  assert.deepEqual(none.suggestions, [], 'mesmo na sensibilidade máxima e com relevância mínima de 20%');
});

test('sugestões distribuídas no tempo: uma abertura cheia de gritos iguais não leva a cota inteira', T, async () => {
  // 30 min; 5 gritos iguais nos primeiros 4 min e 3 depois dos 10 min. Padrão de 6 por hora = 3 sugestões, no máximo 2 por janela de 10 min.
  const early = [60, 100, 140, 180, 220].map((at) => ({ at, dur: 6 }));
  const late = [700, 1200, 1500].map((at) => ({ at, dur: 6 }));
  const file = makeGatedAudio(path.join(tmp, 'distribuicao.m4a'), { seconds: 1800, silentUntil: 20, shouts: [...early, ...late] });
  const cacheDir = path.join(tmp, 'cache-distribuicao'); // os dois pedidos leem o áudio uma vez só
  const r = await run(file, { duration: 1800, cacheDir, params: { signals: { image: false, chat: false } } });
  assert.equal(r.limit, 3);
  assert.equal(r.suggestions.length, 3, JSON.stringify(r.suggestions.map((x) => [x.start, x.end, x.relevance])));
  const inFirstWindow = r.suggestions.filter((x) => x.peak < 600).length;
  assert.ok(inFirstWindow <= 2, `${inFirstWindow} sugestões nos primeiros 10 min`);
  assert.ok(r.suggestions.some((x) => x.peak > 600), 'ao menos uma vem de depois da abertura');
  // pedindo mais sugestões, os 8 gritos aparecem (cada um uma vez), espalhados por toda a duração
  const more = await run(file, { duration: 1800, cacheDir, params: { signals: { image: false, chat: false }, perHour: 20 } });
  assert.equal(more.suggestions.length, 8, JSON.stringify(more.suggestions.map((x) => x.start)));
  for (const shout of [...early, ...late]) assert.ok(more.suggestions.some((x) => x.start <= shout.at && x.end >= shout.at + 3), `grito em ${shout.at}`);
});

test('sinal de texto com transcrição sintética: exclamações, risada e ritmo viram sugestões alinhadas às falas, com motivos legíveis', T, async () => {
  // 2 min de áudio estacionário (nada para o áudio achar) + fala calma + um trecho animado em 40-62 + uma risada em 100
  const cues = calmCues(0, 40);
  const lively = ['Nossa, olha isso!', 'Não acredito!', 'Caralho, morri de novo!', 'Que foda, véi, que foda, véi!', 'Matem, matem!'];
  for (let t = 40, i = 0; t < 62; t += 3, i += 1) cues.push({ start: t, end: t + 2.5, text: `${lively[i % 5]} ${lively[(i + 1) % 5]} ${lively[(i + 2) % 5]}` });
  cues.push(...calmCues(62, 98), { start: 100, end: 102, text: '*Risos*', laugh: true }, ...calmCues(104, 120));
  const base = { duration: 120, params: { signals: { image: false, chat: false } } };
  const r = await run(files.noise, { ...base, transcript: { cues } });
  assert.deepEqual(r.usedSignals, ['audio', 'calm', 'text']);
  assert.equal(r.signals.text.used, true);
  assert.equal(r.signals.text.cues, cues.length);
  assert.equal(r.signals.text.laughs, 1);
  assert.deepEqual(r.warnings, []);
  const animated = r.suggestions.find((x) => covers(x, 50));
  assert.ok(animated, JSON.stringify(r.suggestions));
  assert.ok(animated.reasons.includes('exclamações e reações'), animated.reasons.join('|'));
  assert.ok(animated.reasons.some((x) => /^ritmo de fala acelerou/.test(x)), animated.reasons.join('|'));
  const laugh = r.suggestions.find((x) => covers(x, 95));
  assert.ok(laugh, 'o trecho que antecede a risada: ' + JSON.stringify(r.suggestions));
  assert.ok(laugh.reasons.includes('risada'), laugh.reasons.join('|'));
  assert.ok(laugh.end <= 106, `a sugestão termina logo depois da risada (${laugh.end})`);
  assert.equal(r.suggestions.length, 2, JSON.stringify(r.suggestions.map((x) => [x.start, x.end])));
  // alinhadas a falas: o início é começo de fala e o fim é fim de fala (a transcrição existe)
  for (const x of r.suggestions) {
    assert.ok(cues.some((c) => Math.abs(c.start - x.start) <= 0.06), `início ${x.start} não é começo de fala`);
    assert.ok(cues.some((c) => Math.abs(c.end - x.end) <= 0.06), `fim ${x.end} não é fim de fala`);
    assert.ok(x.end - x.start >= 15 - 1e-9 && x.end - x.start <= 60 + 1e-9, 'durações das preferências');
  }
  // peso 0 desliga o texto sem desligar o sinal; desligar o sinal também
  const off = await run(files.noise, { ...base, params: { ...base.params, weights: { text: 0 } }, transcript: { cues } });
  assert.deepEqual(off.suggestions, []);
  const disabled = await run(files.noise, { ...base, params: { signals: { image: false, chat: false, text: false } }, transcript: { cues } });
  assert.equal(disabled.signals.text.used, false);
  assert.equal(disabled.signals.text.reason, 'desligado');
  assert.deepEqual(disabled.suggestions, []);
});

test('perfil de humor do canal: um bordão numa fala calma vira sugestão com o motivo "expressão do canal"; sem o perfil não aparece nada', T, async () => {
  // 2 min de áudio estacionário + fala calma + "Beco moleque" em 60 (sem exclamação, sem repetição, sem fala sobre o momento: só o perfil o destaca)
  const cues = [...calmCues(0, 58), { start: 60, end: 62.5, text: 'Beco moleque' }, ...calmCues(66, 120)];
  const base = { duration: 120, params: { signals: { image: false, chat: false } } };
  const plain = await run(files.noise, { ...base, transcript: { cues } });
  assert.deepEqual(plain.suggestions, [], 'sem o perfil nada se destaca');
  assert.equal(plain.signals.text.humorHits, undefined, 'sem perfil o resultado não fala dele');
  const profile = { phrases: ['beco moleque'], reactions: [] };
  const r = await run(files.noise, { ...base, params: { ...base.params, humor: profile }, transcript: { cues } });
  assert.equal(r.signals.text.humorHits, 1);
  assert.equal(r.suggestions.length, 1, JSON.stringify(r.suggestions));
  const hit = r.suggestions[0];
  assert.ok(covers(hit, 61), `${hit.start}-${hit.end}`);
  assert.ok(hit.reasons.includes('expressão do canal: “beco moleque”'), hit.reasons.join('|'));
  assert.deepEqual(r.params.humor, profile, 'o perfil usado fica registrado no resultado');
  // peso 0 da pista desliga o perfil sem tirar o texto
  const off = await run(files.noise, { ...base, params: { ...base.params, humor: profile, textWeights: { humor: 0 } }, transcript: { cues } });
  assert.deepEqual(off.suggestions, []);
});

test('sem transcrição o algoritmo continua funcionando (áudio, imagem e chat), e a resposta diz que o texto foi ignorado e por quê', T, async () => {
  const none = await run(files.burst, { duration: 60, params: { signals: { image: false, chat: false } } });
  assert.deepEqual(none.usedSignals, ['audio', 'calm']);
  assert.equal(none.suggestions.length, 2);
  assert.equal(none.signals.text.used, false);
  assert.match(none.signals.text.reason, /não tem transcrição/);
  assert.deepEqual(none.warnings, []);
  const stale = await run(files.burst, { duration: 60, params: { signals: { image: false, chat: false } }, transcript: { cues: [], stale: true } });
  assert.equal(stale.signals.text.used, false);
  assert.match(stale.signals.text.reason, /outro arquivo/);
  assert.equal(stale.suggestions.length, 2);
  // só texto, sem áudio utilizável: ainda analisa
  const onlyText = await run(files.silent, { duration: 40, hasAudio: false, params: { signals: { image: false, chat: false } }, transcript: { cues: [...calmCues(0, 10), { start: 12, end: 14, text: 'Nossa, não acredito!' }, { start: 15, end: 17, text: 'Caralho, olha isso!' }, { start: 18, end: 20, text: 'Meu deus!' }, ...calmCues(24, 40)] } });
  assert.deepEqual(onlyText.usedSignals, ['text']);
  assert.ok(onlyText.suggestions.length >= 1);
});

test('cache: o resultado depende da transcrição (outra transcrição recalcula, a mesma reaproveita) e transcrição curta avisa', T, async () => {
  const cacheDir = path.join(tmp, 'cache-text');
  const spawn = countingSpawn();
  const base = { ffmpeg: tools.ffmpeg, cacheDir, spawn };
  const cuesA = [...calmCues(0, 100), { start: 100, end: 102, text: 'Nossa, não acredito!' }, { start: 103, end: 105, text: 'Caralho!' }, { start: 106, end: 108, text: 'Meu deus, olha isso!' }, ...calmCues(110, 120)];
  const cuesB = calmCues(0, 120);
  const req = (cues) => ({ file: files.noise, duration: 120, hasAudio: true, params: { signals: { image: false, chat: false } }, transcript: { cues } });
  const first = await analyzeSource(req(cuesA), base);
  assert.equal(first.fromCache, false);
  assert.equal(spawn.audio(), 1);
  assert.equal((await analyzeSource(req(cuesA), base)).fromCache, true, 'mesma transcrição: resultado guardado');
  const other = await analyzeSource(req(cuesB), base);
  assert.equal(other.fromCache, false, 'transcrição diferente: recalcula');
  assert.equal(other.signals.audio.cached, true, 'mas o áudio não é lido de novo');
  assert.equal(spawn.audio(), 1);
  assert.notDeepEqual(other.suggestions.map((x) => [x.start, x.end]), first.suggestions.map((x) => [x.start, x.end]));
  // transcrição que cobre só metade do vídeo avisa
  const half = await analyzeSource(req(calmCues(0, 60)), base);
  const warn = half.warnings.find((w) => w.code === 'TEXT_SHORT');
  assert.ok(warn && /cobre só 49% do vídeo \(até 0:59\)/.test(warn.message), JSON.stringify(half.warnings));
});
