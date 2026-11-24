'use strict';

/**
 * Conserta texto UTF-8 que foi lido como Windows-1252 e regravado (o "mojibake": "Sugestão" vira "SugestÃ£o", "1ª" vira "1Ã‚Âª"). Acontece
 * quando outra ferramenta (um script do Windows PowerShell 5.1, por exemplo) lê o arquivo do projeto sem dizer que é UTF-8 e o grava de volta;
 * a cada passada o estrago aumenta ("SugestÃƒÂ£o", "SugestÃƒÆ’Ã‚Â£o"). O app grava UTF-8 certo; isto só desfaz o dano que veio de fora.
 *
 * Conservador: um texto só muda quando (1) tem "Ã" ou "Â" seguido de um caractere típico do estrago, (2) todos os caracteres voltam a bytes do
 * Windows-1252 e (3) esses bytes formam UTF-8 válido, sem caractere de substituição. Texto normal nunca passa por (1) e (3) juntos.
 */

// Windows-1252: os caracteres que ocupam 0x80-0x9F (o resto de 0x00-0xFF é igual ao Latin-1)
const CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
]);

// "Ã" ou "Â" seguido do que um byte de continuação UTF-8 (0x80-0xBF) vira em Windows-1252
const SUSPECT = /[ÃÂ][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;

function oneStep(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (CP1252.has(code)) bytes.push(CP1252.get(code));
    else if (code <= 0xff) bytes.push(code);
    else return null; // caractere que não existe em Windows-1252: o texto não é um mojibake
  }
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    return out.includes('�') ? null : out;
  } catch {
    return null;
  }
}

/** Uma string consertada (até 5 camadas de estrago); a mesma string se nada a consertar. */
function fixMojibake(text) {
  let current = text;
  for (let i = 0; i < 5 && typeof current === 'string' && SUSPECT.test(current); i += 1) {
    const next = oneStep(current);
    if (next === null || next === current) break;
    current = next;
  }
  return current;
}

/** Conserta todas as strings (valores e chaves não: só valores) de um objeto lido do JSON. Devolve { data, fixed } (fixed = quantas strings mudaram). */
function healStrings(data) {
  let fixed = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      const out = fixMojibake(value);
      if (out !== value) fixed += 1;
      return out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const copy = {};
      for (const key of Object.keys(value)) copy[key] = walk(value[key]);
      return copy;
    }
    return value;
  };
  const healed = walk(data);
  return { data: healed, fixed };
}

module.exports = { fixMojibake, healStrings, SUSPECT };
