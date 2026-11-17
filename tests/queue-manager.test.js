'use strict';

/**
 * Lógica da fila (src/core/queue) com um executor FALSO controlável: concorrência, pausa, reordenação,
 * tentativas, recuperação, pular concluído, conflito de nome, cancelamento e persistência.
 * O relógio é o real (esperas de poucos milissegundos); o disco é um diretório temporário de verdade.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { QueueManager } = require('../src/core/queue');
const h = require('./queue-helpers');

const { waitUntil, makeJob, makeFakeRunner, makeManager, exportError, collect, stateOf, readState } = h;

/** Executa um teste dentro de uma pasta temporária e garante a limpeza (e o fim de qualquer gerenciador aberto). */
function withDir(fn) {
  return async () => {
    const dir = h.tmpDir();
    const managers = [];
    const mk = (opts) => { const m = makeManager(dir, opts); managers.push(m); return m; };
    try {
      await fn(dir, mk);
    } finally {
      for (const m of managers) m.shutdown();
      await h.sleep(20);
      h.removeDir(dir);
    }
  };
}

const enqueueN = (manager, dir, n, extra = () => ({})) => manager.enqueue(Array.from({ length: n }, (_, i) => makeJob(dir, i, extra(i))));

// ------------------------------------------------------------------ ordem e concorrência

test('executa em ordem de entrada, um por vez (paralelismo 1)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  const jobs = enqueueN(q, dir, 3);
  await waitUntil(() => fake.calls.length === 1, { what: 'o primeiro job começar' });
  await h.sleep(40);
  assert.equal(fake.calls.length, 1, 'só um começa enquanto o primeiro não termina');
  assert.deepEqual(h.states(q), ['running', 'queued', 'queued']);

  fake.calls[0].finish();
  await waitUntil(() => fake.calls.length === 2);
  fake.calls[1].finish();
  await waitUntil(() => fake.calls.length === 3);
  fake.calls[2].finish();
  await waitUntil(() => h.states(q).every((s) => s === 'done'));
  assert.deepEqual(fake.calls.map((c) => c.job.id), jobs.map((j) => j.id), 'ordem de entrada');
  assert.equal(fake.state.maxActive, 1);
}));

test('respeita o limite de concorrência (e o muda em tempo de execução)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ parallel: 3 });
  enqueueN(q, dir, 7);
  await waitUntil(() => fake.calls.length === 3);
  await h.sleep(40);
  assert.equal(fake.calls.length, 3, 'nunca mais que 3 ao mesmo tempo');
  assert.equal(q.snapshot().running, 3);

  fake.calls[0].finish();
  await waitUntil(() => fake.calls.length === 4, { what: 'o quarto job ocupar a vaga liberada' });
  await h.sleep(30);
  assert.equal(fake.calls.length, 4);

  q.setSettings({ parallel: 4 });
  await waitUntil(() => fake.calls.length === 5, { what: 'subir o limite abre mais uma vaga' });
  await h.sleep(30);
  assert.equal(fake.calls.length, 5);

  q.setSettings({ parallel: 2 }); // baixar o limite não derruba os que estão rodando...
  fake.calls[1].finish();
  fake.calls[2].finish();
  await h.sleep(60);
  assert.equal(fake.calls.length, 5, '...mas nada novo começa até caber no limite');
  fake.calls[3].finish();
  await waitUntil(() => fake.calls.length === 6);
  assert.equal(fake.state.maxActive, 4, 'o pico foi 4 (3 de início, 4 depois de subir o limite)');
  for (const c of fake.calls) c.finish();
}));

test('o paralelismo padrão vem das Preferências até o usuário escolher um valor', withDir(async (dir, mk) => {
  const q = mk({ runner: makeFakeRunner().runner }).load();
  assert.equal(q.getSettings().parallel, null);
  assert.equal(q.getSettings().effectiveParallel, 1);
  q.setSettings({ defaultParallel: 3 });
  assert.equal(q.getSettings().effectiveParallel, 3);
  q.setSettings({ parallel: 2 });
  assert.equal(q.getSettings().effectiveParallel, 2, 'o ajuste da fila vence a preferência');
  q.setSettings({ defaultParallel: 4 });
  assert.equal(q.getSettings().effectiveParallel, 2);
  q.setSettings({ parallel: null });
  assert.equal(q.getSettings().effectiveParallel, 4, 'voltar ao padrão segue a preferência');
  for (const bad of [0, 5, 1.5, 'x']) assert.throws(() => q.setSettings({ parallel: bad }), { code: 'INVALID_SETTINGS' }, String(bad));
  assert.throws(() => q.setSettings({ retries: 6 }), { code: 'INVALID_SETTINGS' });
  assert.throws(() => q.setSettings({ retries: -1 }), { code: 'INVALID_SETTINGS' });
  assert.throws(() => q.setSettings({ recovery: 'tanto-faz' }), { code: 'INVALID_SETTINGS' });
  assert.throws(() => q.setSettings({ onConflict: 'replace' }), { code: 'INVALID_SETTINGS', message: /arquivo por arquivo/ });
  assert.throws(() => q.setSettings({ defaultParallel: 9 }), { code: 'INVALID_SETTINGS' });
  assert.equal(q.getSettings().retries, 2, 'ajuste inválido não muda nada');
}));

// ------------------------------------------------------------------ pausa e retomada

test('pausar impede novos inícios; retomar continua de onde parou', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  enqueueN(q, dir, 3);
  await waitUntil(() => fake.calls.length === 1);

  q.pause();
  assert.equal(q.snapshot().paused, true);
  fake.calls[0].finish(); // o que já estava rodando termina normalmente
  await waitUntil(() => q.jobs[0].state === 'done');
  await h.sleep(60);
  assert.equal(fake.calls.length, 1, 'nada novo começa pausado');
  assert.deepEqual(h.states(q), ['done', 'queued', 'queued']);

  q.enqueue([makeJob(dir, 9)]); // entrar na fila pausada também só enfileira
  await h.sleep(40);
  assert.equal(fake.calls.length, 1);

  q.resume();
  await waitUntil(() => fake.calls.length === 2);
  assert.equal(q.snapshot().paused, false);
  for (let i = 1; i < 4; i++) { await waitUntil(() => fake.calls.length === i + 1); fake.calls[i].finish(); }
  await waitUntil(() => h.states(q).every((s) => s === 'done'));
}));

test('pausar e interromper: os atuais viram "interrupted", voltam à fila ao retomar e recomeçam do início', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ parallel: 2 });
  enqueueN(q, dir, 3);
  await waitUntil(() => fake.calls.length === 2);
  fake.calls[0].progress(0.5);

  const res = q.pause({ interrupt: true });
  assert.equal(res.interrupting, 2);
  await waitUntil(() => q.jobs.filter((j) => j.state === 'interrupted').length === 2);
  assert.ok(fake.calls[0].aborted && fake.calls[1].aborted, 'o sinal de cancelamento chegou ao executor');
  assert.deepEqual(q.jobs.map((j) => [j.state, j.progress, j.failures]), [['interrupted', 0, 0], ['interrupted', 0, 0], ['queued', 0, 0]]);
  assert.equal(q.snapshot().running, 0);
  await h.sleep(50);
  assert.equal(fake.calls.length, 2, 'pausada: nada recomeça sozinho');

  q.resume();
  await waitUntil(() => fake.calls.length === 4, { what: 'os dois interrompidos recomeçarem' });
  assert.deepEqual(fake.calls.slice(2).map((c) => c.job.id), [q.jobs[0].id, q.jobs[1].id], 'recomeçam na mesma ordem');
  assert.equal(q.jobs[0].runs, 2);
  for (const c of fake.calls.slice(2)) c.finish();
  await waitUntil(() => fake.calls.length === 5);
  fake.calls[4].finish();
  await waitUntil(() => h.states(q).every((s) => s === 'done'));
}));

// ------------------------------------------------------------------ reordenação

test('reordena só os que ainda não começaram; em andamento e finalizados não mudam de lugar', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.pause(); // monta a fila sem que nada comece
  const [a, b, c, d] = enqueueN(q, dir, 4);
  q.resume();
  await waitUntil(() => fake.calls.length === 1); // a está rodando
  assert.equal(fake.calls[0].job.id, a.id);

  const res = q.reorder([d.id, a.id, c.id, b.id]); // a (rodando) é ignorado na reordenação
  assert.deepEqual(res.order, [d.id, c.id, b.id]);
  assert.deepEqual(q.jobs.map((j) => j.id), [a.id, d.id, c.id, b.id], 'a continua na frente');
  fake.calls[0].finish();
  await waitUntil(() => fake.calls.length === 2);
  assert.equal(fake.calls[1].job.id, d.id, 'o próximo é o que foi puxado para a frente');
  fake.calls[1].finish();
  await waitUntil(() => fake.calls.length === 3);
  assert.equal(fake.calls[2].job.id, c.id);

  q.reorder([b.id]); // lista parcial: o citado vai à frente, os demais seguem na ordem em que estavam
  assert.deepEqual(q.jobs.filter((j) => j.state === 'queued').map((j) => j.id), [b.id]);
  assert.deepEqual(q.jobs.map((j) => j.id), [a.id, d.id, c.id, b.id], 'finalizados e em andamento não se movem');
  assert.throws(() => q.reorder('x'), { code: 'INVALID_ARGS' });
  fake.calls[2].finish();
  await waitUntil(() => fake.calls.length === 4);
  fake.calls[3].finish();
}));

