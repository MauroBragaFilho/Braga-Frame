'use strict';

/**
 * Persistência da fila (queue.json: gravação atômica, arquivo corrompido preservado) e chave estável do job.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { QueueStore, QueueManager, jobKey, predictOutputPath, safeBaseName } = require('../src/core/queue');
const h = require('./queue-helpers');

const { makeJob, makeFakeRunner, makeManager, waitUntil } = h;

function withDir(fn) {
  return async () => {
    const dir = h.tmpDir('queue-store');
    try { await fn(dir); } finally { h.removeDir(dir); }
  };
}

/** fs que falha de um jeito escolhido, deixando o resto passar para o fs de verdade. */
function faultyFs(overrides) {
  return new Proxy(fs, { get: (target, prop) => (prop in overrides ? overrides[prop] : target[prop]) });
}

const names = (dir) => fs.readdirSync(dir).sort();

// ------------------------------------------------------------------ gravação atômica

test('gravação: arquivo final válido, versão e data, nenhum .tmp sobrando', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  const store = new QueueStore(file);
  store.write({ jobs: [{ id: 'a' }], settings: { retries: 2 } });
  assert.deepEqual(names(dir), ['queue.json']);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.version, 1);
  assert.ok(Date.parse(data.savedAt));
  assert.deepEqual(data.jobs, [{ id: 'a' }]);
  store.write({ jobs: [{ id: 'b' }] }); // sobrescreve o anterior
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs, [{ id: 'b' }]);
  assert.deepEqual(names(dir), ['queue.json']);
}));

