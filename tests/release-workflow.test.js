'use strict';

/**
 * O workflow de release (.github/workflows/release.yml) e os arquivos da assinatura (SignPath): as garantias que importam, conferidas no texto.
 * (Não roda o GitHub Actions: a primeira tag assinada é o teste de verdade; veja docs/assinatura-signpath.md.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github/workflows/release.yml');

/** Os passos do job `release`: [{ name, text }] (o nome vem de "name:" ou de "uses:"). */
const steps = wf.split(/\n {6}- /).slice(1).map((chunk) => {
  const text = `- ${chunk}`;
  const m = /^(?:- )?name: (.+)$/m.exec(text) || /uses: (\S+)/.exec(text);
  return { name: m ? m[1].trim() : '(sem nome)', text };
});
const stepIndex = (start) => steps.findIndex((s) => s.name.startsWith(start));
const step = (start) => { const i = stepIndex(start); assert.ok(i >= 0, `passo "${start}" existe`); return steps[i]; };

test('só uma tag vX.Y.Z dispara o release (nem push em branch, nem PR, nem disparo manual)', () => {
  const on = /^on:\n([\s\S]*?)\n\npermissions:/m.exec(wf)[1];
  assert.match(on, /tags:\n\s+- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'/);
  for (const other of ['branches', 'pull_request', 'workflow_dispatch', 'schedule']) assert.ok(!on.includes(other), `sem ${other}`);
});

test('permissões: leitura por padrão; só o job de release escreve (contents para a Release, actions para apagar o artefato)', () => {
  assert.match(wf, /^permissions:\n {2}contents: read$/m);
  const job = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(wf)[1];
  assert.match(job, /contents: write/);
  assert.match(job, /actions: write/);
  assert.ok(!/id-token|packages|pull-requests/.test(job), 'nenhuma permissão a mais');
});

test('toda ação de terceiros é fixada por SHA de commit (a local ./ não precisa)', () => {
  const uses = [...wf.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  for (const u of uses) {
    if (u.startsWith('./')) continue;
    assert.match(u, /@[0-9a-f]{40}$/, `${u} fixada por SHA`);
  }
  for (const wanted of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'signpath/github-action-submit-signing-request']) assert.ok(uses.some((u) => u.startsWith(`${wanted}@`)), wanted);
});

test('sem lixo: nenhum cache do Actions e um único artefato, de 1 dia, apagado depois (dê certo ou errado)', () => {
  assert.doesNotMatch(wf, /^\s*cache:/m, 'sem a chave cache: do setup-node (npm) nem de nada');
  assert.doesNotMatch(wf, /actions\/cache@/);
  assert.equal((wf.match(/actions\/upload-artifact@/g) || []).length, 1);
  const up = step('Enviar o instalador sem assinatura');
  assert.match(up.text, /retention-days: 1\b/);
  const del = step('Apagar o artefato do instalador sem assinatura');
  assert.match(del.text, /always\(\)/, 'apaga também quando algo falhou');
  assert.match(del.text, /gh api -X DELETE "repos\/\$GITHUB_REPOSITORY\/actions\/artifacts\//);
  assert.ok(stepIndex('Apagar o artefato') > stepIndex('Publicar a Release'), 'depois de publicar');
});

test('a assinatura é OPCIONAL: só roda com a variável SIGNPATH_ORGANIZATION_ID; sem ela só avisa', () => {
  const on = ['Preparar o instalador para a assinatura', 'Enviar o instalador sem assinatura', 'Assinar na SignPath', 'Conferir a assinatura'];
  for (const name of on) assert.match(step(name).text, /if: \$\{\{ vars\.SIGNPATH_ORGANIZATION_ID != '' \}\}/, name);
  const off = step('Assinatura desligada');
  assert.match(off.text, /if: \$\{\{ vars\.SIGNPATH_ORGANIZATION_ID == '' \}\}/);
  assert.match(off.text, /::warning::/);
});

test('ordem: compila, (assina), publica; a assinatura vem DEPOIS da compilação e ANTES da Release, e o arquivo assinado substitui o do build', () => {
  const order = ['Compilar o instalador', 'Assinatura desligada', 'Preparar o instalador', 'Enviar o instalador sem assinatura', 'Assinar na SignPath', 'Conferir a assinatura', 'Publicar a Release'].map(stepIndex);
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'na ordem escrita');
  const check = step('Conferir a assinatura').text;
  assert.match(check, /Get-AuthenticodeSignature/);
  assert.match(check, /\$sig\.Status -ne 'Valid'[^\n]*exit 1/, 'assinatura inválida impede a publicação');
  assert.match(check, /Copy-Item \$signed "dist\/installer\/braga-frame-\$env:VERSION-windows-x64-setup\.exe" -Force/, 'volta ao nome com a versão');
  const publish = step('Publicar a Release').text;
  assert.match(publish, /SIGNED: \$\{\{ vars\.SIGNPATH_ORGANIZATION_ID != '' \}\}/);
  assert.match(publish, /Instalador assinado digitalmente/);
});

test('a ação da SignPath recebe as entradas que a versão fixada conhece, e a espera cabe no prazo do job', () => {
  const sign = step('Assinar na SignPath').text;
  for (const input of ['api-token', 'organization-id', 'project-slug', 'signing-policy-slug', 'github-artifact-id', 'wait-for-completion', 'output-artifact-directory']) {
    assert.match(sign, new RegExp(`^\\s+${input}: `, 'm'), input);
  }
  assert.match(sign, /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/, 'o token só vem de secret');
  assert.match(sign, /github-artifact-id: \$\{\{ steps\.upload-unsigned\.outputs\.artifact-id \}\}/);
  const wait = Number(/wait-for-completion-timeout-in-seconds: (\d+)/.exec(sign)[1]);
  const job = Number(/timeout-minutes: (\d+)/.exec(wf)[1]);
  assert.ok(wait / 60 + 30 < job, `a espera (${wait / 60} min) mais lint, testes e build cabe nos ${job} min do job`);
  assert.ok(job <= 360, 'o máximo dos runners hospedados');
  assert.doesNotMatch(wf, /SIGNPATH_API_TOKEN[^\n]*echo|echo[^\n]*SIGNPATH_API_TOKEN/, 'o token nunca vai para o log');
});

test('o nome FIXO do instalador para assinar é o mesmo no workflow e na configuração do artefato da SignPath', () => {
  const xml = read('.signpath/artifact-configuration.xml');
  assert.match(xml, /<pe-file path="braga-frame-setup\.exe">\s*<authenticode-sign\/>\s*<\/pe-file>/);
  assert.match(xml, /<zip-file>/, 'o upload-artifact empacota num ZIP');
  assert.match(step('Preparar o instalador').text, /"unsigned\/braga-frame-setup\.exe"/);
  assert.match(step('Enviar o instalador sem assinatura').text, /path: unsigned\/braga-frame-setup\.exe/);
  assert.match(step('Conferir a assinatura').text, /signed\/braga-frame-setup\.exe/);
  assert.match(read('docs/assinatura-signpath.md'), /braga-frame-setup\.exe/);
});

test('a política de assinatura e o README: texto da SignPath, GPL, o workflow certo e a verdade de que ainda não há assinatura', () => {
  const policy = read('CODE_SIGNING_POLICY.md');
  assert.ok(policy.includes('Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).'));
  assert.match(policy, /\.github\/workflows\/release\.yml/);
  assert.match(policy, /\(LICENSE\)/);
  assert.match(policy, /ainda não é assinado/);
  assert.match(policy, /aprovação manual/);
  const readme = read('README.md');
  assert.match(readme, /## Assinatura de código/);
  assert.match(readme, /\(CODE_SIGNING_POLICY\.md\)/);
  assert.match(readme, /ainda não é assinado/, 'o README não afirma uma assinatura que não existe');
});

test('package.json aponta o repositório certo (a SignPath e a página de Releases usam)', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.homepage, 'https://github.com/MauroBragaFilho/Braga-Frame');
  assert.match(pkg.repository.url, /MauroBragaFilho\/Braga-Frame\.git$/);
  assert.equal(pkg.license, 'GPL-3.0-or-later');
  assert.match(require('../src/appInfo').repo, /^MauroBragaFilho\/Braga-Frame$/);
});