// ------------------------------------------------------------------ tentativas

test('erro recuperável: tenta de novo com espera crescente, limitado a "retries"; depois falha com causa e solução', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner, backoffMs: 40 }).load();
  q.setSettings({ retries: 2 });
  const [job] = enqueueN(q, dir, 1);
  const crash = () => exportError('FFMPEG_CRASH', 'O ffmpeg encerrou de forma inesperada.', { stderr: 'linha 1\nlinha 2\nConversion failed!' });

  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].fail(crash());
  await waitUntil(() => stateOf(q, job.id) === 'queued' && q.jobs[0].retryAt, { what: 'ficar esperando a nova tentativa' });
  assert.equal(q.jobs[0].error.code, 'FFMPEG_CRASH');
  assert.equal(q.jobs[0].failures, 1);
  const delay1 = q.jobs[0].retryDelayMs;

  await waitUntil(() => fake.calls.length === 2);
  fake.calls[1].fail(crash());
  await waitUntil(() => stateOf(q, job.id) === 'queued' && q.jobs[0].failures === 2 && q.jobs[0].retryAt);
  const delay2 = q.jobs[0].retryDelayMs;
  await waitUntil(() => fake.calls.length === 3);
  fake.calls[2].fail(crash());
  await waitUntil(() => stateOf(q, job.id) === 'failed');

  assert.deepEqual([delay1, delay2], [40, 80], 'a espera dobra a cada tentativa (2 s, 4 s, 8 s… no app; aqui 40 ms de base)');
  const gap1 = fake.calls[1].startedAt - fake.calls[0].startedAt;
  const gap2 = fake.calls[2].startedAt - fake.calls[1].startedAt;
  assert.ok(gap1 >= 35, `a 1ª nova tentativa só começou depois da espera (foi ${gap1} ms)`);
  assert.ok(gap2 >= 75, `a 2ª, depois da espera maior (foi ${gap2} ms)`);
  assert.equal(q.jobs[0].runs, 3, '1 execução + 2 tentativas automáticas');
  const err = q.jobs[0].error;
  assert.equal(err.code, 'FFMPEG_CRASH');
  assert.match(err.message, /ffmpeg/);
  assert.ok(err.solution && err.solution.length > 20, 'solução em português');
  assert.match(err.technical, /Conversion failed/);
  assert.equal(fake.calls.length, 3, 'não tenta além do limite');
}));

test('todas as falhas recuperáveis do contrato são repetidas; "retries: 0" desliga as tentativas', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner, backoffMs: 5 }).load();
  q.setSettings({ retries: 1 });
  for (const code of ['FFMPEG_START_FAILED', 'IO_BUSY', 'FFMPEG_CRASH', 'DISK_TRANSIENT']) {
    const before = fake.calls.length;
    const [job] = q.enqueue([makeJob(dir, before + 100)]);
    await waitUntil(() => fake.calls.length === before + 1);
    fake.calls[before].fail(exportError(code, 'falha passageira'));
    await waitUntil(() => fake.calls.length === before + 2, { what: `nova tentativa para ${code}` });
    fake.calls[before + 1].finish();
    await waitUntil(() => stateOf(q, job.id) === 'done');
  }
  q.setSettings({ retries: 0 });
  const before = fake.calls.length;
  const [job] = q.enqueue([makeJob(dir, 200)]);
  await waitUntil(() => fake.calls.length === before + 1);
  fake.calls[before].fail(exportError('FFMPEG_CRASH', 'caiu'));
  await waitUntil(() => stateOf(q, job.id) === 'failed');
  assert.equal(fake.calls.length, before + 1);
}));

test('erro NÃO recuperável (ou desconhecido) vai direto para "failed", com causa e solução', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner, backoffMs: 5 }).load();
  q.setSettings({ retries: 5 });
  q.setSettings({ parallel: 4 });
  const cases = [
    ['INVALID_RANGE', exportError('INVALID_RANGE', 'O fim precisa ser maior que o início.')],
    ['INVALID_PROFILE', exportError('INVALID_PROFILE', 'Perfil inválido.')],
    ['NO_DISK_SPACE', exportError('NO_DISK_SPACE', 'Sem espaço em disco.')],
    ['CODEC_UNSUPPORTED', exportError('CODEC_UNSUPPORTED', 'Sem NVENC.')],
    ['INPUT_MISSING', exportError('INPUT_MISSING', 'Origem sumiu.')],
    ['FFMPEG_FAILED', exportError('FFMPEG_FAILED', 'O ffmpeg falhou.')],
    ['NO_DISK_SPACE', Object.assign(new Error('sem espaço'), { code: 'ENOSPC' })],
    ['UNKNOWN', new TypeError('bug')]
  ];
  const jobs = q.enqueue(cases.map((_, i) => makeJob(dir, 300 + i)));
  for (let i = 0; i < cases.length; i++) {
    await waitUntil(() => fake.calls.length >= i + 1); // 4 por vez; os demais entram conforme as vagas se abrem
    fake.calls[i].fail(cases[i][1]);
  }
  await waitUntil(() => q.jobs.every((j) => j.state === 'failed'));
  await h.sleep(60);
  assert.equal(fake.calls.length, cases.length, 'nenhuma nova tentativa');
  jobs.forEach((j, i) => {
    const failed = q.jobs.find((x) => x.id === j.id);
    assert.equal(failed.error.code, cases[i][0], `código ${cases[i][0]}`);
    assert.equal(failed.error.recoverable, false);
    assert.equal(failed.runs, 1);
    assert.ok(failed.error.message && failed.error.solution, 'causa e solução');
  });
}));

test('a solução vinda do motor (details.solution) tem prioridade sobre a padrão', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].fail(exportError('NO_DISK_SPACE', 'Faltam 2 GB no disco D:.', { solution: 'Apague o cache do OBS.' }));
  await waitUntil(() => q.jobs[0].state === 'failed');
  assert.equal(q.jobs[0].error.solution, 'Apague o cache do OBS.');
}));

// ------------------------------------------------------------------ recuperação

/** Copia o queue.json como estaria no disco no instante de uma "queda" (sem passar por shutdown). */
async function crashSnapshot(dir, q, want = 'running') {
  await waitUntil(() => {
    try { return readState(dir).jobs.some((j) => j.state === want); } catch { return false; }
  }, { what: `o disco registrar um job ${want}` });
  const crashed = h.tmpDir('queue-crash');
  fs.copyFileSync(path.join(dir, 'queue.json'), path.join(crashed, 'queue.json'));
  return crashed;
}

test('queda simulada: o gerenciador recriado a partir do queue.json marca o que rodava como "interrupted" e pergunta (ask)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  const [j1] = enqueueN(a, dir, 3);
  await waitUntil(() => fake.calls.length === 1);
  const crashed = await crashSnapshot(dir, a);
  try {
    const fake2 = makeFakeRunner();
    const b = makeManager(crashed, { runner: fake2.runner });
    const recovery = collect(b, 'recovery');
    b.load();
    assert.deepEqual(b.jobs.map((j) => j.state), ['interrupted', 'queued', 'queued']);
    assert.equal(b.jobs[0].id, j1.id);
    assert.equal(b.jobs[0].interruptedBy, 'crash');
    assert.equal(b.jobs[0].progress, 0);
    assert.equal(b.snapshot().paused, true, 'espera a decisão do usuário');
    assert.equal(b.snapshot().recovery.pending, true);
    assert.deepEqual(b.snapshot().recovery.jobs, [j1.id]);
    assert.equal(recovery.length, 1, 'evento queue:recovery');
    await h.sleep(60);
    assert.equal(fake2.calls.length, 0, 'nada recomeça sem a decisão');

    // fechar de novo sem decidir: o aviso continua na próxima abertura
    b.shutdown();
    const c = makeManager(crashed, { runner: makeFakeRunner().runner }).load();
    assert.equal(c.snapshot().recovery.pending, true);

    c.recover('resume');
    assert.equal(c.snapshot().recovery.pending, false);
    assert.equal(c.snapshot().paused, false);
    assert.equal(c.jobs[0].runs, 2, 'a execução interrompida contou e a nova já começou');
    c.shutdown();
  } finally { h.removeDir(crashed); }
  fake.calls[0].fail(exportError('CANCELLED', 'fim do teste'));
}));

