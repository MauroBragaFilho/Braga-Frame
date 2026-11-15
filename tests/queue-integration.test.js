'use strict';

/**
 * Fila + motor de exportação REAL (src/core/export/jobRunner.js e qc.js) + ffmpeg/ffprobe de verdade, com
 * vídeo gerado pelo próprio teste (lavfi). Nada de executor falso aqui: prova que a fila e o motor combinam
 * (progresso, cancelamento que mata o processo, .part limpo, conflitos sem sobrescrever, interrupção).
 * Pulado, com o motivo, se faltar ffmpeg/ffprobe ou o jobRunner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { probeMedia } = require('../src/core/ffmpeg/probe');
const { makeSampleVideo } = require('./e2e/helpers');
const h = require('./queue-helpers');

const tools = locateTools();
let real = null;
try { real = { ...require('../src/core/export/jobRunner'), ...require('../src/core/export/qc') }; } catch { /* sem o motor: pula */ }
const skip = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : (!real || !real.runExportJob || !real.preflight ? 'src/core/export/jobRunner.js ou qc.js ainda não existem' : false);

const { waitUntil, makeManager, stateOf } = h;
const T = { skip, timeout: 120000 };

const PROFILE = { id: 'teste-360', name: 'Teste 360×640', kind: 'custom', width: 360, height: 640, codec: 'h264', bitrateKbps: 1500, encoder: 'software', fps: 'source', container: 'mp4' };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Ambiente: pasta temporária, vídeo de origem real e um gerenciador com o motor real (que também guarda os pids do ffmpeg). */
function withReal(fn, { seconds = 20, size = '640x360', profile = PROFILE } = {}) {
  return async () => {
    const dir = h.tmpDir('queue-real');
    const pids = [];
    const managers = [];
    try {
      const source = path.join(dir, 'fonte.mp4');
      makeSampleVideo(tools.ffmpeg, source, { seconds, size, rate: 30 });
      const runner = (job, opts) => real.runExportJob(job, { ...opts, onStart: ({ pid }) => pids.push(pid) });
      const mk = (extra = {}) => {
        const m = makeManager(dir, { runner, preflight: real.preflight, tools, ...extra });
        managers.push(m);
        return m;
      };
      const job = (i, extra = {}) => ({
        id: `real-${i}`, projectId: 'p-real', projectTitle: 'fonte', sourcePath: source,
        sourceInfo: { width: Number(size.split('x')[0]), height: Number(size.split('x')[1]), fps: 30, duration: seconds, hasAudio: true },
        cut: { id: `cut-${i}`, title: `Corte ${i}`, start: 1 + i * 3, end: 4 + i * 3, revision: 1, audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, subtitles: null, framing: null },
        profile: { ...profile }, framing: null, outputDir: path.join(dir, 'Cortes'), baseName: `corte ${i}`, onConflict: 'ask', createdAt: new Date().toISOString(), ...extra
      });
      await fn({ dir, source, mk, job, pids });
    } finally {
      for (const m of managers) m.shutdown();
      await h.sleep(500);
      h.removeDir(dir);
    }
  };
}