test('queda no meio da gravação: o arquivo anterior fica intacto e o temporário é removido', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  new QueueStore(file).write({ jobs: [{ id: 'bom' }] });
  const before = fs.readFileSync(file, 'utf8');

  // 1) falha ao renomear (disco cheio/IO)
  const renameFails = new QueueStore(file, { fsImpl: faultyFs({ renameSync() { throw Object.assign(new Error('falha de E/S'), { code: 'EIO' }); } }) });
  assert.throws(() => renameFails.write({ jobs: [{ id: 'novo' }] }), /falha de E\/S/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(names(dir), ['queue.json']);

  // 2) falha escrevendo (a metade do conteúdo nunca chega ao arquivo final)
  const writeFails = new QueueStore(file, { fsImpl: faultyFs({ writeSync(fd, data) { fs.writeSync(fd, String(data).slice(0, 10)); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }) });
  assert.throws(() => writeFails.write({ jobs: [{ id: 'novo' }] }), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(names(dir), ['queue.json']);
}));

test('rename bloqueado por um instante (antivírus no Windows) é repetido; bloqueio permanente falha sem estragar nada', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  let blocks = 2;
  const flaky = faultyFs({ renameSync(a, b) { if (blocks-- > 0) throw Object.assign(new Error('arquivo em uso'), { code: 'EPERM' }); return fs.renameSync(a, b); } });
  new QueueStore(file, { fsImpl: flaky, retryDelayMs: 1 }).write({ jobs: [{ id: 'x' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs, [{ id: 'x' }]);
  assert.deepEqual(names(dir), ['queue.json']);

  const stuck = new QueueStore(file, { fsImpl: faultyFs({ renameSync() { throw Object.assign(new Error('em uso'), { code: 'EBUSY' }); } }), retries: 2, retryDelayMs: 1 });
  assert.throws(() => stuck.write({ jobs: [] }), /em uso/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs, [{ id: 'x' }]);
  assert.deepEqual(names(dir), ['queue.json']);
}));

test('outro processo lendo o arquivo durante muitas gravações nunca vê JSON pela metade', withDir(async (dir) => {
  const file = path.join(dir, 'queue.json');
  const store = new QueueStore(file);
  store.write({ jobs: [] });
  // leitor em OUTRO processo (lendo a cada ~2 ms), enquanto este processo grava sem parar. O leitor só para depois de o
  // gravador terminar (arquivo de parada, fora da pasta da fila) E de ter lido com sucesso mais de 100 vezes: com o computador
  // ocupado ele roda bem mais devagar, e o que importa é a quantidade de leituras, não um tempo fixo. `hardEnd` evita travar.
  const signalDir = h.tmpDir('queue-store-sinal');
  const stopFile = path.join(signalDir, 'parar');
  const reader = `
    const fs = require('node:fs');
    const hardEnd = Date.now() + Number(process.argv[2]);
    let ok = 0, broken = 0, busy = 0;
    while (Date.now() < hardEnd && (!fs.existsSync(process.argv[3]) || ok < 101)) {
      try { JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); ok++; }
      catch (err) { if (err instanceof SyntaxError) broken++; else busy++; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    console.log(JSON.stringify({ ok, broken, busy }));`;
  const child = spawn(process.execPath, ['-e', reader, file, '60000', stopFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await h.sleep(150); // o leitor sobe
  const big = Array.from({ length: 400 }, (_, i) => ({ id: `job-${i}`, texto: 'x'.repeat(200) }));
  const stopAt = Date.now() + 900;
  let writes = 0;
  let refused = 0; // o Windows pode recusar o rename se o leitor estiver com o arquivo aberto naquele instante
  try {
    // com o computador ocupado uma única gravação pode esperar centenas de milissegundos (o rename recusado é repetido com pausas): o que importa é
    // a quantidade de gravações, não os 900 ms. Passado o tempo, continua até o mínimo de 8 (com teto de 30 s para não travar).
    while (Date.now() < stopAt || (writes < 8 && Date.now() < stopAt + 30000)) {
      try { store.write({ jobs: big.slice(0, 50 + (writes % 350)) }); } catch (err) { if (err.code === 'EPERM' || err.code === 'EBUSY') refused += 1; else throw err; }
      writes += 1;
    }
  } finally {
    fs.writeFileSync(stopFile, '1'); // avisa o leitor (mesmo se a gravação falhar, para ele não ficar rodando)
  }
  await closed;
  h.removeDir(signalDir);
  const seen = JSON.parse(out);
  assert.ok(writes >= 8, `gravou ${writes} vezes`);
  assert.ok(refused <= writes * 0.2, `${refused} de ${writes} gravações recusadas pelo sistema`);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.length >= 50, 'o arquivo final é válido');
  assert.deepEqual(names(dir), ['queue.json'], 'sem .tmp sobrando mesmo nas recusadas');
  assert.ok(seen.ok > 100, `o leitor leu ${seen.ok} vezes (${seen.busy} recusadas por arquivo em uso)`);
  assert.equal(seen.broken, 0, 'nenhuma leitura pegou JSON incompleto');
}));

// ------------------------------------------------------------------ leitura defensiva

test('leitura: sem arquivo = vazio; BOM tolerado; sobras .tmp de uma gravação interrompida são apagadas', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  const store = new QueueStore(file);
  assert.deepEqual(store.read(), { data: null, warning: null });
  fs.writeFileSync(`${file}.1234.tmp`, '{ meio');
  fs.writeFileSync(path.join(dir, 'outro.tmp'), 'não é nosso');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ version: 1, jobs: [{ id: 'a' }] })}`);
  const res = store.read();
  assert.equal(res.data.jobs[0].id, 'a');
  assert.deepEqual(names(dir), ['outro.tmp', 'queue.json'], 'só o nosso temporário some');
}));

test('arquivo corrompido nunca é apagado: vira .corrupt, com aviso, e a fila começa vazia', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  for (const [bad, label] of [['{"jobs": [', 'JSON quebrado'], ['[1,2,3]', 'não é objeto'], ['{"jobs": 5}', 'jobs inválido']]) {
    fs.writeFileSync(file, bad);
    const res = new QueueStore(file).read();
    assert.equal(res.data, null, label);
    assert.match(res.warning, /corrompido|formato esperado/, label);
    assert.ok(res.preservedAs && fs.existsSync(res.preservedAs), `${label}: cópia preservada`);
    assert.equal(fs.readFileSync(res.preservedAs, 'utf8'), bad);
    assert.equal(fs.existsSync(file), false);
  }
}));

test('arquivo de uma versão mais nova do app é preservado (.vN.bak), não destruído', withDir((dir) => {
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, JSON.stringify({ version: 7, jobs: [{ id: 'futuro' }] }));
  const res = new QueueStore(file).read();
  assert.equal(res.data, null);
  assert.match(res.warning, /versão mais nova/);
  assert.match(path.basename(res.preservedAs), /\.v7\.bak$/);
  assert.equal(JSON.parse(fs.readFileSync(res.preservedAs, 'utf8')).jobs[0].id, 'futuro');
}));

test('gerenciador com queue.json corrompido: começa vazio, avisa (loadWarning) e a cópia fica no disco', withDir((dir) => {
  fs.writeFileSync(path.join(dir, 'queue.json'), '{ isto não é json');
  const q = makeManager(dir, { runner: makeFakeRunner().runner }).load();
  assert.deepEqual(q.jobs, []);
  assert.match(q.snapshot().loadWarning, /corrompido/);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.corrupt')));
  q.shutdown();
}));

test('falha ao gravar não derruba a fila: fica em saveError e some quando a gravação volta a funcionar', withDir(async (dir) => {
  let broken = true;
  const store = new QueueStore(path.join(dir, 'queue.json'), { fsImpl: faultyFs({ openSync(...args) { if (broken) throw Object.assign(new Error('sem permissão'), { code: 'EACCES' }); return fs.openSync(...args); } }) });
  const q = new QueueManager({ statePath: path.join(dir, 'queue.json'), store, tmpRoot: path.join(dir, 'queue-tmp'), tools: { ffmpeg: 'x' }, runner: makeFakeRunner({ autoFinish: 1 }).runner, updateIntervalMs: 3, progressIntervalMs: 0 });
  q.load();
  q.enqueue([makeJob(dir, 0)]);
  await waitUntil(() => q.jobs[0].state === 'done');
  assert.match(q.snapshot().saveError, /Não foi possível salvar o estado da fila/);
  broken = false;
  q.enqueue([makeJob(dir, 1)]);
  await waitUntil(() => q.jobs[1].state === 'done');
  await waitUntil(() => q.snapshot().saveError === null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')).jobs.length, 2);
  q.shutdown();
}));

test('o estado em disco reflete a fila durante o trabalho (nunca JSON inválido) e guarda ajustes e histórico', withDir(async (dir) => {
  const fake = makeFakeRunner({ autoFinish: 2 });
  const q = makeManager(dir, { runner: fake.runner }).load();
  q.setSettings({ parallel: 3, retries: 4, recovery: 'resume', onConflict: 'rename' });
  let broken = 0;
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      try { JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')); } catch (err) { if (err instanceof SyntaxError) broken += 1; }
      await new Promise((r) => setImmediate(r));
    }
  })();
  q.enqueue(Array.from({ length: 30 }, (_, i) => makeJob(dir, i)));
  await waitUntil(() => q.jobs.every((j) => j.state === 'done'), { timeout: 10000 });
  q.flush();
  stop = true;
  await poll;
  assert.equal(broken, 0);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
  assert.deepEqual(disk.settings, { parallel: 3, retries: 4, recovery: 'resume', onConflict: 'rename', lowPriority: true, encodeThreads: 0, minFreeMemoryMb: 1024 });
  assert.equal(disk.jobs.length, 30);
  assert.equal(Object.keys(disk.completed).length, 30);
  q.shutdown();

  const again = makeManager(dir, { runner: fake.runner }).load();
  assert.deepEqual(again.getSettings(), { parallel: 3, retries: 4, recovery: 'resume', onConflict: 'rename', lowPriority: true, encodeThreads: 0, minFreeMemoryMb: 1024, effectiveParallel: 3, defaultParallel: 1 });
  assert.equal(again.jobs.length, 30);
  again.shutdown();
}));

// ------------------------------------------------------------------ chave estável do job

test('jobKey: estável (ordem das chaves não importa) e sensível a tudo que muda o resultado', () => {
  const base = makeJob(path.join('D:', 'dados'), 0, { sourcePath: path.join('D:', 'dados', 'fonte.mp4') }); // nada é criado em disco: a chave só olha os dados
  const key = jobKey(base);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(jobKey(JSON.parse(JSON.stringify(base))), key);
  const reordered = { profile: base.profile, cut: base.cut, sourcePath: base.sourcePath, sourceInfo: base.sourceInfo, framing: base.framing };
  assert.equal(jobKey(reordered), key, 'a ordem das propriedades não muda a chave');
  assert.equal(jobKey({ ...base, id: 'outro', baseName: 'outro nome', outputDir: 'D:\\outra', onConflict: 'replace', projectTitle: 'x', createdAt: 'ontem' }), key, 'id, nome, pasta e conflito não fazem parte da chave');

  const changed = [
    ['fonte', { sourcePath: `${base.sourcePath}.2` }],
    ['duração da fonte', { sourceInfo: { ...base.sourceInfo, duration: 601 } }],
    ['início', { cut: { ...base.cut, start: base.cut.start + 0.5 } }],
    ['fim', { cut: { ...base.cut, end: base.cut.end + 0.5 } }],
    ['perfil: bitrate', { profile: { ...base.profile, bitrateKbps: 12000 } }],
    ['perfil: codec', { profile: { ...base.profile, codec: 'h265' } }],
    ['enquadramento do job', { framing: { mode: 'center', focusX: 0.4, zoom: 1 } }],
    ['enquadramento do corte', { cut: { ...base.cut, framing: { mode: 'blur', blur: { strength: 10 } } } }],
    ['áudio: ganho', { cut: { ...base.cut, audio: { ...base.cut.audio, gainDb: 2 } } }],
    ['áudio: mudo', { cut: { ...base.cut, audio: { ...base.cut.audio, mute: true } } }],
    ['legendas ligadas', { cut: { ...base.cut, subtitles: { enabled: true, mode: 'burn', cues: [{ start: 1, end: 2, text: 'a' }] } } }]
  ];
  const keys = new Set([key]);
  for (const [what, patch] of changed) {
    const k = jobKey({ ...base, ...patch });
    assert.ok(!keys.has(k), `${what} muda a chave`);
    keys.add(k);
  }
  // legendas: o texto conta; desligadas equivalem a sem legendas
  const withSubs = (text, enabled = true) => jobKey({ ...base, cut: { ...base.cut, subtitles: { enabled, mode: 'burn', cues: [{ start: 1, end: 2, text }] } } });
  assert.notEqual(withSubs('a'), withSubs('b'));
  assert.equal(withSubs('a', false), key);
  // cosmético não conta
  assert.equal(jobKey({ ...base, profile: { ...base.profile, name: 'Outro', resolutionLabel: '1080p' } }), key);
});

test('predictOutputPath e safeBaseName seguem a mesma limpeza do exportador', () => {
  assert.equal(safeBaseName('live: "melhor" jogada?'), 'live_ _melhor_ jogada_');
  assert.equal(safeBaseName('   '), 'corte');
  assert.equal(safeBaseName('termina com ponto. '), 'termina com ponto');
  assert.equal(safeBaseName('a\u0001b'), 'a_b');
  const job = { outputDir: path.join('D:', 'Cortes'), baseName: 'x/y', profile: { container: 'mp4' } };
  assert.equal(predictOutputPath(job), path.join('D:', 'Cortes', 'x_y.mp4'));
  assert.equal(predictOutputPath({ ...job, profile: {} }), path.join('D:', 'Cortes', 'x_y.mp4'));
});

test('jobKey: o formato do arquivo de legenda faz parte da chave (SRT e ASS geram arquivos diferentes); modos equivalentes dão a mesma chave', () => {
  const base = makeJob(path.join('D:', 'dados'), 0, { sourcePath: path.join('D:', 'dados', 'fonte.mp4') });
  const cues = [{ start: 1, end: 2, text: 'oi' }];
  const keyOf = (sub) => jobKey({ ...base, cut: { ...base.cut, subtitles: { enabled: true, cues, ...sub } } });

  assert.notEqual(keyOf({ mode: 'sidecar', sidecarFormat: 'srt' }), keyOf({ mode: 'sidecar', sidecarFormat: 'ass' }), 'só arquivo separado: SRT x ASS');
  assert.notEqual(keyOf({ mode: 'both', sidecarFormat: 'srt' }), keyOf({ mode: 'both', sidecarFormat: 'ass' }), 'queimada + arquivo: SRT x ASS');
  assert.equal(keyOf({ mode: 'sidecar' }), keyOf({ mode: 'sidecar', sidecarFormat: 'srt' }), 'sem formato = SRT (o padrão do motor)');
  assert.equal(keyOf({ mode: 'srt' }), keyOf({ mode: 'sidecar', sidecarFormat: 'srt' }), 'modo antigo "srt"');
  assert.equal(keyOf({ mode: 'burn+ass' }), keyOf({ mode: 'both', sidecarFormat: 'ass' }), 'modo antigo "burn+ass"');
  assert.equal(keyOf({ mode: 'burn', sidecarFormat: 'srt' }), keyOf({ mode: 'burn', sidecarFormat: 'ass' }), 'só queimada: não há arquivo separado, o formato não muda nada');
  assert.notEqual(keyOf({ mode: 'burn' }), keyOf({ mode: 'sidecar' }), 'queimar x arquivo separado');
  assert.notEqual(keyOf({ mode: 'both', sidecarFormat: 'srt' }), keyOf({ mode: 'burn' }), 'queimada + arquivo x só queimada');
});

test('jobKey: o áudio conta pelo efeito no resultado, não pelo histórico (desfazer/refazer) nem por valores que dão o mesmo filtro', () => {
  const AH = require('../src/core/audio/audioHistory');
  const base = makeJob(path.join('D:', 'dados'), 0, { sourcePath: path.join('D:', 'dados', 'fonte.mp4') }); // corte de 20 s (10 a 30)
  const keyOf = (audio) => jobKey({ ...base, cut: { ...base.cut, audio } });
  const neutral = base.cut.audio;

  // aplicar e desfazer devolve os mesmos valores, mas deixa a pilha de "refazer" no corte
  const applied = AH.applyChange(neutral, { gainDb: 3 }, { now: 1000 }).audio;
  const undone = AH.undo(applied).audio;
  assert.equal(undone.gainDb, 0);
  assert.ok(undone.redo && undone.redo.length === 1);
  assert.equal(keyOf(undone), keyOf(neutral), 'desfazer volta à mesma chave do áudio original');
  assert.equal(keyOf({ ...neutral, history: [{ at: 'x' }], redo: [{ at: 'y' }] }), keyOf(neutral), 'histórico e refazer não mudam o resultado');
  assert.equal(keyOf(undefined), keyOf(neutral), 'sem ajuste = ajuste neutro');
  assert.equal(keyOf({ gainDb: '0', mute: false }), keyOf(neutral), 'valores crus equivalentes');

  // mesmo filtro, mesma chave: mudo vence qualquer ganho/fade; fades acima da metade do corte são limitados
  assert.equal(keyOf({ ...neutral, mute: true, gainDb: 6 }), keyOf({ ...neutral, mute: true, gainDb: -12, fadeInSec: 2 }));
  assert.equal(keyOf({ ...neutral, fadeInSec: 50 }), keyOf({ ...neutral, fadeInSec: 10 }), 'fade de 50 s num corte de 20 s = 10 s');
  assert.equal(keyOf({ ...neutral, gainDb: 99 }), keyOf({ ...neutral, gainDb: 20 }), 'ganho acima do limite');

  // o que muda o som continua mudando a chave
  const distinct = [neutral, { ...neutral, gainDb: 3 }, { ...neutral, gainDb: 6 }, { ...neutral, mute: true }, { ...neutral, fadeInSec: 1 }, { ...neutral, fadeInSec: 2 }, { ...neutral, fadeOutSec: 1 }, { ...neutral, gainDb: 3, fadeOutSec: 1 }];
  assert.equal(new Set(distinct.map(keyOf)).size, distinct.length);
});

test('predictOutputPath: o contêiner do perfil nunca decide o caminho (o motor só grava .mp4)', () => {
  const dir = path.join('D:', 'Cortes');
  for (const container of ['..\\..\\fora', '../../fora', 'mkv', '', undefined, null, 42, 'mp4/../../x']) {
    const out = predictOutputPath({ outputDir: dir, baseName: 'corte 1', profile: { container } });
    assert.equal(out, path.join(dir, 'corte 1.mp4'), String(container));
  }
  // o nome do arquivo também fica dentro da pasta de saída
  for (const baseName of ['../../fora', '..\\..\\fora', '..', 'a/b']) {
    const out = predictOutputPath({ outputDir: dir, baseName, profile: { container: 'mp4' } });
    assert.equal(path.dirname(out), dir, baseName);
  }
});