test('recuperação "resume": reabre e continua sozinho; "discard": cancela o interrompido e segue com o resto', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  const crashed = await crashSnapshot(dir, a);
  try {
    // marca a política no arquivo salvo
    const saved = JSON.parse(fs.readFileSync(path.join(crashed, 'queue.json'), 'utf8'));

    saved.settings.recovery = 'resume';
    fs.writeFileSync(path.join(crashed, 'queue.json'), JSON.stringify(saved));
    const fakeR = makeFakeRunner();
    const r = makeManager(crashed, { runner: fakeR.runner }).load();
    await waitUntil(() => fakeR.calls.length === 1);
    assert.equal(fakeR.calls[0].job.id, saved.jobs[0].id, 'o interrompido recomeça primeiro');
    assert.equal(r.snapshot().recovery.pending, false);
    assert.equal(r.snapshot().paused, false);
    r.shutdown();

    saved.settings.recovery = 'discard';
    saved.jobs[0].state = 'running';
    saved.recovery = { pending: false };
    saved.paused = false;
    fs.writeFileSync(path.join(crashed, 'queue.json'), JSON.stringify(saved));
    const fakeD = makeFakeRunner();
    const d = makeManager(crashed, { runner: fakeD.runner }).load();
    assert.equal(d.jobs[0].state, 'cancelled');
    assert.match(d.jobs[0].cancelReason, /Descartado/);
    await waitUntil(() => fakeD.calls.length === 1);
    assert.equal(fakeD.calls[0].job.id, saved.jobs[1].id, 'o que estava só na fila continua');
    d.shutdown();
  } finally { h.removeDir(crashed); }
  fake.calls[0].fail(exportError('CANCELLED', 'fim do teste'));
}));

test('recuperar "discard" pelo banner: cancela os interrompidos, destrava a fila e segue', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  const crashed = await crashSnapshot(dir, a);
  try {
    const fake2 = makeFakeRunner();
    const b = makeManager(crashed, { runner: fake2.runner }).load();
    assert.equal(b.snapshot().recovery.pending, true);
    b.recover('discard');
    assert.deepEqual(b.jobs.map((j) => j.state).slice(0, 1), ['cancelled']);
    await waitUntil(() => fake2.calls.length === 1);
    assert.throws(() => b.recover('talvez'), { code: 'INVALID_ACTION' });
    b.shutdown();
  } finally { h.removeDir(crashed); }
  fake.calls[0].fail(exportError('CANCELLED', 'fim do teste'));
}));

test('cancelar tudo o que estava interrompido resolve o aviso de recuperação sozinho', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  const crashed = await crashSnapshot(dir, a);
  try {
    const fake2 = makeFakeRunner();
    const b = makeManager(crashed, { runner: fake2.runner }).load();
    assert.equal(b.snapshot().paused, true);
    b.cancel({ id: b.jobs[0].id });
    assert.equal(b.snapshot().recovery.pending, false);
    assert.equal(b.snapshot().paused, false);
    await waitUntil(() => fake2.calls.length === 1);
    b.shutdown();
  } finally { h.removeDir(crashed); }
  fake.calls[0].fail(exportError('CANCELLED', 'fim do teste'));
}));

test('fila pausada pelo usuário continua pausada ao reabrir (sem aviso de recuperação)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  a.pause();
  a.shutdown(); // fecha o app com um job rodando e a fila pausada
  const b = mk({ runner: makeFakeRunner().runner }).load();
  assert.equal(b.snapshot().paused, true);
  assert.equal(b.snapshot().recovery.pending, false);
  assert.deepEqual(b.jobs.map((j) => j.state), ['interrupted', 'queued']);
  b.resume();
  assert.equal(b.jobs[0].state === 'queued' || b.jobs[0].state === 'running', true);
}));

test('before-quit (shutdown): grava na hora, o que rodava vira "interrupted" e o processo é mandado parar', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].progress(0.4);
  a.shutdown();
  assert.equal(fake.calls[0].aborted, true, 'o executor recebeu o sinal para matar o ffmpeg');
  const disk = readState(dir);
  assert.deepEqual(disk.jobs.map((j) => j.state), ['interrupted', 'queued']);
  assert.equal(disk.jobs[0].interruptedBy, 'shutdown');
  await h.sleep(60);
  assert.deepEqual(readState(dir).jobs.map((j) => j.state), ['interrupted', 'queued'], 'o fim assíncrono do executor não sobrescreve o estado');
  assert.equal(fake.calls.length, 1, 'nada novo começa depois de fechar');
  a.shutdown(); // idempotente

  const b = mk({ runner: makeFakeRunner().runner }).load();
  assert.equal(b.snapshot().recovery.pending, true);
}));

// ------------------------------------------------------------------ pular concluído

test('não repete trabalho concluído: mesma chave + arquivo ainda existe = "skipped" com o motivo; qualquer mudança refaz', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  const base = makeJob(dir, 0);
  const [first] = q.enqueue([base]);
  await waitUntil(() => stateOf(q, first.id) === 'done');
  const out = q.jobs[0].output;
  assert.ok(fs.existsSync(out));

  const [again] = q.enqueue([{ ...base, id: 'repetido' }]);
  assert.equal(again.state, 'skipped');
  assert.equal(again.skippedCode, 'ALREADY_DONE');
  assert.match(again.skippedReason, /Já exportado/);
  assert.equal(again.output, out);
  assert.equal(fake.calls.length, 1, 'o executor nem foi chamado');

  // cada parte da chave refaz o trabalho
  const variants = {
    intervalo: { cut: { ...base.cut, end: base.cut.end + 1 } },
    perfil: { profile: { ...base.profile, bitrateKbps: 20000 } },
    enquadramento: { framing: { mode: 'blur', focusX: 0.5, zoom: 1, blur: { strength: 20 } } },
    áudio: { cut: { ...base.cut, audio: { ...base.cut.audio, gainDb: 3 } } },
    legendas: { cut: { ...base.cut, subtitles: { enabled: true, mode: 'burn', cues: [{ start: 1, end: 2, text: 'oi' }] } } }
  };
  let n = 0;
  for (const [what, patch] of Object.entries(variants)) {
    n += 1;
    const [v] = q.enqueue([{ ...base, ...patch, id: `v${n}`, baseName: `variante ${n}` }]);
    assert.notEqual(v.state, 'skipped', `${what} muda a chave`);
    await waitUntil(() => stateOf(q, v.id) === 'done');
  }
  // mudar só texto cosmético não muda a chave (nome do perfil, histórico de áudio)
  const [cosmetic] = q.enqueue([{ ...base, id: 'cosm', profile: { ...base.profile, name: 'Outro nome' }, cut: { ...base.cut, audio: { ...base.cut.audio, history: [{ at: 1 }] } } }]);
  assert.equal(cosmetic.state, 'skipped');

  // o arquivo foi apagado: refazer faz sentido
  fs.rmSync(out);
  const [redo] = q.enqueue([{ ...base, id: 'refazer' }]);
  assert.notEqual(redo.state, 'skipped', 'arquivo apagado: refaz');
  await waitUntil(() => stateOf(q, 'refazer') === 'done');

  // outro destino também é trabalho novo
  const [other] = q.enqueue([{ ...base, id: 'outra-pasta', outputDir: path.join(dir, 'Outra') }]);
  assert.notEqual(other.state, 'skipped');
  await waitUntil(() => stateOf(q, 'outra-pasta') === 'done');
}));

test('substituir o arquivo por outro trabalho invalida o "já exportado" do trabalho antigo (o arquivo daquele nome já não é o dele)', withDir(async (dir, mk) => {
  // regressão do teste de sistema: o 1080p do corte foi trocado pelo 1440p H.265 de mesmo nome ("Substituir"); pedir o 1080p
  // de novo era pulado como "Já exportado" embora o arquivo não fosse mais o 1080p
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  const first = { ...makeJob(dir, 0), id: 'v1080', baseName: 'mesmo nome' };
  q.enqueue([first]);
  await waitUntil(() => stateOf(q, 'v1080') === 'done');
  const out = q.jobs.find((j) => j.id === 'v1080').output;
  assert.equal(fs.readFileSync(out, 'utf8'), 'saida v1080');

  const bigger = { ...first, id: 'v1440', onConflict: 'replace', profile: { ...first.profile, id: 'vertical-1440-h265', codec: 'h265', width: 1440, height: 2560 } };
  const [replacing] = q.enqueue([bigger]);
  assert.notEqual(replacing.state, 'skipped', 'outro perfil é outro trabalho');
  await waitUntil(() => stateOf(q, 'v1440') === 'done');
  assert.equal(q.jobs.find((j) => j.id === 'v1440').output, out, 'substituir grava no mesmo caminho');
  assert.equal(fs.readFileSync(out, 'utf8'), 'saida v1440');

  // o 1080p pedido de novo não é "já exportado": o arquivo agora é o 1440p; cai no conflito de nome (a decisão é do usuário)
  const [again] = q.enqueue([{ ...first, id: 'v1080-de-novo' }]);
  assert.notEqual(again.state, 'skipped', 'o 1080p foi trocado: não pode ser pulado como já exportado');
  await waitUntil(() => stateOf(q, 'v1080-de-novo') === 'needsAction', { what: 'o conflito de nome do 1080p' });
  assert.equal(q.jobs.find((j) => j.id === 'v1080-de-novo').skippedCode, null);
  // o trabalho que ficou com o arquivo continua "já exportado"
  const [kept] = q.enqueue([{ ...bigger, id: 'v1440-de-novo' }]);
  assert.equal(kept.state, 'skipped');
  assert.equal(kept.skippedCode, 'ALREADY_DONE');
  // e o registro sobrevive a fechar e abrir (o 1080p não volta)
  q.shutdown();
  const reopened = mk({ runner: fake.runner }).load();
  assert.deepEqual(Object.values(reopened.completed).map((c) => c.output), [out], 'só o trabalho que ficou com o arquivo está no registro de concluídos');
}));

