'use strict';

/** Aviso de versão nova (src/core/update/check.js): versões, endereços, formato da Release do GitHub, erros e o que é enviado. */

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/core/update/check');

const REPO = 'MauroBragaFilho/Braga-Frame';

/** Release no formato real da API do GitHub (campos conferidos numa Release de verdade do BDS), só com o que o app lê. */
const release = (patch = {}) => ({
  tag_name: 'v0.2.0',
  html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
  draft: false,
  prerelease: false,
  published_at: '2026-11-17T12:00:00Z',
  assets: [{
    name: 'braga-frame-0.2.0-windows-x64-setup.exe', size: 114356807, digest: `sha256:${'ab'.repeat(32)}`,
    browser_download_url: `https://github.com/${REPO}/releases/download/v0.2.0/braga-frame-0.2.0-windows-x64-setup.exe`
  }],
  ...patch
});

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => { if (body instanceof Error) throw body; return body; } });

test('parseVersion: só X.Y.Z (com ou sem "v"); pré-lançamento e texto solto não valem', () => {
  assert.deepEqual(U.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(U.parseVersion(' 0.10.0 '), [0, 10, 0]);
  for (const bad of ['1.2', '1.2.3-beta', 'v1.2.3.4', 'latest', '', null, undefined, '1.2.x']) assert.equal(U.parseVersion(bad), null, String(bad));
});

test('compareVersions: compara número a número (0.10.0 é maior que 0.9.0); inválida dá null', () => {
  assert.equal(U.compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(U.compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(U.compareVersions('v0.1.0', '0.2.0'), -1);
  assert.equal(U.compareVersions('0.10.0', '0.9.0'), 1, 'não é ordem de texto');
  assert.equal(U.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(U.compareVersions('1.0.0-rc1', '1.0.0'), null);
});

test('isReleaseUrl: só páginas de Releases do repositório, em https no github.com, sem usuário nem porta', () => {
  for (const ok of [`https://github.com/${REPO}/releases`, `https://github.com/${REPO}/releases/tag/v1.0.0`, `https://GitHub.com/${REPO.toLowerCase()}/releases/latest`]) assert.equal(U.isReleaseUrl(ok, REPO), true, ok);
  const bad = [
    `http://github.com/${REPO}/releases`, `https://github.com.evil.example/${REPO}/releases`, `https://evil.example/${REPO}/releases`,
    'https://github.com/outro/repo/releases', `https://github.com/${REPO}-falso/releases`, `https://github.com/${REPO}/issues`, `https://github.com/${REPO}`,
    `https://user:pw@github.com/${REPO}/releases`, `https://github.com:8443/${REPO}/releases`, 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', '', null, undefined
  ];
  for (const url of bad) assert.equal(U.isReleaseUrl(url, REPO), false, String(url));
});

test('parseRelease: versão, tag, endereço, data e tamanho do instalador; rascunho, pré-lançamento e tag fora do padrão viram null', () => {
  assert.deepEqual(U.parseRelease(release(), REPO), {
    version: '0.2.0', tag: 'v0.2.0', url: `https://github.com/${REPO}/releases/tag/v0.2.0`, publishedAt: '2026-11-17T12:00:00Z', sizeBytes: 114356807,
    asset: { name: 'braga-frame-0.2.0-windows-x64-setup.exe', url: `https://github.com/${REPO}/releases/download/v0.2.0/braga-frame-0.2.0-windows-x64-setup.exe`, size: 114356807, sha256: 'ab'.repeat(32) }
  });
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'nightly' }, { tag_name: 'v1.0' }, { tag_name: undefined }]) assert.equal(U.parseRelease(release(patch), REPO), null, JSON.stringify(patch));
  for (const bad of [null, undefined, 'x', 5, []]) assert.equal(U.parseRelease(bad, REPO), null);
  assert.equal(U.parseRelease(release({ assets: [{ name: 'outro.zip', size: 5 }] }), REPO).sizeBytes, null, 'sem o instalador no padrão, sem tamanho');
  assert.equal(U.parseRelease(release({ assets: undefined }), REPO).sizeBytes, null);
});

test('isAssetUrl: só o endereço de download do arquivo da Release do repositório; em teste, a origem do servidor local no lugar do github.com', () => {
  const ok = { repo: REPO, tag: 'v0.2.0', name: 'braga-frame-0.2.0-windows-x64-setup.exe' };
  assert.equal(U.isAssetUrl(`https://github.com/${REPO}/releases/download/v0.2.0/${ok.name}`, ok), true);
  assert.equal(U.isAssetUrl(`https://GitHub.com/${REPO.toLowerCase()}/releases/download/V0.2.0/${ok.name}`, ok), true, 'sem diferenciar maiúsculas');
  const bad = [
    `http://github.com/${REPO}/releases/download/v0.2.0/${ok.name}`, `https://evil.example/${REPO}/releases/download/v0.2.0/${ok.name}`,
    `https://github.com.evil.example/${REPO}/releases/download/v0.2.0/${ok.name}`, `https://github.com/${REPO}/releases/download/v0.2.1/${ok.name}`,
    `https://github.com/${REPO}/releases/download/v0.2.0/outro.exe`, `https://github.com/outro/repo/releases/download/v0.2.0/${ok.name}`,
    `https://github.com/${REPO}/releases/tag/v0.2.0`, `https://user:pw@github.com/${REPO}/releases/download/v0.2.0/${ok.name}`,
    `https://github.com:8443/${REPO}/releases/download/v0.2.0/${ok.name}`, `https://github.com/${REPO}/releases/download/v0.2.0/../v0.2.1/${ok.name}`, 'nao e url', '', null
  ];
  for (const url of bad) assert.equal(U.isAssetUrl(url, ok), false, String(url));
  const local = { ...ok, origin: 'http://127.0.0.1:4567' };
  assert.equal(U.isAssetUrl(`http://127.0.0.1:4567/${REPO}/releases/download/v0.2.0/${ok.name}`, local), true);
  assert.equal(U.isAssetUrl(`https://github.com/${REPO}/releases/download/v0.2.0/${ok.name}`, local), false, 'com origem de teste só vale a origem de teste');
});

test('pickInstaller: só com nome da versão da tag, tamanho, digest sha256 e endereço de download conferidos; senão null (o aviso segue, o download não)', () => {
  const good = release();
  assert.equal(U.pickInstaller(good, REPO, '0.2.0').sha256, 'ab'.repeat(32));
  const mut = (fn) => { const r = JSON.parse(JSON.stringify(good)); fn(r.assets[0]); return U.pickInstaller(r, REPO, '0.2.0'); };
  assert.equal(mut((a) => { delete a.digest; }), null, 'sem digest não há como conferir');
  assert.equal(mut((a) => { a.digest = 'md5:abc'; }), null);
  assert.equal(mut((a) => { a.digest = `sha256:${'zz'.repeat(32)}`; }), null, 'hexadecimal inválido');
  assert.equal(mut((a) => { a.size = 0; }), null);
  assert.equal(mut((a) => { a.size = '5'; }), null);
  assert.equal(mut((a) => { a.browser_download_url = 'https://evil.example/x.exe'; }), null);
  assert.equal(mut((a) => { a.name = 'braga-frame-0.1.9-windows-x64-setup.exe'; }), null, 'nome de outra versão');
  assert.equal(mut((a) => { a.name = 'setup.exe'; }), null);
  assert.equal(U.pickInstaller({ ...good, assets: [] }, REPO, '0.2.0'), null);
  assert.equal(U.pickInstaller({ tag_name: 'v0.2.0' }, REPO, '0.2.0'), null);
  assert.equal(U.pickInstaller(null, REPO, '0.2.0'), null);
});

test('parseRelease: um html_url de fora do repositório é descartado e o endereço é montado pela tag (nunca se abre o que veio de fora)', () => {
  const r = U.parseRelease(release({ html_url: 'https://evil.example/baixe-aqui' }), REPO);
  assert.equal(r.url, `https://github.com/${REPO}/releases/tag/v0.2.0`);
  const odd = U.parseRelease(release({ tag_name: 'v0.2.0', html_url: undefined }), REPO);
  assert.equal(U.isReleaseUrl(odd.url, REPO), true);
});

test('checkForUpdate: versão mais nova -> available com o endereço; igual ou mais velha -> current', async () => {
  const newer = await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl: reply(200, release()) });
  assert.equal(newer.status, 'available');
  assert.equal(newer.latest.version, '0.2.0');
  assert.equal(newer.url, `https://github.com/${REPO}/releases/tag/v0.2.0`);
  assert.equal(newer.current, '0.1.0');
  assert.ok(!Number.isNaN(Date.parse(newer.checkedAt)));
  assert.equal((await U.checkForUpdate({ currentVersion: '0.2.0', repo: REPO, fetchImpl: reply(200, release()) })).status, 'current');
  assert.equal((await U.checkForUpdate({ currentVersion: '0.3.0', repo: REPO, fetchImpl: reply(200, release()) })).status, 'current', 'o usuário está num build à frente da última Release');
});

