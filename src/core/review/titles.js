'use strict';

/**
 * Sugestões de título, geradas localmente (sem IA nem rede) a partir da categoria, dos motivos da sugestão
 * automática, do jogo/canal do projeto e do tempo (dono: review). Universal: CommonJS no Node e
 * `window.BFReview.titles` no renderer.
 *
 * Regra de ouro: sugerir NUNCA troca o título. As sugestões vão para `cut.titleSuggestions` e só viram
 * título quando o usuário clica. Um título digitado pelo usuário é "personalizado" (`titleCustom: true`) e
 * a interface pede confirmação antes de trocá-lo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(require('./core'));
  else { root.BFReview = root.BFReview || {}; root.BFReview.titles = factory(root.BFReview.core); }
})(globalThis, function (core) {
  const MAX_SUGGESTIONS = 5;
  const MAX_STORED = 12;
  const MAX_LENGTH = 70;
  // títulos que o próprio app gera: "Corte 3" (criação manual) e "Sugestão 1:23" / "Sugestão 1:02:05" (análise)
  const DEFAULT_TITLE = /^(?:corte\s+\d+|sugest[aã]o\s+[\d:]+)$/i;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[\s.:;,\-–—]+$/g, '').trim();
  const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

  /** "Corte 3" e "Sugestão 1:23" (títulos automáticos de quem cria o corte) não contam como escolhidos pelo usuário. */
  function isDefaultTitle(title) {
    return DEFAULT_TITLE.test(String(title || '').trim());
  }

  /**
   * O título foi escolhido pelo usuário? Vale `titleCustom` quando existe (true/false); sem ele, por
   * prudência, qualquer título que não seja um padrão do app ("Corte N", "Sugestão m:ss"), uma das sugestões
   * guardadas ou o de um corte sugerido ainda intocado é tratado como personalizado.
   */
  function isCustomTitle(cut) {
    if (cut.titleCustom === true) return true;
    if (cut.titleCustom === false) return false;
    const title = clean(cut.title);
    if (!title || isDefaultTitle(title)) return false;
    if ((cut.titleSuggestions || []).some((s) => clean(s).toLowerCase() === title.toLowerCase())) return false;
    // corte sugerido que ninguém mexeu desde que foi criado: o título ainda é o automático
    if (cut.origin === 'auto' && cut.updatedAt && cut.updatedAt === cut.createdAt) return false;
    return true;
  }

  /** "1:23:45" (>= 1 h) ou "5:07", para usar no título. */
  function clock(sec) {
    const total = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Até 5 títulos novos, na ordem do mais específico ao mais genérico. `ctx`: { game, channel }.
   * Nunca repete o título atual nem outro já guardado em `cut.titleSuggestions`.
   */
  function suggestTitles(cut, ctx = {}) {
    const game = clean(ctx.game);
    const channel = clean(ctx.channel);
    const category = upperFirst(clean(cut.category));
    const reasons = (cut.reasons || []).map(clean).filter((r) => r && r.length <= 48);
    const r0 = reasons[0] ? upperFirst(reasons[0]) : '';
    const r1 = reasons[1] ? lowerFirst(reasons[1]) : '';
    const when = clock(cut.start);
    const where = game || channel;
    const candidates = [];
    if (category && game) candidates.push(`${category} em ${game}`);
    if (r0 && game) candidates.push(`${r0} em ${game}`);
    if (category && r0) candidates.push(`${category}: ${lowerFirst(r0)}`);
    if (r0 && r1) candidates.push(`${r0} e ${r1}`);
    if (category) candidates.push(`${category} aos ${when}`);
    if (r0) candidates.push(`${r0} aos ${when}`);
    if (where) candidates.push(`Momento de ${where} aos ${when}`);
    if (core.isNum(cut.relevance) && cut.relevance >= 0.8) candidates.push(`Destaque da live aos ${when}`);
    candidates.push(`Momento da live aos ${when}`);

    const taken = new Set([cut.title, ...(cut.titleSuggestions || [])].map((t) => clean(t).toLowerCase()));
    const out = [];
    for (const raw of candidates) {
      const text = clean(raw);
      const key = text.toLowerCase();
      if (!text || text.length > MAX_LENGTH || taken.has(key)) continue;
      taken.add(key);
      out.push(text);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  }

  /** Acrescenta sugestões novas ao fim da lista guardada (sem repetir, no máximo 12). Não mexe no título. */
  function mergeSuggestions(existing, fresh) {
    const seen = new Set();
    const out = [];
    for (const item of [...(existing || []), ...(fresh || [])]) {
      const text = clean(item);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out.slice(-MAX_STORED);
  }

  return { MAX_SUGGESTIONS, MAX_STORED, clean, isDefaultTitle, isCustomTitle, clock, suggestTitles, mergeSuggestions };
});