test('"já exportado" olha o resultado: desfazer um ajuste de áudio até os mesmos valores é o mesmo trabalho; trocar o formato do arquivo de legenda não é', withDir(async (dir, mk) => {
  const AH = require('../src/core/audio/audioHistory');
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  const base = makeJob(dir, 0);
  const sixDb = AH.applyChange(base.cut.audio, { gainDb: 6, fadeInSec: 1, fadeOutSec: 1 }, { now: 1000 }).audio;
  const first = { ...base, id: 'seis-db', cut: { ...base.cut, audio: sixDb } };
  q.enqueue([first]);
  await waitUntil(() => stateOf(q, 'seis-db') === 'done');

  // muda para 3 dB e desfaz: os valores voltam a 6/1/1, mas sobra a pilha de "refazer" no corte
  const threeDb = AH.applyChange(sixDb, { gainDb: 3 }, { now: 60000 }).audio;
  const undone = AH.undo(threeDb).audio;
  assert.equal(undone.gainDb, 6);
  assert.equal(undone.redo.length, 1, 'o desfazer deixou o "refazer" no corte');
  const [again] = q.enqueue([{ ...first, id: 'desfeito', cut: { ...base.cut, audio: undone } }]);
  assert.equal(again.state, 'skipped', 'mesmos valores = mesmo resultado');
  assert.equal(again.skippedCode, 'ALREADY_DONE');
  const [other] = q.enqueue([{ ...first, id: 'tres-db', baseName: 'tres db', cut: { ...base.cut, audio: threeDb } }]);
  assert.notEqual(other.state, 'skipped', 'valores diferentes refazem');
  await waitUntil(() => stateOf(q, 'tres-db') === 'done');

  // legendas em arquivo separado: SRT e ASS geram arquivos diferentes
  const cues = [{ start: 1, end: 2, text: 'oi' }];
  const withSub = (id, i, sub) => ({ ...makeJob(dir, i, { id }), baseName: `legenda ${i}`, cut: { ...makeJob(dir, i).cut, subtitles: { enabled: true, cues, ...sub } } });
  q.enqueue([withSub('srt', 5, { mode: 'sidecar', sidecarFormat: 'srt' })]);
  await waitUntil(() => stateOf(q, 'srt') === 'done');
  const [ass] = q.enqueue([{ ...withSub('ass', 5, { mode: 'sidecar', sidecarFormat: 'ass' }), baseName: 'legenda 5 em ass' }]);
  assert.notEqual(ass.state, 'skipped', 'trocar SRT por ASS gera um arquivo novo');
  await waitUntil(() => stateOf(q, 'ass') === 'done');
  const [srtAgain] = q.enqueue([{ ...withSub('srt-de-novo', 5, { mode: 'srt' }) }]);
  assert.equal(srtAgain.state, 'skipped', 'o modo antigo "srt" é o mesmo que sidecar + srt');
}));

test('pular concluído sobrevive a "Limpar concluídos" e à reabertura; "exportar de novo" (force) é explícito', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  const base = makeJob(dir, 0);
  q.enqueue([base]);
  await waitUntil(() => q.jobs[0].state === 'done');
  assert.equal(q.clearFinished().removed, 1);
  assert.equal(q.jobs.length, 0);

  const [skipped] = q.enqueue([{ ...base, id: 'depois-de-limpar' }]);
  assert.equal(skipped.state, 'skipped', 'o histórico de concluídos não depende da lista');
  q.shutdown();

  const q2 = mk({ runner: fake.runner }).load();
  const [skipped2] = q2.enqueue([{ ...base, id: 'depois-de-reabrir' }]);
  assert.equal(skipped2.state, 'skipped', 'e sobrevive ao fechar o app');
  assert.equal(fake.calls.length, 1);

  // exportar de novo, de propósito: o arquivo anterior existe, então a fila pergunta (ask) em vez de sobrescrever
  const conflicts = collect(q2, 'conflict');
  q2.retry('depois-de-reabrir');
  await waitUntil(() => stateOf(q2, 'depois-de-reabrir') === 'needsAction');
  assert.equal(conflicts.length, 1);
  assert.equal(fake.calls.length, 1, 'ainda não exportou nada: esperando a decisão');
  q2.resolveConflict('depois-de-reabrir', 'rename');
  await waitUntil(() => fake.calls.length === 2);
  assert.equal(fake.calls[1].job.onConflict, 'rename');
  await waitUntil(() => stateOf(q2, 'depois-de-reabrir') === 'done');
}));

test('trabalho igual a outro ainda ativo entra como "skipped" (ALREADY_QUEUED) e não dá para repetir', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.pause();
  const base = makeJob(dir, 0);
  const [a, b] = q.enqueue([base, { ...base, id: 'gemeo' }]);
  assert.equal(a.state, 'queued');
  assert.equal(b.state, 'skipped');
  assert.equal(b.skippedCode, 'ALREADY_QUEUED');
  assert.throws(() => q.retry('gemeo'), { code: 'ALREADY_QUEUED' });
}));

// ------------------------------------------------------------------ conflito de nome

test('onConflict "ask": arquivo existente = needsAction + queue:conflict; o executor nunca recebe "ask"', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  const conflicts = collect(q, 'conflict');
  const jobs = [makeJob(dir, 1), makeJob(dir, 2), makeJob(dir, 3), makeJob(dir, 4)];
  fs.mkdirSync(jobs[0].outputDir, { recursive: true });
  for (const j of jobs.slice(0, 3)) fs.writeFileSync(path.join(j.outputDir, `${j.baseName}.mp4`), 'ARQUIVO DO USUARIO');
  q.enqueue(jobs);

  await waitUntil(() => conflicts.length === 3);
  assert.deepEqual(h.states(q), ['needsAction', 'needsAction', 'needsAction', 'running'], 'conflito não trava os outros');
  assert.equal(conflicts[0].path, path.join(jobs[0].outputDir, `${jobs[0].baseName}.mp4`));
  assert.equal(conflicts[0].job.id, jobs[0].id);
  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].finish();
  await h.sleep(40);
  assert.equal(fake.calls.length, 1, 'os que esperam decisão não rodam');

  q.resolveConflict(jobs[0].id, 'rename');
  q.resolveConflict(jobs[1].id, 'replace');
  q.resolveConflict(jobs[2].id, 'skip');
  assert.equal(stateOf(q, jobs[2].id), 'skipped');
  assert.equal(q.jobs[2].skippedCode, 'CONFLICT_SKIPPED');
  await waitUntil(() => fake.calls.length === 2);
  fake.calls[1].finish();
  await waitUntil(() => fake.calls.length === 3);
  fake.calls[2].finish();
  assert.deepEqual(fake.calls.slice(1).map((c) => [c.job.id, c.job.onConflict]), [[jobs[0].id, 'rename'], [jobs[1].id, 'replace']]);
  assert.ok(fake.calls.every((c) => c.job.onConflict !== 'ask'), 'nunca "ask"');
  await waitUntil(() => q.jobs.every((j) => ['done', 'skipped'].includes(j.state)));
  assert.equal(fs.readFileSync(path.join(jobs[2].outputDir, `${jobs[2].baseName}.mp4`), 'utf8'), 'ARQUIVO DO USUARIO', 'pular não toca no arquivo');

  assert.throws(() => q.resolveConflict(jobs[0].id, 'rename'), { code: 'NOT_WAITING' });
  assert.throws(() => q.resolveConflict('nao-existe', 'rename'), { code: 'JOB_NOT_FOUND' });
}));

test('conflito descoberto só pelo executor (OUTPUT_EXISTS em "ask") também vira needsAction', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  const conflicts = collect(q, 'conflict');
  const job = makeJob(dir, 0);
  q.enqueue([job]);
  await waitUntil(() => fake.calls.length === 1);
  assert.equal(fake.calls[0].job.onConflict, 'fail', 'em "ask" o executor recebe "fail" e avisa cedo');
  fake.calls[0].fail(exportError('OUTPUT_EXISTS', 'Já existe um arquivo.', { path: path.join(dir, 'Cortes', 'nome-do-executor.mp4') }));
  await waitUntil(() => stateOf(q, job.id) === 'needsAction');
  assert.equal(conflicts[0].path, path.join(dir, 'Cortes', 'nome-do-executor.mp4'));
  assert.equal(q.jobs[0].failures, 0, 'perguntar não é falha');
  q.resolveConflict(job.id, 'rename');
  await waitUntil(() => fake.calls.length === 2);
  assert.equal(fake.calls[1].job.onConflict, 'rename');
  fake.calls[1].finish();
}));