test('checkForUpdate: sem Release publicada (404), última de rascunho/pré-lançamento ou com tag fora do padrão -> none, sem erro', async () => {
  for (const fetchImpl of [reply(404, { message: 'Not Found' }), reply(200, release({ prerelease: true })), reply(200, release({ tag_name: 'nightly' }))]) {
    const r = await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl });
    assert.equal(r.status, 'none');
    assert.equal(r.message, undefined);
  }
});

test('checkForUpdate: nunca lança; cada falha vira error com motivo e mensagem em português', async () => {
  const cases = [
    ['rate', reply(403, {})], ['rate', reply(429, {})], ['http', reply(500, {})], ['http', reply(502, {})],
    ['format', reply(200, new SyntaxError('JSON ruim'))],
    ['network', async () => { throw new TypeError('fetch failed'); }]
  ];
  for (const [reason, fetchImpl] of cases) {
    const r = await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl });
    assert.deepEqual([r.status, r.reason], ['error', reason]);
    assert.equal(r.message, U.ERRORS[reason]);
    assert.match(r.message, /[a-zà-ú]/i);
  }
  assert.equal((await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl: null })).reason, 'network', 'sem fetch');
  assert.equal((await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl: reply(200, release({ tag_name: 'v1.2.3' })) })).status, 'available');
  assert.equal((await U.checkForUpdate({ currentVersion: 'dev', repo: REPO, fetchImpl: reply(200, release()) })).reason, 'format', 'versão instalada fora do padrão: não compara');
});

