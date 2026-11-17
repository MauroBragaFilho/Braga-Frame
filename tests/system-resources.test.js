'use strict';

/** Monitor de recursos (src/core/system/resources.js): CPU entre duas leituras, memória, disco e placa NVIDIA, tudo com módulos falsos. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceMonitor, parseGpuUsage, lowerPriority } = require('../src/core/system/resources');

const fakeOs = (script) => {
  let i = 0;
  return {
    cpus: () => script[Math.min(i++, script.length - 1)],
    totalmem: () => 16 * 1024 * 1024 * 1024,
    freemem: () => 6 * 1024 * 1024 * 1024,
    constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
    setPriority(pid, value) { this.calls = [...(this.calls || []), [pid, value]]; }
  };
};
const core = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

test('parseGpuUsage lê o CSV do nvidia-smi e ignora linhas ruins', () => {
  const out = parseGpuUsage('NVIDIA GeForce GTX 1650, 37, 1500, 4096\nlixo\n,1,2,3\nOutra, x, 1, 2\n');
  assert.deepEqual(out, [{ name: 'NVIDIA GeForce GTX 1650', utilPercent: 37, memUsedMb: 1500, memTotalMb: 4096 }]);
  assert.deepEqual(parseGpuUsage(''), []);
});

test('CPU: a primeira leitura é null; a segunda é a média entre as duas', async () => {
  const monitor = createResourceMonitor({
    osModule: fakeOs([[core(100, 0), core(100, 0)], [core(150, 150), core(150, 150)]]), // 2 núcleos: +50 parados e +150 ocupados = 75%
    execFileFn: (exe, args, o, cb) => cb(new Error('sem nvidia-smi')), existsFn: () => true
  });
  const first = await monitor.sample();
  assert.equal(first.cpu.percent, null);
  const second = await monitor.sample();
  assert.equal(second.cpu.percent, 75);
  assert.equal(second.cpu.cores, 2);
  assert.deepEqual(second.memory, { totalMb: 16384, freeMb: 6144 });
  assert.equal(second.gpu, null, 'sem nvidia-smi: nada de placa, e nada lança');
});

test('GPU: usa a de mais memória e guarda a leitura por alguns segundos', async () => {
  let calls = 0;
  let clock = 1000;
  const monitor = createResourceMonitor({
    osModule: fakeOs([[core(1, 1)]]), now: () => clock, existsFn: () => true, platform: 'linux',
    execFileFn: (exe, args, o, cb) => { calls += 1; cb(null, 'Pequena, 5, 100, 2048\nGrande, 61, 3000, 8192\n'); }
  });
  const a = await monitor.sample();
  assert.equal(a.gpu.name, 'Grande');
  assert.equal(a.gpu.utilPercent, 61);
  await monitor.sample();
  assert.equal(calls, 1, 'segunda leitura dentro do cache');
  clock += 5000;
  await monitor.sample();
  assert.equal(calls, 2, 'depois do prazo consulta de novo');
});

test('disco: espaço livre de cada pasta; pasta que não existe vira null; lista é limpa e limitada', async () => {
  const monitor = createResourceMonitor({
    osModule: fakeOs([[core(1, 1)]]), execFileFn: (e, a, o, cb) => cb(new Error('x')), existsFn: () => false,
    fsModule: { statfsSync: (dir) => { if (dir === 'C:\\sumiu') throw new Error('ENOENT'); return { bavail: 2048, bsize: 1024 * 1024 }; } }
  });
  const s = await monitor.sample({ dirs: ['C:\\videos', 'C:\\videos', 'C:\\sumiu', '', 5] });
  assert.deepEqual(s.disks, [{ dir: 'C:\\videos', freeMb: 2048 }, { dir: 'C:\\sumiu', freeMb: null }]);
});

test('lowerPriority: baixa a prioridade; pid inválido ou erro do sistema não lança', () => {
  const osm = fakeOs([[core(1, 1)]]);
  assert.equal(lowerPriority(1234, osm), true);
  assert.deepEqual(osm.calls, [[1234, 10]]);
  assert.equal(lowerPriority(0, osm), false);
  assert.equal(lowerPriority('x', osm), false);
  assert.equal(lowerPriority(9, { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority() { throw new Error('EPERM'); } }), false);
});