test('modos fixos de conflito: rename/replace passam direto; skip e fail resolvem sem chamar o executor', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  const make = (i, onConflict) => {
    const job = makeJob(dir, i, { onConflict });
    fs.mkdirSync(job.outputDir, { recursive: true });
    fs.writeFileSync(path.join(job.outputDir, `${job.baseName}.mp4`), 'existente');
    return job;
  };
  const [r, p, s, f] = q.enqueue([make(10, 'rename'), make(11, 'replace'), make(12, 'skip'), make(13, 'fail')]);
  await waitUntil(() => q.jobs.every((j) => !['queued', 'running'].includes(j.state)));
  assert.equal(stateOf(q, r.id), 'done');
  assert.equal(stateOf(q, p.id), 'done');
  assert.equal(stateOf(q, s.id), 'skipped');
  assert.equal(stateOf(q, f.id), 'failed');
  assert.equal(q.jobs[3].error.code, 'OUTPUT_EXISTS');
  assert.deepEqual(fake.calls.map((c) => c.job.onConflict), ['rename', 'replace']);
}));

test('Ajustes → "se o arquivo já existir" vale para jobs que pedem "ask"; a escolha do job vence', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ onConflict: 'rename' });
  const job = makeJob(dir, 20);
  fs.mkdirSync(job.outputDir, { recursive: true });
  fs.writeFileSync(path.join(job.outputDir, `${job.baseName}.mp4`), 'existente');
  q.enqueue([job]);
  await waitUntil(() => q.jobs[0].state === 'done');
  assert.equal(fake.calls[0].job.onConflict, 'rename');

  q.setSettings({ onConflict: 'skip' });
  const j2 = makeJob(dir, 21);
  fs.writeFileSync(path.join(j2.outputDir, `${j2.baseName}.mp4`), 'existente');
  q.enqueue([j2]);
  await waitUntil(() => stateOf(q, j2.id) === 'skipped');
}));

test('dois jobs que gravariam o mesmo arquivo nunca rodam ao mesmo tempo', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ parallel: 3 });
  const a = makeJob(dir, 0, { baseName: 'mesmo nome', onConflict: 'rename' });
  const b = makeJob(dir, 1, { baseName: 'mesmo nome', onConflict: 'rename' });
  const c = makeJob(dir, 2, { baseName: 'outro nome', onConflict: 'rename' });
  q.enqueue([a, b, c]);
  await waitUntil(() => fake.calls.length === 2);
  await h.sleep(40);
  assert.deepEqual(fake.calls.map((x) => x.job.id), [a.id, c.id], 'o segundo espera o primeiro (o c, de outro arquivo, passa na frente)');
  fake.calls[0].finish();
  await waitUntil(() => fake.calls.length === 3);
  assert.equal(fake.calls[2].job.id, b.id);
  for (const call of fake.calls.slice(1)) call.finish();
}));

// ------------------------------------------------------------------ cancelar, remover, limpar

test('cancelar: o em execução é interrompido de verdade (e o .part sobrante some); os da fila viram "cancelled"', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  const [a, b, c] = enqueueN(q, dir, 3);
  await waitUntil(() => fake.calls.length === 1);
  const part = `${fake.calls[0].outputPath}.part`;
  fs.mkdirSync(path.dirname(part), { recursive: true });
  fs.writeFileSync(part, 'meio do arquivo'); // o executor falso não limpa o .part: a fila garante

  assert.deepEqual(q.cancel({ id: a.id }), { cancelled: 0, stopping: 1 });
  await waitUntil(() => stateOf(q, a.id) === 'cancelled');
  assert.equal(fake.calls[0].aborted, true);
  assert.equal(fs.existsSync(part), false, '.part apagado');

  await waitUntil(() => fake.calls.length === 2, { what: 'o próximo ocupar a vaga' });
  assert.equal(q.cancel({ id: c.id }).cancelled, 1);
  assert.equal(stateOf(q, c.id), 'cancelled');
  assert.throws(() => q.cancel({ id: c.id }), { code: 'NOT_CANCELLABLE' });
  assert.throws(() => q.cancel({ id: 'nao-existe' }), { code: 'JOB_NOT_FOUND' });
  assert.throws(() => q.cancel({}), { code: 'INVALID_ARGS' });
  assert.equal(stateOf(q, b.id), 'running');
  fake.calls[1].finish();
}));

test('cancelar tudo (all) e remover/limpar', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ parallel: 2 });
  enqueueN(q, dir, 5);
  await waitUntil(() => fake.calls.length === 2);
  const res = q.cancel({ id: 'all' });
  assert.deepEqual(res, { cancelled: 3, stopping: 2 });
  await waitUntil(() => q.jobs.every((j) => j.state === 'cancelled'));
  assert.ok(fake.calls.every((c) => c.aborted));
  await h.sleep(40);
  assert.equal(fake.calls.length, 2, 'nada novo começou');
  assert.equal(q.cancel({ all: true }).cancelled, 0, 'cancelar tudo sem nada ativo não é erro');

  // remover
  const [x] = q.enqueue([makeJob(dir, 50)]);
  await waitUntil(() => fake.calls.length === 3);
  assert.throws(() => q.remove(x.id), { code: 'JOB_RUNNING' });
  fake.calls[2].finish();
  await waitUntil(() => stateOf(q, x.id) === 'done');
  assert.equal(q.remove(x.id).removed, true);
  assert.equal(q.jobs.some((j) => j.id === x.id), false);
  assert.ok(fs.existsSync(fake.calls[2].outputPath), 'remover da lista não apaga o arquivo exportado');
  assert.throws(() => q.remove(x.id), { code: 'JOB_NOT_FOUND' });

  // limpar concluídos: tira done/skipped/cancelled e mantém as falhas
  const [f] = q.enqueue([makeJob(dir, 51)]);
  await waitUntil(() => fake.calls.length === 4);
  fake.calls[3].fail(exportError('INVALID_RANGE', 'intervalo inválido'));
  await waitUntil(() => stateOf(q, f.id) === 'failed');
  assert.equal(q.clearFinished().removed, 5, '5 cancelados saem');
  assert.deepEqual(q.jobs.map((j) => j.state), ['failed'], 'a falha fica, pede atenção');
  assert.equal(q.clearFinished({ includeFailed: true }).removed, 1);
}));

test('tentar de novo: falha/cancelado/interrompido voltam ao fim da fila, zerando as tentativas', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.pause();
  const [a, b, c] = enqueueN(q, dir, 3);
  q.resume();
  await waitUntil(() => fake.calls.length === 1);
  fake.calls[0].fail(exportError('INVALID_RANGE', 'intervalo inválido'));
  await waitUntil(() => stateOf(q, a.id) === 'failed');
  await waitUntil(() => fake.calls.length === 2); // b começou
  q.pause({ interrupt: true });
  await waitUntil(() => stateOf(q, b.id) === 'interrupted');
  q.cancel({ id: b.id });
  q.retry(a.id);
  q.retry(b.id);
  assert.deepEqual(q.jobs.map((j) => j.id), [c.id, a.id, b.id], 'entram no fim, na ordem do pedido');
  assert.equal(q.jobs[1].failures, 0);
  assert.equal(q.jobs[1].error, null);
  assert.throws(() => q.retry(c.id), { code: 'NOT_RETRYABLE' });
  q.resume();
  await waitUntil(() => fake.calls.length === 3);
  assert.equal(fake.calls[2].job.id, c.id);
  fake.calls[2].finish();
  await waitUntil(() => fake.calls.length === 4);
  assert.equal(fake.calls[3].job.id, a.id);
  fake.calls[3].finish();
  await waitUntil(() => fake.calls.length === 5);
  assert.equal(fake.calls[4].job.id, b.id);
  fake.calls[4].finish();
}));

test('executor que ignora o cancelamento: a vaga é liberada depois do prazo e fica um aviso', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ ignoreAbort: true });
  const q = mk({ runner: fake.runner, abortGraceMs: 80 }).load();
  const [a] = enqueueN(q, dir, 2);
  await waitUntil(() => fake.calls.length === 1);
  q.cancel({ id: a.id });
  assert.equal(stateOf(q, a.id), 'running', 'ainda esperando o executor');
  await waitUntil(() => stateOf(q, a.id) === 'cancelled', { what: 'o prazo de cancelamento vencer' });
  assert.ok(q.jobs[0].warnings.some((w) => w.code === 'ABANDONED'));
  await waitUntil(() => fake.calls.length === 2, { what: 'a vaga liberada ser usada' });
  fake.calls[0].finish(); // o executor teimoso termina depois: não muda nada
  await h.sleep(30);
  assert.equal(stateOf(q, a.id), 'cancelled');
  fake.calls[1].finish();
}));

// ------------------------------------------------------------------ pré-verificação, ferramentas, executor ausente

