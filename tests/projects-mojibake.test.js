'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixMojibake, healStrings } = require('../src/core/projects/mojibake');

/** Estraga o texto como o Windows PowerShell 5.1 faz: bytes UTF-8 lidos como Windows-1252 e regravados em UTF-8. */
function damage(text, times = 1) {
  const back = new Map([[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178]]);
  let t = text;
  for (let i = 0; i < times; i += 1) t = [...Buffer.from(t, 'utf8')].map((b) => String.fromCodePoint(back.get(b) || b)).join('');
  return t;
}

test('o estrago do PowerShell é desfeito, em uma, duas ou três camadas', () => {
  for (const original of ['Sugestão 10:08', 'O Desafio: Cayo Perico em 1ª Pessoa', 'Finalização & Vitória: 680k no Bolso', 'Gancho temático: início do desafio', 'ÇÃO é “aspas” — e “reticências…”']) {
    for (const times of [1, 2, 3]) {
      const bad = damage(original, times);
      assert.notEqual(bad, original);
      assert.equal(fixMojibake(bad), original, `${times} camada(s): ${bad}`);
    }
  }
});

test('os textos da captura de tela voltam ao normal', () => {
  assert.equal(fixMojibake('SugestÃƒÂ£o 10:08'), 'Sugestão 10:08');
  assert.equal(fixMojibake('O Desafio: Cayo Perico em 1Ã‚Âª Pessoa'), 'O Desafio: Cayo Perico em 1ª Pessoa');
});

test('texto normal não muda (acentos, emoji, símbolos e o que parece mas não é estrago)', () => {
  for (const ok of ['Sugestão 10:08', 'Ação', 'Ã', 'Â', 'Ã sozinho', 'CAFÉ AÇÃO', '😀 vitória!', '100% — “ok”', 'Ãrvore', 'preço R$ 5', 'a Â b', '']) {
    assert.equal(fixMojibake(ok), ok, ok);
  }
});

test('healStrings conserta só os valores, em qualquer profundidade, e conta quantos mudaram', () => {
  const data = { title: 'SugestÃ£o 1:00', cuts: [{ title: damage('Ação', 2), start: 5, tags: ['ok', damage('é')] }], n: 3, flag: true, none: null };
  const { data: out, fixed } = healStrings(data);
  assert.equal(fixed, 3);
  assert.deepEqual(out, { title: 'Sugestão 1:00', cuts: [{ title: 'Ação', start: 5, tags: ['ok', 'é'] }], n: 3, flag: true, none: null });
  assert.equal(data.title, 'SugestÃ£o 1:00', 'a entrada não é alterada');
});