test('checkForUpdate: respeita o prazo (o GitHub que não responde não prende o app)', async () => {
  const hang = (url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => { const e = new Error('abortado'); e.name = 'AbortError'; reject(e); }); });
  const started = Date.now();
  const r = await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl: hang, timeoutMs: 80 });
  assert.deepEqual([r.status, r.reason], ['error', 'timeout']);
  assert.ok(Date.now() - started < 2000);
});

test('o que é enviado: GET na API do GitHub do repositório, só com o nome e a versão do app; nada do usuário', async () => {
  const seen = [];
  await U.checkForUpdate({ currentVersion: '0.1.0', repo: REPO, fetchImpl: async (url, opts) => { seen.push([url, opts]); return { status: 404, ok: false, json: async () => ({}) }; } });
  assert.equal(seen.length, 1);
  const [url, opts] = seen[0];
  assert.equal(url, `https://api.github.com/repos/${REPO}/releases/latest`);
  assert.equal(opts.method, undefined, 'GET (o padrão), sem corpo');
  assert.equal(opts.body, undefined);
  assert.deepEqual(Object.keys(opts.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
  assert.equal(opts.headers['User-Agent'], 'BragaFrame/0.1.0 (verificacao-de-versao)');
  assert.equal(opts.credentials, undefined);
});

test('apiBase: só testes (NODE_ENV=test, app não empacotado) e só em loopback trocam o endereço do GitHub', () => {
  const env = { NODE_ENV: 'test', BF_TEST_UPDATE_API: 'http://127.0.0.1:4567/qualquer/coisa' };
  assert.equal(U.apiBase(env, false), 'http://127.0.0.1:4567');
  for (const [why, e, packaged] of [
    ['empacotado', env, true], ['empacotado indefinido', env, undefined], ['sem NODE_ENV=test', { ...env, NODE_ENV: 'production' }, false],
    ['fora de loopback', { NODE_ENV: 'test', BF_TEST_UPDATE_API: 'https://evil.example' }, false], ['inválida', { NODE_ENV: 'test', BF_TEST_UPDATE_API: 'não é url' }, false], ['sem a variável', { NODE_ENV: 'test' }, false]
  ]) assert.equal(U.apiBase(e, packaged), U.API, why);
});