test('exporta de verdade (2 em paralelo), com progresso e arquivos válidos (9:16, duração certa, com áudio, sem .part)', T, withReal(async ({ dir, mk, job }) => {
  const q = mk().load();
  const progress = h.collect(q, 'progress');
  const done = h.collect(q, 'jobDone');
  q.setSettings({ parallel: 2 });
  q.enqueue([job(0), job(1), job(2)]);
  await waitUntil(() => q.jobs.every((j) => j.state === 'done'), { timeout: 90000, what: 'as 3 exportações terminarem' });

  assert.equal(done.length, 3);
  assert.ok(progress.length > 0 && progress.every((e) => e.p >= 0 && e.p <= 1), 'progresso do ffmpeg chegou à fila');
  for (const j of q.jobs) {
    assert.ok(fs.existsSync(j.output), j.output);
    const info = await probeMedia(tools.ffprobe, j.output);
    assert.deepEqual([info.width, info.height, info.videoCodec, info.hasAudio], [360, 640, 'h264', true]);
    assert.ok(Math.abs(info.duration - 3) < 0.4, `duração ${info.duration}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Cortes')).filter((f) => !f.endsWith('.mp4')), [], 'nada além dos .mp4 (sem .part)');
  assert.deepEqual(done.map((d) => d.output).sort(), q.jobs.map((j) => j.output).sort(), 'um jobDone por arquivo gerado (a ordem de término pode variar com 2 em paralelo)');

  // o mesmo trabalho de novo é pulado sem tocar no ffmpeg
  const [again] = q.enqueue([job(0, { id: 'real-0-de-novo' })]);
  assert.equal(again.state, 'skipped');
  assert.equal(again.skippedCode, 'ALREADY_DONE');
}));

test('cancelar no meio de uma exportação real mata o ffmpeg e não deixa .part nem arquivo pela metade', T, withReal(async ({ dir, mk, job, pids }) => {
  const q = mk().load();
  q.enqueue([job(0, { cut: { id: 'longo', title: 'Longo', start: 0, end: 55, revision: 1 } }), job(1)]);
  await waitUntil(() => q.jobs[0].state === 'running' && q.jobs[0].progress > 0.02, { timeout: 60000, what: 'a primeira exportação andar' });
  assert.equal(pids.length, 1);
  assert.ok(pidAlive(pids[0]), 'o ffmpeg está rodando');
  const partFile = fs.readdirSync(path.join(dir, 'Cortes')).find((f) => f.endsWith('.part'));
  assert.ok(partFile, 'durante a exportação existe um .part');

  q.cancel({ id: q.jobs[0].id });
  await waitUntil(() => q.jobs[0].state === 'cancelled', { timeout: 20000 });
  await waitUntil(() => !pidAlive(pids[0]), { timeout: 10000, what: 'o ffmpeg morrer' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Cortes')).filter((f) => f.endsWith('.part')), [], '.part limpo');
  assert.ok(!fs.readdirSync(path.join(dir, 'Cortes')).some((f) => f.includes('corte 0')), 'nenhum arquivo do corte cancelado');
  assert.notEqual(q.jobs[1].state, 'queued', 'o próximo da fila assumiu a vaga assim que o cancelamento terminou');
  assert.ok(['running', 'done'].includes(q.jobs[1].state), q.jobs[1].state);
  await waitUntil(() => q.jobs[1].state === 'done', { timeout: 60000 });
}, { seconds: 60, size: '1280x720', profile: { ...PROFILE, width: 1080, height: 1920, bitrateKbps: 12000 } }));

test('pausar e interromper com o ffmpeg real: o job volta à fila ao retomar e termina do início, com arquivo válido', T, withReal(async ({ dir, mk, job, pids }) => {
  const q = mk().load();
  q.enqueue([job(0, { cut: { id: 'longo', title: 'Longo', start: 0, end: 25, revision: 1 } })]);
  await waitUntil(() => q.jobs[0].state === 'running' && q.jobs[0].progress > 0.02, { timeout: 60000 });
  q.pause({ interrupt: true });
  await waitUntil(() => q.jobs[0].state === 'interrupted', { timeout: 20000 });
  await waitUntil(() => !pidAlive(pids[0]), { timeout: 10000 });
  assert.equal(q.jobs[0].progress, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Cortes')), [], 'nada sobra no destino');
  await h.sleep(300);
  assert.equal(pids.length, 1, 'pausada: o ffmpeg não recomeça sozinho');

  q.resume();
  await waitUntil(() => q.jobs[0].state === 'done', { timeout: 100000 });
  assert.equal(pids.length, 2, 'recomeçou do início com um ffmpeg novo (não é suspensão)');
  const info = await probeMedia(tools.ffprobe, q.jobs[0].output);
  assert.ok(Math.abs(info.duration - 25) < 0.5, `duração ${info.duration}`);
}, { seconds: 30, size: '1280x720', profile: { ...PROFILE, width: 1080, height: 1920, bitrateKbps: 12000 } }));

test('conflito de nome com o motor real: pergunta; "outro nome" e "pular" preservam o arquivo; "substituir" só troca depois do sucesso', T, withReal(async ({ dir, mk, job }) => {
  const q = mk().load();
  const conflicts = h.collect(q, 'conflict');
  const outDir = path.join(dir, 'Cortes');
  fs.mkdirSync(outDir, { recursive: true });
  const mine = (n) => path.join(outDir, `corte ${n}.mp4`);
  for (const n of [0, 1, 2]) fs.writeFileSync(mine(n), `ARQUIVO DO USUARIO ${n}`);

  q.enqueue([job(0), job(1), job(2)]);
  await waitUntil(() => conflicts.length === 3, { what: 'os 3 conflitos' });
  assert.deepEqual(q.jobs.map((j) => j.state), ['needsAction', 'needsAction', 'needsAction']);
  await h.sleep(100);
  assert.equal(fs.readFileSync(mine(0), 'utf8'), 'ARQUIVO DO USUARIO 0', 'nada foi tocado antes da decisão');

  q.resolveConflict('real-0', 'rename');
  q.resolveConflict('real-1', 'skip');
  q.resolveConflict('real-2', 'replace');
  await waitUntil(() => ['done', 'skipped'].includes(q.jobs[0].state) && q.jobs[1].state === 'skipped' && q.jobs[2].state === 'done', { timeout: 60000 });

  assert.equal(q.jobs[0].output, path.join(outDir, 'corte 0 (2).mp4'));
  assert.equal(fs.readFileSync(mine(0), 'utf8'), 'ARQUIVO DO USUARIO 0', 'renomear não mexe no original');
  assert.equal((await probeMedia(tools.ffprobe, q.jobs[0].output)).width, 360);
  assert.equal(fs.readFileSync(mine(1), 'utf8'), 'ARQUIVO DO USUARIO 1', 'pular não mexe no original');
  assert.equal(q.jobs[2].output, mine(2));
  assert.equal((await probeMedia(tools.ffprobe, mine(2))).height, 640, 'substituir trocou pelo vídeo novo, completo');
  assert.deepEqual(fs.readdirSync(outDir).filter((f) => f.endsWith('.part')), []);
}));

test('erros do motor real chegam à fila com causa e solução, sem tentar de novo o que não adianta', T, withReal(async ({ mk, job, dir }) => {
  const q = mk().load();
  q.setSettings({ retries: 3 });
  const [bad] = q.enqueue([job(0, { profile: { ...PROFILE, width: 361 } })]); // largura ímpar: o QC bloqueia
  await waitUntil(() => stateOf(q, bad.id) === 'failed');
  assert.equal(q.jobs[0].error.code, 'INVALID_PROFILE');
  assert.match(q.jobs[0].error.solution, /perfil/i);
  assert.equal(q.jobs[0].runs, 1);

  const [late] = q.enqueue([job(1, { cut: { id: 'fora', title: 'Fora', start: 15, end: 40, revision: 1 } })]); // passa do fim do vídeo
  await waitUntil(() => stateOf(q, late.id) === 'failed');
  assert.equal(q.jobs[1].error.code, 'INVALID_RANGE');

  const [ok] = q.enqueue([job(2)]); // o resto da fila segue normalmente
  await waitUntil(() => stateOf(q, ok.id) === 'done', { timeout: 60000 });
  assert.ok(fs.existsSync(path.join(dir, 'Cortes', 'corte 2.mp4')));
}));

test('legenda em arquivo separado e ajuste de áudio com o motor real: o arquivo de legenda sai ao lado do vídeo; SRT x ASS são trabalhos diferentes; desfazer o áudio até os mesmos valores é "já exportado"', T, withReal(async ({ dir, mk, job }) => {
  const AH = require('../src/core/audio/audioHistory');
  const q = mk().load();
  const outDir = path.join(dir, 'Cortes');
  const cues = [{ start: 0.2, end: 1.4, text: 'Olá, pessoal' }, { start: 1.6, end: 2.8, text: 'Segunda fala' }];
  const audioBase = job(0).cut.audio;
  const gain3 = AH.applyChange(audioBase, { gainDb: 3, fadeInSec: 0.5 }, { now: 1000 }).audio;
  const withSub = (n, sub, extra = {}) => job(0, { id: `legenda-${n}`, baseName: `legenda ${n}`, cut: { ...job(0).cut, audio: gain3, subtitles: { enabled: true, cues, ...sub } }, ...extra });

  // 1) SRT ao lado do vídeo, com o áudio ajustado
  q.enqueue([withSub('srt', { mode: 'sidecar', sidecarFormat: 'srt' })]);
  await waitUntil(() => stateOf(q, 'legenda-srt') === 'done', { timeout: 60000 });
  const srt = path.join(outDir, 'legenda srt.srt');
  assert.ok(fs.existsSync(srt), 'o SRT foi copiado ao lado do vídeo');
  assert.match(fs.readFileSync(srt, 'utf8'), /Olá, pessoal/);
  const first = await probeMedia(tools.ffprobe, q.jobs[0].output);
  assert.deepEqual([first.width, first.height, first.hasAudio], [360, 640, true]);

  // 2) o mesmo corte com ASS NÃO é "já exportado": gera o .ass
  const [ass] = q.enqueue([withSub('ass', { mode: 'sidecar', sidecarFormat: 'ass' })]);
  assert.notEqual(ass.state, 'skipped', 'trocar SRT por ASS é um trabalho novo');
  await waitUntil(() => stateOf(q, 'legenda-ass') === 'done', { timeout: 60000 });
  assert.ok(fs.existsSync(path.join(outDir, 'legenda ass.ass')), 'o ASS foi gerado');
  assert.match(fs.readFileSync(path.join(outDir, 'legenda ass.ass'), 'utf8'), /Dialogue:.*Olá, pessoal/);

  // 3) o mesmo SRT de novo (na mesma pasta) é "já exportado": nada é refeito
  const [again] = q.enqueue([withSub('srt-de-novo', { mode: 'srt' }, { baseName: 'legenda srt' })]);
  assert.equal(again.state, 'skipped');
  assert.equal(again.skippedCode, 'ALREADY_DONE');

  // 4) áudio: muda para 6 dB e desfaz (os valores voltam a 3 dB / fade 0,5 s, sobra o "refazer") = mesmo trabalho
  const gain6 = AH.applyChange(gain3, { gainDb: 6 }, { now: 90000 }).audio;
  const undone = AH.undo(gain6).audio;
  assert.ok(undone.redo && undone.redo.length === 1);
  const [sameAudio] = q.enqueue([withSub('desfeito', { mode: 'sidecar', sidecarFormat: 'srt' }, { baseName: 'legenda srt', cut: { ...job(0).cut, audio: undone, subtitles: { enabled: true, cues, mode: 'sidecar', sidecarFormat: 'srt' } } })]);
  assert.equal(sameAudio.state, 'skipped', 'desfazer até os mesmos valores não pede nova exportação');
  const [louder] = q.enqueue([withSub('alto', { mode: 'sidecar', sidecarFormat: 'srt' }, { cut: { ...job(0).cut, audio: gain6, subtitles: { enabled: true, cues, mode: 'sidecar', sidecarFormat: 'srt' } } })]);
  assert.notEqual(louder.state, 'skipped', 'outro ganho = outro arquivo');
  await waitUntil(() => stateOf(q, 'legenda-alto') === 'done', { timeout: 60000 });
  assert.deepEqual(fs.readdirSync(outDir).filter((f) => f.endsWith('.part')), []);
}));