test('preflight: erro bloqueia só aquele job (sem tentar de novo); aviso não bloqueia e fica registrado', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const seen = [];
  const preflight = async (job) => {
    seen.push(job.onConflict);
    if (job.cut.id === 'cut-1') return { errors: [{ code: 'NO_DISK_SPACE', message: 'Faltam 3 GB em D:.', solution: 'Libere espaço em D:.' }], warnings: [] };
    if (job.cut.id === 'cut-2') return { errors: [], warnings: [{ code: 'UPSCALE', message: 'A fonte será ampliada.' }] };
    return { errors: [], warnings: [] };
  };
  const q = mk({ runner: fake.runner, preflight }).load();
  q.setSettings({ retries: 3 });
  const [a, b, c] = enqueueN(q, dir, 3);
  await waitUntil(() => q.jobs.every((j) => ['done', 'failed'].includes(j.state)));
  assert.equal(stateOf(q, a.id), 'done');
  assert.equal(stateOf(q, b.id), 'failed');
  assert.equal(stateOf(q, c.id), 'done');
  assert.equal(q.jobs[1].error.code, 'NO_DISK_SPACE');
  assert.equal(q.jobs[1].error.message, 'Faltam 3 GB em D:.');
  assert.equal(q.jobs[1].error.solution, 'Libere espaço em D:.');
  assert.equal(q.jobs[1].runs, 1);
  assert.deepEqual(fake.calls.map((x) => x.job.cut.id), ['cut-0', 'cut-2'], 'o executor nem foi chamado para o bloqueado');
  assert.deepEqual(q.jobs[2].warnings, [{ code: 'UPSCALE', message: 'A fonte será ampliada.' }]);
  assert.ok(seen.every((m) => m !== 'ask'), 'o preflight também vê o conflito já resolvido');
}));

test('preflight que quebra não bloqueia o job (vira aviso); avisos do executor entram na lista', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: async (job, opts) => { const r = await fake.runner(job, opts); return { ...r, warnings: ['Áudio com volume baixo.', { code: 'X', message: 'Outro aviso.' }] }; }, preflight: async () => { throw new Error('qc caiu'); } }).load();
  q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => q.jobs[0].state === 'done');
  assert.deepEqual(q.jobs[0].warnings.map((w) => w.message), [
    'A verificação prévia não pôde ser feita (qc caiu); a exportação seguiu mesmo assim.', 'Áudio com volume baixo.', 'Outro aviso.'
  ]);
}));

test('sem FFmpeg ou sem o vídeo de origem: o job falha com causa e solução (sem chamar o executor)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const tools = { ffmpeg: null };
  const q = mk({ runner: fake.runner, tools }).load();
  const [a] = q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => stateOf(q, a.id) === 'failed');
  assert.equal(q.jobs[0].error.code, 'NO_FFMPEG');
  assert.match(q.jobs[0].error.solution, /ffmpeg\.org/);

  tools.ffmpeg = 'agora-tem';
  const [b] = q.enqueue([makeJob(dir, 1, { sourcePath: path.join(dir, 'sumiu.mp4') })]);
  await waitUntil(() => stateOf(q, b.id) === 'failed');
  assert.equal(q.jobs[1].error.code, 'INPUT_MISSING');
  assert.equal(fake.calls.length, 0);

  q.retry(a.id);
  await waitUntil(() => fake.calls.length === 1, { what: 'tentar de novo com o FFmpeg já disponível' });
  fake.calls[0].finish();
}));

test('executor ainda indisponível: os jobs esperam na fila e a fila explica; quando ele aparece, tudo corre', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  let available = null;
  const q = mk({ getRunner: () => available }).load();
  enqueueN(q, dir, 2);
  await h.sleep(40);
  assert.deepEqual(h.states(q), ['queued', 'queued']);
  assert.equal(q.snapshot().blocked.code, 'RUNNER_UNAVAILABLE');
  assert.match(q.snapshot().blocked.message, /motor de exportação/);

  available = fake.runner;
  q.resume();
  await waitUntil(() => q.jobs.every((j) => j.state === 'done'));
  assert.equal(q.snapshot().blocked, null);
}));

test('descartar ou remover um interrompido apaga o .part que ele deixou (e só ele)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const a = mk({ runner: fake.runner }).load();
  a.setSettings({ parallel: 2 });
  const [j1, j2] = enqueueN(a, dir, 2);
  await waitUntil(() => fake.calls.length === 2);
  const outDir = path.dirname(fake.calls[0].outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const parts = fake.calls.map((c) => `${c.outputPath}.part`);
  for (const p of parts) fs.writeFileSync(p, 'meio do arquivo');
  const stranger = path.join(outDir, 'de-outro-programa.mp4.part');
  fs.writeFileSync(stranger, 'não é nosso');
  a.shutdown(); // o app fecha no meio das duas exportações (o fechamento limpa os .part dos que rodavam)
  for (const p of parts) fs.writeFileSync(p, 'meio do arquivo'); // queda brusca: sem before-quit, o .part ficou na pasta

  const b = mk({ runner: makeFakeRunner().runner }).load();
  assert.deepEqual(b.jobs.map((j) => j.state), ['interrupted', 'interrupted']);
  b.remove(j1.id);
  assert.equal(fs.existsSync(parts[0]), false, 'remover apaga o .part do interrompido');
  assert.equal(fs.existsSync(parts[1]), true, 'o outro ainda não foi decidido');
  b.recover('discard');
  assert.equal(b.jobs[0].id, j2.id);
  assert.equal(fs.existsSync(parts[1]), false, 'descartar apaga o .part do outro');
  assert.equal(fs.readFileSync(stranger, 'utf8'), 'não é nosso', 'um .part que não é de nenhum trabalho da fila nunca é tocado');

  // um .part mais antigo que a execução (de antes, de outro trabalho) também fica
  b.shutdown(); // grava o estado atual (tudo decidido) antes de o próximo gerenciador abrir o arquivo
  const c = mk({ runner: makeFakeRunner().runner }).load();
  const [j3] = enqueueN(c, dir, 1, () => ({ baseName: 'antigo' }));
  await waitUntil(() => c.jobs.some((j) => j.id === j3.id && j.state === 'running'));
  const oldPart = path.join(outDir, 'antigo.mp4.part');
  fs.writeFileSync(oldPart, 'de antes');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(oldPart, past, past);
  c.pause({ interrupt: true });
  await waitUntil(() => c.jobs.find((j) => j.id === j3.id).state === 'interrupted');
  c.cancel({ id: j3.id });
  assert.equal(fs.existsSync(oldPart), true, 'anterior ao início da execução: não é desta fila');
}));

test('o aviso de executor ausente some quando não há mais nada esperando na fila', withDir(async (dir, mk) => {
  const q = mk({ getRunner: () => null }).load();
  const [job] = enqueueN(q, dir, 1);
  await h.sleep(30);
  assert.equal(q.snapshot().blocked.code, 'RUNNER_UNAVAILABLE');
  q.cancel({ id: job.id });
  q.resume(); // qualquer varredura reavalia
  assert.equal(q.snapshot().blocked, null);
}));

// ------------------------------------------------------------------ progresso, eventos, validação

test('progresso: eventos monotônicos, tempo restante estimado e jobDone com o resultado', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  const progress = collect(q, 'progress');
  const done = collect(q, 'jobDone');
  const updates = collect(q, 'update');
  const [job] = q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => fake.calls.length === 1);
  const call = fake.calls[0];
  call.progress(0.1);
  await h.sleep(450);
  call.progress(0.3);
  call.progress(0.2); // não anda para trás
  call.progress(NaN);
  call.progress(7); // acima de 1 é limitado
  assert.ok(progress.length >= 3);
  assert.ok(progress.every((e, i) => e.id === job.id && e.p >= (i ? progress[i - 1].p : 0)), 'monotônico');
  assert.equal(progress.at(-1).p, 1);
  const withEta = progress.find((e) => e.etaSec !== null);
  assert.ok(withEta && withEta.etaSec > 0, 'estimativa de tempo restante');

  call.finish();
  await waitUntil(() => done.length === 1);
  assert.equal(done[0].output, call.outputPath);
  assert.equal(done[0].job.id, job.id);
  assert.equal(done[0].job.state, 'done');
  assert.equal(done[0].job.cut.id, 'cut-0');
  assert.deepEqual(done[0].job.cut.end, 30);
  await waitUntil(() => updates.length > 0 && updates.at(-1).jobs[0].state === 'done');
  const last = updates.at(-1);
  assert.equal(last.running, 0);
  assert.equal(last.paused, false);
}));

test('o payload dos eventos é seguro para o IPC (sem legendas pesadas no resumo do corte)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.pause();
  const big = makeJob(dir, 0);
  big.cut.subtitles = { enabled: true, mode: 'burn', cues: Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 1, text: `fala ${i}` })) };
  const [v] = q.enqueue([big]);
  assert.equal(v.cut.subtitles, undefined);
  assert.deepEqual(Object.keys(v.cut).sort(), ['category', 'end', 'id', 'revision', 'start', 'status', 'title']);
  assert.doesNotThrow(() => structuredClone(q.snapshot()));
  q.flush();
  assert.equal(readState(dir).jobs[0].cut.subtitles.cues.length, 500, 'o estado em disco guarda o corte completo para o executor');
}));

