'use strict';

/**
 * Assinatura digital do instalador (src/core/update/signature.js): a política de confiança, o texto para a tela e a leitura de verdade pelo PowerShell
 * (num arquivo assinado do Windows e num sem assinatura; só LÊ a assinatura, nunca executa o arquivo).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/core/update/signature');

const valid = (subject) => ({ status: 'Valid', subject });
const NOT_SIGNED = { status: 'NotSigned', subject: null };
const SP = 'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US';

test('trustPolicy: a matriz inteira (instalador novo × programa em uso)', () => {
  const cases = [
    // [instalador, em uso, esperado]
    [NOT_SIGNED, NOT_SIGNED, { allow: true }],                               // hoje: nenhum é assinado (como a v0.1.0)
    [NOT_SIGNED, null, { allow: true }],                                     // em uso desconhecido (desenvolvimento)
    [{ status: 'Unknown', subject: null }, NOT_SIGNED, { allow: true }],     // não deu para ler: vale como sem assinatura
    [valid(SP), NOT_SIGNED, { allow: true }],                                // a primeira versão assinada
    [valid(SP), valid(SP), { allow: true }],                                 // mesmo emissor
    [valid('CN=Outro'), valid(SP), { allow: false, reason: 'SIGNER_CHANGED' }],
    [NOT_SIGNED, valid(SP), { allow: false, reason: 'DOWNGRADE' }],          // quem é assinado não aceita sem assinatura
    [{ status: 'Unknown', subject: null }, valid(SP), { allow: false, reason: 'DOWNGRADE' }],
    [{ status: 'HashMismatch', subject: SP }, NOT_SIGNED, { allow: false, reason: 'INVALID_SIGNATURE' }],
    [{ status: 'NotTrusted', subject: SP }, valid(SP), { allow: false, reason: 'INVALID_SIGNATURE' }],
    [{ status: 'UnknownError', subject: null }, NOT_SIGNED, { allow: false, reason: 'INVALID_SIGNATURE' }]
  ];
  for (const [next, running, want] of cases) assert.deepEqual(S.trustPolicy(next, running), want, `${next.status} × ${running && running.status}`);
  for (const reason of ['INVALID_SIGNATURE', 'DOWNGRADE', 'SIGNER_CHANGED']) assert.match(S.REASONS[reason], /Nada foi instalado/);
});

test('signerName e describeSignature: o nome do emissor e o texto para a tela, sem prometer o que não há', () => {
  assert.equal(S.signerName(SP), 'SignPath Foundation');
  assert.equal(S.signerName('CN="Fulano, Ltda", O=x'), 'Fulano, Ltda');
  assert.equal(S.signerName('O=sem cn'), null);
  assert.equal(S.signerName(null), null);
  assert.equal(S.describeSignature(valid(SP)), 'Assinatura digital válida (SignPath Foundation).');
  assert.match(S.describeSignature(NOT_SIGNED), /Sem assinatura digital.*SHA-256/);
  assert.match(S.describeSignature({ status: 'Unknown' }), /não verificada.*SHA-256/);
  assert.match(S.describeSignature({ status: 'HashMismatch' }), /inválida/);
  assert.equal(S.describeSignature(null), '');
});

test('readSignature com o PowerShell de mentira: lê o JSON, e qualquer falha vira Unknown (nunca lança)', async () => {
  const ok = (stdout) => (cmd, args, opts, cb) => { assert.equal(cmd, 'powershell.exe'); assert.ok(args.includes('-NoProfile')); cb(null, stdout); };
  assert.deepEqual(await S.readSignature('C:\\a.exe', { exec: ok('{"status":"Valid","subject":"CN=X"}') }), { status: 'Valid', subject: 'CN=X' });
  assert.deepEqual(await S.readSignature('C:\\a.exe', { exec: ok('{"status":"NotSigned","subject":null}') }), { status: 'NotSigned', subject: null });
  for (const bad of ['', 'não é json', '{"status":""}', '[]', 'null']) assert.equal((await S.readSignature('C:\\a.exe', { exec: ok(bad) })).status === 'Valid', false, bad);
  assert.deepEqual(await S.readSignature('C:\\a.exe', { exec: (c, a, o, cb) => cb(new Error('falhou')) }), { status: 'Unknown', subject: null });
  assert.deepEqual(await S.readSignature('C:\\a.exe', { exec: () => { throw new Error('spawn'); } }), { status: 'Unknown', subject: null });
  assert.deepEqual(await S.readSignature('/a', { platform: 'linux' }), { status: 'Unsupported', subject: null });
  // o caminho vai pelo ambiente (nunca montado dentro do comando): aspas e "$(...)" no nome não viram código
  let seenEnv = null;
  await S.readSignature('C:\\a "b" $(calc).exe', { exec: (c, a, o, cb) => { seenEnv = o.env.BF_SIG_FILE; assert.ok(!a.join(' ').includes('calc')); cb(null, '{}'); } });
  assert.equal(seenEnv, 'C:\\a "b" $(calc).exe');
});

test('PowerShell de verdade: um arquivo assinado do Windows dá Valid com emissor; um arquivo sem assinatura dá NotSigned', { skip: process.platform !== 'win32' && 'só no Windows', timeout: 120000 }, async (t) => {
  const signed = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
  const sig = await S.readSignature(signed);
  assert.equal(sig.status, 'Valid', `notepad.exe: ${JSON.stringify(sig)}`);
  assert.match(S.signerName(sig.subject) || '', /Microsoft/i);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // um programa VÁLIDO sem assinatura (o electron.exe do próprio projeto): NotSigned, e a política o aceita só se o app em uso também não é assinado
  const unsigned = await S.readSignature(require('electron'));
  assert.deepEqual(unsigned, { status: 'NotSigned', subject: null });
  assert.equal(S.trustPolicy(unsigned, unsigned).allow, true);
  assert.equal(S.trustPolicy(unsigned, sig).allow, false, 'em uso assinado: sem assinatura é rebaixamento');
  // um arquivo que NÃO é um programa válido (download corrompido, texto chamado .exe): não é "sem assinatura", é recusado; o nome vai pelo ambiente
  const garbage = path.join(dir, 'corrompido $(x).exe');
  fs.writeFileSync(garbage, 'MZ nao e um programa de verdade');
  const bad = await S.readSignature(garbage);
  assert.notEqual(bad.status, 'Valid');
  assert.equal(S.trustPolicy(bad, unsigned).allow, false, `status ${bad.status}: recusado`);
  assert.equal((await S.readSignature(path.join(dir, 'nao-existe.exe'))).status === 'Valid', false);
});
