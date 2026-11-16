'use strict';

/**
 * GUIA DE CORTES ("skill"; docs/recursos/analise-ia.md, seção 17): o texto que ensina a IA conectada a escolher os cortes. É um arquivo
 * Markdown no formato de skill (cabeçalho `---` com `name` e `description`, depois as instruções). O app manda as INSTRUÇÕES (sem o cabeçalho)
 * dentro da mensagem de sistema de cada chamada, para qualquer provedor.
 *   - padrão: `skill/SKILL.md` deste diretório (vai junto com o app; sem nome de canal nem fala de live);
 *   - do usuário: `<dir>/SKILL.md` (em `userData/ai/skill`), editado na aba Análise; se existe, vale no lugar do padrão.
 * O guia só diz COMO escolher. O formato da resposta, a regra de só usar horários que existem e a de que a transcrição é dado (não instrução)
 * ficam na parte fixa da mensagem de sistema (prompt.js) e não podem ser trocadas pelo guia.
 */
const fs = require('node:fs');
const path = require('node:path');
const { AiError } = require('../../ai/errors');

const DEFAULT_PATH = path.join(__dirname, 'skill', 'SKILL.md');
const FILE_NAME = 'SKILL.md';
const MIN_CHARS = 200;
const MAX_CHARS = 12000;
const BOM_RE = new RegExp('^' + String.fromCharCode(0xFEFF)); // marca de ordem de bytes no começo do arquivo

/** Separa o cabeçalho (`---` … `---`) das instruções. Sem cabeçalho, tudo é instrução. */
function parseSkill(text) {
  const src = String(text || '').replace(BOM_RE, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return { name: meta.name || '', description: meta.description || '', body: (m ? src.slice(m[0].length) : src).trim() };
}

let defaultCache = null;
/** O guia padrão (lido uma vez). */
function defaultSkill() {
  if (!defaultCache) {
    const text = fs.readFileSync(DEFAULT_PATH, 'utf8');
    defaultCache = { text, ...parseSkill(text) };
  }
  return defaultCache;
}

const tokensOf = (text) => Math.ceil(String(text || '').length / 3.2); // a mesma conta de prompt.js (estimateTokens)

class SkillStore {
  /** @param {string} dir pasta do guia do usuário (criada ao salvar) */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
  }

  /** O guia do usuário, ou null (não existe, vazio ou ilegível: vale o padrão). */
  _custom() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = parseSkill(text);
      return parsed.body.length >= MIN_CHARS ? { text, ...parsed } : null;
    } catch { return null; }
  }

  /** As instruções que vão para a IA agora: { custom, body }. */
  active() {
    const custom = this._custom();
    return custom ? { custom: true, body: custom.body } : { custom: false, body: defaultSkill().body };
  }

  /** O que a tela mostra: { source, text, chars, tokens, defaultText, minChars, maxChars }. */
  describe() {
    const custom = this._custom();
    const def = defaultSkill();
    const current = custom || def;
    return {
      source: custom ? 'custom' : 'default', text: current.text, name: current.name || def.name,
      chars: current.body.length, tokens: tokensOf(current.body), defaultText: def.text, minChars: MIN_CHARS, maxChars: MAX_CHARS
    };
  }

  /** Guarda o guia do usuário. Texto igual ao padrão apaga o do usuário (volta a valer o padrão, que acompanha as atualizações do app). */
  save(text) {
    if (typeof text !== 'string') throw new AiError('INVALID_ARGS', 'Informe o texto do guia.');
    if (text.includes('\u0000')) throw new AiError('INVALID_ARGS', 'O guia tem caracteres inválidos.');
    const clean = text.replace(BOM_RE, '').replace(/\r\n?/g, '\n').trim();
    const body = parseSkill(clean).body;
    if (body.length < MIN_CHARS) throw new AiError('INVALID_ARGS', `O guia está curto demais (mínimo de ${MIN_CHARS} caracteres de instruções). Para voltar ao guia do app, use "Restaurar o padrão".`);
    if (body.length > MAX_CHARS) throw new AiError('INVALID_ARGS', `O guia passou do tamanho máximo (${MAX_CHARS.toLocaleString('pt-BR')} caracteres de instruções; ele vai inteiro em cada chamada). Encurte o texto.`);
    if (body === defaultSkill().body) return this.reset();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${clean}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    return this.describe();
  }

  /** Apaga o guia do usuário: volta a valer o padrão. */
  reset() {
    try { fs.unlinkSync(this.file); } catch { /* já não existe */ }
    return this.describe();
  }
}

module.exports = { SkillStore, parseSkill, defaultSkill, DEFAULT_PATH, MIN_CHARS, MAX_CHARS };