test('entrada inválida é recusada por inteiro, com mensagem em português', withDir(async (dir, mk) => {
  const q = mk({ runner: makeFakeRunner().runner }).load();
  q.pause();
  const ok = makeJob(dir, 0);
  assert.throws(() => q.enqueue([]), { code: 'INVALID_JOB' });
  assert.throws(() => q.enqueue([ok, { ...ok, sourcePath: '' }]), (err) => err.code === 'INVALID_JOB' && /posição 2/.test(err.message) && /Nada foi colocado/.test(err.message));
  assert.throws(() => q.enqueue([{ ...ok, cut: { start: 'x', end: 2 } }]), { code: 'INVALID_JOB' });
  assert.throws(() => q.enqueue([{ ...ok, profile: null }]), { code: 'INVALID_JOB' });
  assert.throws(() => q.enqueue([{ ...ok, outputDir: undefined }]), { code: 'INVALID_JOB' });
  assert.throws(() => q.enqueue([{ ...ok, baseName: '  ' }]), { code: 'INVALID_JOB' });
  assert.throws(() => q.enqueue(['texto']), { code: 'INVALID_JOB' });
  assert.equal(q.jobs.length, 0, 'nada entrou');
  const [a, b] = q.enqueue([{ ...ok, id: 'mesmo' }, { ...makeJob(dir, 1), id: 'mesmo' }]);
  assert.equal(a.id, 'mesmo');
  assert.notEqual(b.id, 'mesmo', 'id repetido ganha outro');
}));

test('limita o histórico de finalizados (os mais antigos saem)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner, maxFinished: 3 }).load();
  q.setSettings({ parallel: 4 });
  enqueueN(q, dir, 6);
  await waitUntil(() => fake.calls.length === 6 && q.jobs.every((j) => j.state === 'done'));
  assert.equal(q.jobs.length, 3);
  assert.deepEqual(q.jobs.map((j) => j.cut.id), ['cut-3', 'cut-4', 'cut-5']);
}));

// ------------------------------------------------------------------ entradas hostis e arquivo da fila incompleto

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOSTILE_IDS = ['../../MEUS_DOCUMENTOS', '..\\..\\MEUS_DOCUMENTOS', '..', '.', 'all', 'a/b', 'a\\b', 'C:\\Windows', ' ', 'x'.repeat(65), 'com espaço', '../queue-irmao'];

/** Pasta "do usuário" fora da área de trabalho da fila, com um arquivo que não pode sumir. */
function makePrecious(dir) {
  const precious = path.join(dir, 'MEUS_DOCUMENTOS');
  fs.mkdirSync(precious, { recursive: true });
  fs.writeFileSync(path.join(precious, 'importante.txt'), 'não apague');
  return precious;
}
const preciousIntact = (precious) => fs.existsSync(path.join(precious, 'importante.txt')) && fs.readFileSync(path.join(precious, 'importante.txt'), 'utf8') === 'não apague';

/** Escreve um queue.json "de fora" (como se tivesse sido editado à mão ou salvo por outra versão). */
function writeQueueFile(dir, jobs, extra = {}) {
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, settings: {}, paused: false, completed: {}, jobs, ...extra }));
}
const without = (job, ...fields) => { const copy = { ...job }; for (const f of fields) delete copy[f]; return copy; };

test('o id vindo do renderer nunca vira caminho: ids hostis são trocados e nada fora da pasta de trabalho da fila é criado nem apagado', withDir(async (dir, mk) => {
  const precious = makePrecious(dir);
  const tmpRoot = path.join(dir, 'cache', 'queue');
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner, tmpRoot }).load();
  const views = q.enqueue([...HOSTILE_IDS.map((id, i) => makeJob(dir, i, { id })), makeJob(dir, HOSTILE_IDS.length, { id: 'valido-1_A' })]);

  for (const view of views.slice(0, -1)) {
    assert.match(view.id, SAFE_ID, `id trocado: ${view.id}`);
    assert.notEqual(view.id, 'all', '"all" é reservado para o cancelamento em massa');
  }
  assert.equal(views.at(-1).id, 'valido-1_A', 'um id comum continua como veio');
  assert.equal(new Set(views.map((v) => v.id)).size, views.length, 'todos distintos');

  await waitUntil(() => q.jobs.every((j) => j.state === 'done'), { timeout: 10000, what: 'todos terminarem' });
  assert.ok(preciousIntact(precious), 'a pasta de fora continua intacta');
  assert.equal(fake.calls.length, views.length);
  for (const call of fake.calls) assert.equal(path.dirname(call.opts.tmpDir), tmpRoot, `pasta de trabalho dentro da fila: ${call.opts.tmpDir}`);
  assert.equal(fs.existsSync(path.join(dir, 'queue-irmao')), false);
  assert.equal(fs.existsSync(path.join(dir, 'cache', 'queue-irmao')), false);
}));

test('o id ainda é conferido na hora de usar como pasta: um job já em memória com id hostil não cria nem apaga nada fora', withDir(async (dir, mk) => {
  const precious = makePrecious(dir);
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner, tmpRoot: path.join(dir, 'cache', 'queue') }).load();
  q.pause();
  const [view] = q.enqueue([makeJob(dir, 0)]);
  q.jobs.find((j) => j.id === view.id).id = '../../MEUS_DOCUMENTOS'; // defesa em profundidade: mesmo se algo escapar da validação de entrada
  q.resume();
  await waitUntil(() => q.jobs[0].state === 'done' || q.jobs[0].state === 'failed', { timeout: 5000 });
  assert.ok(preciousIntact(precious), 'a pasta de fora continua intacta');
}));

test('queue.json com id hostil: o id é trocado ao carregar e a pasta de fora continua intacta', withDir(async (dir, mk) => {
  const precious = makePrecious(dir);
  writeQueueFile(dir, HOSTILE_IDS.map((id, i) => ({ ...makeJob(dir, i, { id }), state: 'queued' })));
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner, tmpRoot: path.join(dir, 'cache', 'queue') }).load();
  assert.equal(q.jobs.length, HOSTILE_IDS.length);
  for (const job of q.jobs) assert.match(job.id, SAFE_ID, `id trocado: ${job.id}`);
  assert.equal(new Set(q.jobs.map((j) => j.id)).size, q.jobs.length);
  await waitUntil(() => q.jobs.every((j) => j.state === 'done'), { timeout: 10000 });
  assert.ok(preciousIntact(precious));
}));

test('profile.container hostil não muda o arquivo previsto: a fila só limpa o .part da pasta de saída', withDir(async (dir, mk) => {
  const outside = path.join(dir, 'fora.part');
  fs.writeFileSync(outside, 'de outro programa');
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  // "corte 0." + isto = ".../Cortes/corte 0.../../../fora": sobe para a pasta de cima
  for (const [i, container] of ['..\\..\\..\\fora', '../../../fora'].entries()) {
    const job = makeJob(dir, i);
    job.profile = { ...job.profile, container };
    q.enqueue([job]);
    await waitUntil(() => fake.calls.length === i + 1);
    q.cancel({ id: q.jobs[i].id });
    await waitUntil(() => q.jobs[i].state === 'cancelled');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'de outro programa', `nada fora da pasta de saída foi tocado (${container})`);
  }
}));

test('queue.json legível mas com trabalhos incompletos não derruba a fila: o ativo vira falha com causa e solução, o resto segue', withDir(async (dir, mk) => {
  const mkJob = (i, id, state) => ({ ...makeJob(dir, i, { id }), state });
  writeQueueFile(dir, [
    without(mkJob(0, 'sem-pasta', 'queued'), 'outputDir'),
    without(mkJob(1, 'sem-perfil', 'running'), 'profile'),
    without(mkJob(2, 'sem-nome', 'needsAction'), 'baseName'),
    { id: 'minimo', state: 'queued', sourcePath: path.join(dir, 'fonte.mp4'), baseName: 'a' },
    without(mkJob(3, 'feito-sem-pasta', 'done'), 'outputDir'),
    mkJob(4, 'bom', 'queued')
  ]);
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load(); // não pode lançar
  assert.equal(q.snapshot().recovery.pending, false, 'um incompleto não vira "interrompido" para recuperar');
  await waitUntil(() => stateOf(q, 'bom') === 'done', { timeout: 5000 });

  for (const id of ['sem-pasta', 'sem-perfil', 'sem-nome', 'minimo']) {
    const job = q.jobs.find((j) => j.id === id);
    assert.equal(job.state, 'failed', id);
    assert.equal(job.error.code, 'INVALID_STATE', id);
    assert.match(job.error.message, /incompleto/, id);
    assert.match(job.error.solution, /Remova.*de novo/, id);
  }
  assert.equal(stateOf(q, 'feito-sem-pasta'), 'done', 'um registro já finalizado continua como estava');
  assert.deepEqual(fake.calls.map((c) => c.job.id), ['bom'], 'só o completo foi para o executor');

  // tentar de novo um incompleto é recusado com a causa (e o agendador continua de pé)
  for (const id of ['sem-pasta', 'feito-sem-pasta']) assert.throws(() => q.retry(id), { code: 'INVALID_JOB', message: /incompleto/ }, id);
  const [again] = q.enqueue([makeJob(dir, 9)]);
  await waitUntil(() => stateOf(q, again.id) === 'done', { timeout: 5000 });
  assert.equal(q.remove('sem-pasta').removed, true);
}));

test('um job que quebra o agendador é marcado como falha (com causa) e não impede os outros', withDir(async (dir, mk) => {
  const fake = makeFakeRunner({ autoFinish: 1 });
  const q = mk({ runner: fake.runner }).load();
  q.pause();
  const [broken, fine] = q.enqueue([makeJob(dir, 0), makeJob(dir, 1)]);
  q.jobs.find((j) => j.id === broken.id).outputDir = undefined; // estado impossível de produzir pela entrada, mas o agendador não pode morrer por causa dele
  q.resume();
  await waitUntil(() => stateOf(q, fine.id) === 'done', { timeout: 5000 });
  assert.equal(stateOf(q, broken.id), 'failed');
  assert.equal(q.jobs.find((j) => j.id === broken.id).error.code, 'INVALID_STATE');
}));

