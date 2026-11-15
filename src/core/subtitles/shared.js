'use strict';

/**
 * Lógica de legendas compartilhada pelo processo principal e pelo renderer (dono: subtitles).
 *
 * É um arquivo "universal", como src/core/projects/model.js: funciona como módulo CommonJS (main e testes)
 * e, carregado por <script>, expõe `window.BFSubtitles` no renderer. Por isso não usa nada do Node e fica
 * dentro de uma função. Só tem lógica pura (nada de disco, rede ou processo):
 *
 *  - estilo da legenda (padrões e validação);
 *  - operações sobre a lista de falas (dividir, mesclar, deslocar, adicionar, buscar no tempo);
 *  - quebra de linhas por quantidade de caracteres;
 *  - "rebase": quando o intervalo do corte muda, as falas acompanham o novo intervalo (docs/recursos/subtitles.md).
 *
 * Convenção de tempo (contrato 2.2, provisória e documentada): os tempos de `cue.start`/`cue.end` são em
 * segundos RELATIVOS AO INÍCIO DO CORTE (0 = cut.start). `subtitles.basedOn` guarda o intervalo do corte
 * (start, end, revision) para o qual as falas valem.
 */
(function () {
  const MIN_CUE_SECONDS = 0.1;
  const EPS = 0.0005;
  const MODES = Object.freeze(['burn', 'sidecar', 'both']);
  const SIDECAR_FORMATS = Object.freeze(['srt', 'ass']);
  const POSITIONS = Object.freeze(['bottom', 'center', 'top']);
  const BACKGROUNDS = Object.freeze(['none', 'shadow', 'box']);

  /** Fontes oferecidas na interface (a disponibilidade de cada uma é conferida no processo principal). */
  const FONT_CHOICES = Object.freeze([
    'Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Segoe UI Black', 'Verdana', 'Tahoma',
    'Trebuchet MS', 'Calibri', 'Bahnschrift', 'Comic Sans MS', 'Georgia', 'Consolas'
  ]);

  /**
   * Estilo padrão. Tamanhos (fontSize, outlineWidth) são em pixels de um quadro de referência com 1080 px
   * de lado menor (1080x1920 no vertical): em outra resolução valem proporcionalmente (veja `scaleFor`).
   */
  const DEFAULT_STYLE = Object.freeze({
    fontFamily: 'Arial',
    fontSize: 64,
    bold: true,
    color: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 5,
    background: 'shadow',
    backgroundColor: '#000000',
    backgroundOpacity: 0.55,
    position: 'bottom',
    maxCharsPerLine: 22
  });
  const STYLE_LIMITS = Object.freeze({
    fontSize: { min: 20, max: 140 },
    outlineWidth: { min: 0, max: 16 },
    backgroundOpacity: { min: 0, max: 1 },
    maxCharsPerLine: { min: 8, max: 60 }
  });

  // ---------- números e textos ----------

  function num(value, fallback) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  }
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /**
   * Tira espaços e tabs do fim de cada linha (menos da última, que quem chama já apara). É um laço linear de propósito:
   * `replace(/[ \t]+\n/g, '\n')` é quadrático num texto com milhares de espaços seguidos (legenda importada hostil).
   */
  function trimLineEnds(text) {
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      let end = line.length;
      while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
      if (end !== line.length) lines[i] = line.slice(0, end);
    }
    return lines.join('\n');
  }

  /** Segundos -> "m:ss.cc" (ex.: 62.35 -> "1:02.35"); tempo negativo leva "-" (ex.: -2.02 -> "-0:02.02"). */
  function fmtClock(seconds) {
    const value = num(seconds, 0);
    let cs = Math.round(Math.abs(value) * 100);
    const sign = value < 0 && cs > 0 ? '-' : '';
    const m = Math.floor(cs / 6000);
    cs -= m * 6000;
    const s = Math.floor(cs / 100);
    return `${sign}${m}:${String(s).padStart(2, '0')}.${String(cs - s * 100).padStart(2, '0')}`;
  }

  /** "1:02.35", "62,35" ou "62" -> segundos; NaN se não for um tempo válido. Aceita sinal "-". */
  function parseClock(text) {
    const raw = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
    const negative = raw.startsWith('-');
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(negative ? raw.slice(1) : raw);
    if (!m) return NaN;
    const value = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
    return negative ? -value : value;
  }

  // ---------- estilo ----------

  function colorOr(value, fallback) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toUpperCase() : fallback;
  }

  function familyOr(value, fallback) {
    if (typeof value !== 'string') return fallback;
    // vírgula, ponto e vírgula, chaves e barras quebrariam a linha de estilo do ASS
    const clean = Array.from(value).filter((ch) => ch.charCodeAt(0) >= 32 && !',;{}\\'.includes(ch)).join('').trim();
    return clean && clean.length <= 60 ? clean : fallback;
  }

  /** Estilo completo e válido (campos ausentes ou inválidos voltam ao padrão; números ficam nos limites). */
  function normalizeStyle(raw) {
    const src = isObj(raw) ? raw : {};
    const d = DEFAULT_STYLE;
    const L = STYLE_LIMITS;
    return {
      fontFamily: familyOr(src.fontFamily, d.fontFamily),
      fontSize: Math.round(clamp(num(src.fontSize, d.fontSize), L.fontSize.min, L.fontSize.max)),
      bold: typeof src.bold === 'boolean' ? src.bold : d.bold,
      color: colorOr(src.color, d.color),
      outlineColor: colorOr(src.outlineColor, d.outlineColor),
      outlineWidth: Math.round(clamp(num(src.outlineWidth, d.outlineWidth), L.outlineWidth.min, L.outlineWidth.max) * 10) / 10,
      background: BACKGROUNDS.includes(src.background) ? src.background : d.background,
      backgroundColor: colorOr(src.backgroundColor, d.backgroundColor),
      backgroundOpacity: Math.round(clamp(num(src.backgroundOpacity, d.backgroundOpacity), L.backgroundOpacity.min, L.backgroundOpacity.max) * 100) / 100,
      position: POSITIONS.includes(src.position) ? src.position : d.position,
      maxCharsPerLine: Math.round(clamp(num(src.maxCharsPerLine, d.maxCharsPerLine), L.maxCharsPerLine.min, L.maxCharsPerLine.max))
    };
  }

  function normalizeMode(mode) {
    if (MODES.includes(mode)) return mode;
    if (mode === 'srt' || mode === 'ass') return 'sidecar';
    if (mode === 'burn+srt' || mode === 'burn+ass') return 'both';
    return 'burn';
  }

  /** Formato do arquivo separado: 'srt' (padrão) ou 'ass'; aceita também os modos antigos 'srt'/'ass'/'burn+ass'. */
  function sidecarFormatOf(sub) {
    if (sub && SIDECAR_FORMATS.includes(sub.sidecarFormat)) return sub.sidecarFormat;
    if (sub && typeof sub.mode === 'string' && /ass$/.test(sub.mode)) return 'ass';
    return 'srt';
  }

  /**
   * Fator que leva "pixels de referência" do estilo para pixels do quadro de saída:
   * lado menor do quadro / 1080 (1080x1920 -> 1; 1440x2560 -> 1,333; 1920x1080 -> 1).
   */
  function scaleFor(width, height) {
    const w = num(width, 1080);
    const h = num(height, 1920);
    return Math.max(1, Math.min(w, h)) / 1080;
  }

  /** Distância (px do quadro de saída) entre o texto e a borda, para posição inferior/superior. */
  function marginFor(position, width, height) {
    if (position === 'center') return 0;
    const h = num(height, 1920);
    const portrait = h >= num(width, 1080);
    // vertical: fora da área dos botões do Shorts; horizontal: margem de legenda comum
    const pct = position === 'top' ? (portrait ? 0.09 : 0.06) : (portrait ? 0.14 : 0.07);
    return Math.round(h * pct);
  }

  // ---------- falas (cues) ----------

  /** Fala válida ou null. Tempos arredondados a milissegundos; end >= start; só `needsReview` é mantido além do contrato. */
  function normalizeCue(raw) {
    if (!isObj(raw)) return null;
    const a = num(raw.start, NaN);
    const b = num(raw.end, NaN);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const text = typeof raw.text === 'string' ? trimLineEnds(raw.text.replace(/\r\n?/g, '\n')).trim() : '';
    const cue = { start: round3(Math.min(a, b)), end: round3(Math.max(a, b)), text };
    if (raw.needsReview === true) cue.needsReview = true;
    return cue;
  }

  /** Lista limpa e em ordem de início. Itens inválidos são ignorados (devolve sempre uma lista nova). */
  function cleanCues(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const cue = normalizeCue(raw);
      if (cue) out.push(cue);
    }
    return out.map((cue, i) => ({ cue, i })).sort((x, y) => x.cue.start - y.cue.start || x.cue.end - y.cue.end || x.i - y.i).map((x) => x.cue);
  }

  /** Desloca todas as falas por `delta` segundos (pode ser negativo). Não corta nada. */
  function shiftCues(cues, delta) {
    const d = num(delta, 0);
    return cleanCues(cues).map((c) => ({ ...c, start: round3(c.start + d), end: round3(c.end + d) }));
  }

  /**
   * Posições (índices do texto) onde dá para dividir uma fala: o começo de cada palavra e, dentro de japonês ou chinês
   * (sem espaços), qualquer ponto entre dois caracteres, menos antes de pontuação que fecha ou depois da que abre.
   */
  function splitPoints(text) {
    const points = [];
    for (const word of text.matchAll(/\S+/g)) {
      if (word.index > 0) points.push(word.index);
      if (!CJK_RE.test(word[0])) continue;
      let at = word.index;
      let prev = '';
      for (const ch of word[0]) {
        if (prev && (CJK_RE.test(prev) || CJK_RE.test(ch)) && !CLOSING_ONLY_RE.test(ch) && !OPENING_ONLY_RE.test(prev)) points.push(at);
        at += ch.length;
        prev = ch;
      }
    }
    return points;
  }

  /**
   * Divide a fala `index` em duas.
   * `time` (relativo ao corte) define o ponto de corte do tempo; `charIndex` o do texto. Sem um deles o outro
   * é derivado por proporção; sem nenhum, divide ao meio (na fronteira de palavra mais próxima do meio).
   * @returns {{ ok:boolean, cues:object[], index:number, message?:string }} `index` = posição da primeira metade
   */
  function splitCue(cues, index, { time, charIndex } = {}) {
    const list = cleanCues(cues);
    const cue = list[index];
    if (!cue) return { ok: false, cues: list, index, message: 'Escolha uma fala para dividir.' };
    const text = cue.text;
    const length = text.length;

    let cut = Number.isFinite(charIndex) ? Math.round(charIndex) : NaN;
    const explicit = Number.isFinite(cut) && cut > 0 && cut < length;
    if (!explicit) {
      const points = splitPoints(text);
      if (!points.length) return { ok: false, cues: list, index, message: 'A fala tem uma palavra só; não dá para dividir.' };
      let target = length / 2;
      if (Number.isFinite(time) && cue.end > cue.start) target = length * clamp((time - cue.start) / (cue.end - cue.start), 0.1, 0.9);
      // fronteira entre palavras mais próxima do alvo
      let best = null;
      for (const boundary of points) {
        if (best === null || Math.abs(boundary - target) < Math.abs(best - target)) best = boundary;
      }
      cut = best;
    }
    const first = text.slice(0, cut).trim();
    const second = text.slice(cut).trim();
    if (!first || !second) return { ok: false, cues: list, index, message: 'Escolha um ponto de divisão no meio do texto.' };

    const span = cue.end - cue.start;
    let at = Number.isFinite(time) && time > cue.start + EPS && time < cue.end - EPS ? time : cue.start + span * (cut / Math.max(1, length));
    const room = Math.min(MIN_CUE_SECONDS, span / 2);
    at = clamp(at, cue.start + room, cue.end - room);
    const base = cue.needsReview ? { needsReview: true } : {};
    const pieces = [
      { start: cue.start, end: round3(at), text: first, ...base },
      { start: round3(at), end: cue.end, text: second, ...base }
    ];
    return { ok: true, cues: [...list.slice(0, index), ...pieces, ...list.slice(index + 1)], index };
  }

  /** Junta a fala `index` com a seguinte (texto unido por espaço; início do primeiro ao fim do último). */
  function mergeCues(cues, index) {
    const list = cleanCues(cues);
    const a = list[index];
    const b = list[index + 1];
    if (!a || !b) return { ok: false, cues: list, index, message: 'Não há fala seguinte para juntar.' };
    const merged = {
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
      text: joinTexts(a.text, b.text)
    };
    if (a.needsReview || b.needsReview) merged.needsReview = true;
    return { ok: true, cues: [...list.slice(0, index), merged, ...list.slice(index + 2)], index };
  }

  function removeCue(cues, index) {
    const list = cleanCues(cues);
    if (!list[index]) return { ok: false, cues: list, index, message: 'Fala não encontrada.' };
    return { ok: true, cues: [...list.slice(0, index), ...list.slice(index + 1)], index };
  }

  /** Acrescenta uma fala vazia em `at` (relativo ao corte), com `length` s, dentro de [0, duration]. */
  function addCue(cues, { at = 0, length = 2, duration = Infinity, text = '' } = {}) {
    const list = cleanCues(cues);
    const total = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const start = clamp(num(at, 0), 0, Number.isFinite(total) ? Math.max(0, total - MIN_CUE_SECONDS) : Infinity);
    const end = Math.min(start + Math.max(MIN_CUE_SECONDS, num(length, 2)), total);
    const cue = { start: round3(start), end: round3(Math.max(end, start + MIN_CUE_SECONDS)), text: String(text || '') };
    const all = cleanCues([...list, cue]);
    return { ok: true, cues: all, index: all.findIndex((c) => c.start === cue.start && c.end === cue.end && c.text === cue.text) };
  }

  /** Índice da fala na tela no tempo `t` (relativo ao corte) ou -1. Em sobreposição vale a que começou por último. */
  function cueAt(cues, t) {
    let found = -1;
    const list = Array.isArray(cues) ? cues : [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c && t >= c.start - EPS && t < c.end - EPS && (found === -1 || c.start >= list[found].start)) found = i;
    }
    return found;
  }

  /** 'inside' | 'partial' | 'outside' em relação à duração do corte. */
  function rangeState(cue, duration) {
    if (!cue) return 'outside';
    if (cue.end <= EPS || cue.start >= duration - EPS) return 'outside';
    if (cue.start < -EPS || cue.end > duration + EPS) return 'partial';
    return 'inside';
  }

  // ---------- quebra de linhas ----------

  const glyphs = (s) => Array.from(s).length;

  // Japonês e chinês (e a pontuação de largura total) não separam as palavras com espaço: a linha pode quebrar entre dois
  // caracteres. Esses caracteres também ocupam o dobro de uma letra latina na linha (como o hangul, que tem espaços).
  const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC\\u3005';
  const CLOSING_PUNCT = ',.;:!?)。、，．！？：；）」』】〉》〕…‥'; // não abre linha: fica com o caractere anterior (o motor às vezes devolve a pontuação ASCII)
  const OPENING_PUNCT = '（「『【〈《〔'; // não fecha linha: fica com o caractere seguinte
  const FULLWIDTH_CLASS = '\\u3000-\\u303F\\uFF01-\\uFF60\\uFFE0-\\uFFE6';
  const CJK_RE = new RegExp(`[${CJK_CLASS}]`, 'u');
  const NO_SPACE_RE = new RegExp(`[${CJK_CLASS}${FULLWIDTH_CLASS}]`, 'u');
  const WIDE_CHAR_RE = new RegExp(`[${CJK_CLASS}\\p{Script=Hangul}${FULLWIDTH_CLASS}]`, 'u');
  const CLOSING_ONLY_RE = new RegExp(`^[${CLOSING_PUNCT}]+$`, 'u');
  const OPENING_ONLY_RE = new RegExp(`^[${OPENING_PUNCT}]+$`, 'u');
  const PIECES_RE = new RegExp(`[${CJK_CLASS}]|[${CLOSING_PUNCT}]+|[${OPENING_PUNCT}]+|[^${CJK_CLASS}${CLOSING_PUNCT}${OPENING_PUNCT}]+`, 'gu');

  /** O texto tem caractere de escrita sem espaço entre palavras (japonês ou chinês)? */
  const hasCjk = (text) => CJK_RE.test(String(text));

  /** Largura do texto na linha, em "letras latinas": caractere de largura total (CJK, hangul) vale 2. */
  function textWidth(text) {
    const s = String(text === undefined || text === null ? '' : text);
    if (!WIDE_CHAR_RE.test(s)) return glyphs(s);
    let width = 0;
    for (const ch of s) width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
    return width;
  }

  /**
   * Unidades onde uma linha pode quebrar: as palavras separadas por espaço e, dentro de uma palavra com japonês ou chinês,
   * cada caractere (a pontuação que fecha fica com o caractere anterior; a que abre, com o seguinte).
   * `glue: true` = a unidade continua a anterior sem espaço (não existe espaço entre elas no texto).
   * @returns {Array<{ text:string, glue:boolean }>}
   */
  function breakUnits(paragraph) {
    const units = [];
    for (const word of String(paragraph === undefined || paragraph === null ? '' : paragraph).split(/\s+/)) {
      if (!word) continue;
      if (!CJK_RE.test(word)) { units.push({ text: word, glue: false }); continue; }
      let open = '';
      let first = true;
      for (const piece of word.match(PIECES_RE) || []) {
        if (!first && CLOSING_ONLY_RE.test(piece)) { units[units.length - 1].text += piece; continue; }
        if (OPENING_ONLY_RE.test(piece)) { open += piece; continue; }
        units.push({ text: open + piece, glue: !first });
        open = '';
        first = false;
      }
      if (open) units.push({ text: open, glue: !first });
    }
    return units;
  }

  /** Junta unidades de `breakUnits`: espaço entre elas, menos onde `glue` diz que não existe. */
  function joinUnits(units) {
    let out = '';
    for (const u of units) out += (out && !u.glue ? ' ' : '') + u.text;
    return out;
  }

  /**
   * Quebra `text` em linhas de até `maxChars` caracteres (largura em letras latinas: japonês e chinês valem 2 por caractere),
   * equilibrando o tamanho das linhas (quebras manuais "\n" são respeitadas). Uma palavra maior que o limite fica sozinha na linha.
   */
  function wrapText(text, maxChars) {
    const limit = Math.max(1, Math.floor(num(maxChars, DEFAULT_STYLE.maxCharsPerLine)));
    const out = [];
    for (const paragraph of String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n')) {
      const units = breakUnits(paragraph);
      if (!units.length) { out.push(''); continue; }
      const whole = joinUnits(units);
      const total = textWidth(whole);
      if (total <= limit) { out.push(whole); continue; }
      const lines = Math.ceil(total / limit);
      const target = Math.min(limit, Math.ceil(total / lines));
      // com caracteres de largura 2 uma linha só chega a larguras pares: 1 de folga evita sobrar um caractere sozinho na última
      const slack = WIDE_CHAR_RE.test(whole) ? 1 : 0;
      let current = '';
      const pushed = [];
      for (const unit of units) {
        const next = current ? `${current}${unit.glue ? '' : ' '}${unit.text}` : unit.text;
        const width = current ? textWidth(next) : 0;
        if (current && (width > limit || (width > target + slack && textWidth(current) >= Math.ceil(target * 0.6)))) {
          pushed.push(current);
          current = unit.text;
        } else {
          current = next;
        }
      }
      if (current) pushed.push(current);
      out.push(...pushed);
    }
    return out.join('\n');
  }

  /** Texto das falas `a` e `b` unidas: com espaço, menos entre dois caracteres de japonês/chinês (que não usam). */
  function joinTexts(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (!left || !right) return (left || right).trim();
    const tail = Array.from(left).pop();
    const head = Array.from(right)[0];
    return `${left}${NO_SPACE_RE.test(tail) && NO_SPACE_RE.test(head) ? '' : ' '}${right}`.trim();
  }

  // ---------- intervalo do corte ----------

  const sameTime = (a, b) => Math.abs(num(a, 0) - num(b, 0)) < 0.0005;

  /** Intervalo atual de um corte, no formato de `basedOn`. */
  function rangeOf(cut) {
    return { start: round3(num(cut && cut.start, 0)), end: round3(num(cut && cut.end, 0)), revision: Math.max(1, Math.floor(num(cut && cut.revision, 1))) };
  }

  /**
   * Leva as falas ao intervalo atual do corte (quando `cut.start/end` mudaram desde `subtitles.basedOn`).
   *  - o tempo das falas é relativo ao início do corte: se o início mudou, todas são deslocadas (exato, sem revisão);
   *  - fala que ficou PARCIALMENTE fora (`clipped`) ou TOTALMENTE fora (`outside`) NÃO é recortada nem apagada: mantém o
   *    tempo deslocado (pode passar de 0..duração) e fica marcada `needsReview`. Quem mostra ou exporta recorta (`visibleCues`,
   *    `rangeState`), então a parte de fora não aparece; e, como o tempo guardado é o certo, aparar o corte e voltar atrás
   *    (Ctrl+Z na aba Cortes) devolve as falas exatamente como estavam.
   * Se só a `revision` mudou (início e fim iguais), apenas `basedOn` é atualizado.
   * @returns {{ subtitles:object, changed:boolean, shifted:boolean, clipped:number, outside:number }}
   */
  function rebaseSubtitles(subtitles, cut) {
    if (!isObj(subtitles) || !isObj(cut)) return { subtitles, changed: false, shifted: false, clipped: 0, outside: 0 };
    const now = rangeOf(cut);
    const based = subtitles.basedOn;
    const hasBase = isObj(based) && Number.isFinite(num(based.start, NaN)) && Number.isFinite(num(based.end, NaN));
    const cues = cleanCues(subtitles.cues);

    if (!hasBase || (sameTime(based.start, now.start) && sameTime(based.end, now.end))) {
      const same = hasBase && Math.floor(num(based.revision, 1)) === now.revision;
      if (same) return { subtitles, changed: false, shifted: false, clipped: 0, outside: 0 };
      return { subtitles: { ...subtitles, basedOn: now }, changed: true, shifted: false, clipped: 0, outside: 0 };
    }

    const delta = round3(num(based.start, 0) - now.start);
    const duration = Math.max(0, now.end - now.start);
    let clipped = 0;
    let outside = 0;
    const moved = cues.map((c) => {
      const cue = { ...c, start: round3(c.start + delta), end: round3(c.end + delta) };
      const state = rangeState(cue, duration);
      if (state === 'outside') outside++;
      else if (state === 'partial') clipped++;
      if (state !== 'inside') cue.needsReview = true;
      return cue;
    });
    return { subtitles: { ...subtitles, cues: moved, basedOn: now }, changed: true, shifted: delta !== 0, clipped, outside };
  }

  /**
   * Falas que aparecem de fato no corte: já no intervalo atual, recortadas a 0..duração, sem as vazias nem as
   * que ficaram totalmente fora. Devolve cópias novas.
   */
  function visibleCues(subtitles, cut) {
    const rebased = rebaseSubtitles(subtitles, cut).subtitles;
    const duration = Math.max(0, num(cut && cut.end, 0) - num(cut && cut.start, 0));
    const out = [];
    for (const c of cleanCues(rebased && rebased.cues)) {
      if (!c.text.trim()) continue;
      const start = Math.max(0, c.start);
      const end = Math.min(duration, c.end);
      if (end - start < 0.02) continue;
      out.push({ ...c, start: round3(start), end: round3(end) });
    }
    return out;
  }

  /**
   * Falas de um arquivo (tempos do vídeo inteiro) -> falas relativas ao corte: só as que cruzam o corte, deslocadas
   * por -cut.start; as que cruzam a borda são recortadas e marcadas `needsReview`.
   */
  function importCuesForCut(fileCues, cut) {
    const start = num(cut && cut.start, 0);
    const duration = Math.max(0, num(cut && cut.end, 0) - start);
    const out = [];
    let clipped = 0;
    for (const c of cleanCues(fileCues)) {
      const s = c.start - start;
      const e = c.end - start;
      if (e <= EPS || s >= duration - EPS) continue;
      const cue = { ...c, start: round3(Math.max(0, s)), end: round3(Math.min(duration, e)) };
      if (s < -EPS || e > duration + EPS) { cue.needsReview = true; clipped++; }
      out.push(cue);
    }
    return { cues: out, clipped, total: cleanCues(fileCues).length };
  }

  function needsReviewCount(subtitles) {
    return cleanCues(subtitles && subtitles.cues).filter((c) => c.needsReview).length;
  }

  const api = {
    MIN_CUE_SECONDS, MODES, SIDECAR_FORMATS, POSITIONS, BACKGROUNDS, FONT_CHOICES, DEFAULT_STYLE, STYLE_LIMITS,
    fmtClock, parseClock, normalizeStyle, normalizeMode, sidecarFormatOf, scaleFor, marginFor,
    normalizeCue, cleanCues, shiftCues, splitCue, mergeCues, removeCue, addCue, cueAt, rangeState,
    wrapText, textWidth, hasCjk, breakUnits, joinUnits, joinTexts, trimLineEnds,
    rangeOf, rebaseSubtitles, visibleCues, importCuesForCut, needsReviewCount
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFSubtitles = api;
})();