test('se o arquivo da fila não puder ser interpretado, a fila sobe vazia, avisa e guarda a cópia (.corrupt)', withDir(async (dir) => {
  const { QueueStore } = require('../src/core/queue');
  writeQueueFile(dir, [{ ...makeJob(dir, 0, { id: 'a' }), state: 'queued' }]);
  class PoisonedStore extends QueueStore {
    read() {
      const res = super.read();
      res.data.jobs = [{ get id() { throw new Error('estrutura impossível'); } }];
      return res;
    }
  }
  const q = new QueueManager({ statePath: path.join(dir, 'queue.json'), store: new PoisonedStore(path.join(dir, 'queue.json')), tmpRoot: path.join(dir, 'queue-tmp'), tools: { ffmpeg: 'x' }, runner: makeFakeRunner().runner });
  try {
    assert.doesNotThrow(() => q.load());
    assert.deepEqual(q.jobs, []);
    assert.match(q.snapshot().loadWarning, /não foi possível carregar/i);
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.corrupt')), 'a cópia do arquivo ficou ao lado');
    q.enqueue([makeJob(dir, 1)]); // e a fila segue utilizável
    assert.equal(q.jobs.length, 1);
  } finally { q.shutdown(); }
}));

test('fechar o app durante uma exportação apaga o .part do trabalho interrompido (e só ele)', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => fake.calls.length === 1);
  const outDir = path.dirname(fake.calls[0].outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const part = `${fake.calls[0].outputPath}.part`;
  const stranger = path.join(outDir, 'de-outro-programa.mp4.part');
  fs.writeFileSync(part, 'meio do arquivo');
  fs.writeFileSync(stranger, 'não é nosso');
  q.shutdown(); // before-quit: o processo sai logo depois, sem dar chance ao executor de limpar
  assert.equal(fs.existsSync(part), false, 'o .part do que estava rodando não fica na pasta do usuário');
  assert.equal(fs.readFileSync(stranger, 'utf8'), 'não é nosso', 'um .part que não é deste trabalho nunca é tocado');
  assert.equal(readState(dir).jobs[0].state, 'interrupted');
  assert.equal(readState(dir).jobs[0].interruptedBy, 'shutdown');
}));

test('fechar o app não apaga um .part anterior à execução, nem de trabalho que não estava rodando', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.enqueue([makeJob(dir, 0), makeJob(dir, 1)]);
  await waitUntil(() => fake.calls.length === 1);
  const outDir = path.dirname(fake.calls[0].outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const oldPart = `${fake.calls[0].outputPath}.part`;
  fs.writeFileSync(oldPart, 'de antes');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(oldPart, past, past);
  const waitingPart = path.join(outDir, 'corte 1.mp4.part');
  fs.writeFileSync(waitingPart, 'de quem espera na fila');
  q.shutdown();
  assert.equal(fs.existsSync(oldPart), true, 'anterior ao início da execução: não é desta fila');
  assert.equal(fs.existsSync(waitingPart), true, 'o trabalho que não começou não tem .part para limpar');
}));

test('fechar o app com "Salvar com outro nome" também limpa o .part numerado ("nome (2).mp4.part")', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.enqueue([makeJob(dir, 0, { onConflict: 'rename' })]);
  await waitUntil(() => fake.calls.length === 1);
  const outDir = path.dirname(fake.calls[0].outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const numbered = path.join(outDir, 'corte 0 (2).mp4.part');
  const lookalike = path.join(outDir, 'corte 0 (extra).mp4.part');
  fs.writeFileSync(numbered, 'meio do arquivo');
  fs.writeFileSync(lookalike, 'não é nosso');
  q.shutdown();
  assert.equal(fs.existsSync(numbered), false);
  assert.equal(fs.existsSync(lookalike), true);
}));

test('QueueManager exige statePath', () => {
  assert.throws(() => new QueueManager({}), /statePath/);
});

test('textos de erro da fila sem jargão na linha principal: PATH, variável de ambiente e .part ficam nos detalhes técnicos', () => {
  const { SOLUTIONS, DEFAULT_MESSAGES, describeError, QueueError } = require('../src/core/queue/errors');
  for (const text of [...Object.values(SOLUTIONS), ...Object.values(DEFAULT_MESSAGES)]) {
    assert.doesNotMatch(text, /\bPATH\b|CORTE_[A-Z]+|variável de ambiente/, text);
    assert.doesNotMatch(text.replace('arquivo temporário (terminado em .part)', ''), /\.part\b/, text);
  }
  assert.match(SOLUTIONS.NO_FFMPEG, /ffmpeg\.org/, 'a solução continua dizendo onde obter o programa');
  const missing = describeError(new QueueError('NO_FFMPEG', 'O FFmpeg não foi encontrado, então não dá para exportar.'));
  assert.match(missing.technical, /PATH.*CORTE_FFMPEG/, 'o detalhe técnico (recolhido na tela) explica onde o app procura');
  assert.match(describeError(new QueueError('ABANDONED', '')).technical, /\.part/);
  // o detalhe do próprio motor (stderr) continua tendo prioridade
  assert.equal(describeError(Object.assign(new Error('x'), { code: 'NO_FFMPEG', details: { stderr: 'linha 1\nlinha 2' } })).technical, 'linha 1\nlinha 2');
  assert.equal(describeError(new Error('x')).technical, null);
});

// ------------------------------------------------------------------ limites de processamento (Etapa 3)

test('ajustes de limites: valores válidos entram, inválidos dizem o que usar', withDir(async (dir, mk) => {
  const q = mk({ runner: makeFakeRunner().runner }).load();
  assert.deepEqual([q.getSettings().lowPriority, q.getSettings().encodeThreads, q.getSettings().minFreeMemoryMb], [true, 0, 1024]);
  const next = q.setSettings({ lowPriority: false, encodeThreads: 4, minFreeMemoryMb: 2048 });
  assert.deepEqual([next.lowPriority, next.encodeThreads, next.minFreeMemoryMb], [false, 4, 2048]);
  assert.throws(() => q.setSettings({ lowPriority: 'sim' }), /Prioridade baixa/);
  assert.throws(() => q.setSettings({ encodeThreads: -1 }), /Núcleos por exportação/);
  assert.throws(() => q.setSettings({ encodeThreads: 2.5 }), /Núcleos por exportação/);
  assert.throws(() => q.setSettings({ minFreeMemoryMb: 'muito' }), /Memória livre mínima/);
  assert.equal(q.getSettings().encodeThreads, 4, 'um valor inválido não muda nada');
}));

test('o executor recebe os limites (prioridade baixa e núcleos) dos ajustes', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner }).load();
  q.setSettings({ encodeThreads: 3 });
  enqueueN(q, dir, 1);
  await waitUntil(() => fake.calls.length === 1);
  assert.deepEqual(fake.calls[0].opts.limits, { lowPriority: true, threads: 3 });
  fake.calls[0].finish();
  await waitUntil(() => h.states(q).every((s) => s === 'done'));
  q.setSettings({ lowPriority: false, encodeThreads: 0 });
  q.enqueue([makeJob(dir, 7)]); // outro corte (o primeiro já foi concluído)
  await waitUntil(() => fake.calls.length === 2);
  assert.deepEqual(fake.calls[1].opts.limits, { lowPriority: false, threads: 0 });
  fake.calls[1].finish();
}));

test('pouca memória livre: a primeira exportação sempre começa, as paralelas esperam, e voltam a andar quando a memória sobe', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  let freeMb = 300; // abaixo do mínimo (1024)
  const q = mk({ runner: fake.runner, freeMemoryMb: () => freeMb, throttleRecheckMs: 15 }).load();
  q.setSettings({ parallel: 3 });
  enqueueN(q, dir, 3);
  await waitUntil(() => fake.calls.length === 1, { what: 'a primeira começar apesar da pouca memória' });
  await h.sleep(60);
  assert.equal(fake.calls.length, 1, 'as paralelas esperam enquanto falta memória');
  assert.equal(q.snapshot().throttled.reason, 'memory');
  assert.equal(q.snapshot().throttled.freeMb, 300);
  assert.equal(q.snapshot().throttled.minMb, 1024);

  freeMb = 4000;
  await waitUntil(() => fake.calls.length === 3, { what: 'as outras começarem quando a memória volta' });
  assert.equal(q.snapshot().throttled, null);
  for (const call of fake.calls) call.finish();
}));

test('minFreeMemoryMb 0 desliga a conferência de memória', withDir(async (dir, mk) => {
  const fake = makeFakeRunner();
  const q = mk({ runner: fake.runner, freeMemoryMb: () => 1 }).load();
  q.setSettings({ parallel: 2, minFreeMemoryMb: 0 });
  enqueueN(q, dir, 2);
  await waitUntil(() => fake.calls.length === 2, { what: 'as duas rodarem juntas' });
  assert.equal(q.snapshot().throttled, null);
  for (const call of fake.calls) call.finish();
}));
