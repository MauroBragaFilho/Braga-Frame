'use strict';

/**
 * Verificações de acessibilidade que rodam DENTRO da página do app (strings de JavaScript para page.eval), compartilhadas pelos e2e de usabilidade:
 * contraste (4,5:1 texto, 3:1 ícones), alvos de clique de 24 px, foco visível e nome acessível. Cada uma devolve JSON com o que está errado (lista vazia = ok).
 */
/** Contraste de todo texto visível da tela (e de cada ícone da fonte de ícones, que só pede 3:1). Devolve os que ficam abaixo do mínimo. */
const CONTRAST = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { let bg = { r: 0, g: 0, b: 0, a: 0 }; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { bg = bg.a === 0 ? c : over(bg, c); if (bg.a >= 0.999) break; } } return bg.a < 0.999 ? over(bg, { r: 0, g: 0, b: 0, a: 1 }) : bg; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]') && Number(s.opacity) > 0.05; };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own || el.closest('[disabled],[aria-disabled="true"]') || el.disabled) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el); const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const size = parseFloat(cs.fontSize);
    const icon = el.classList.contains('material-symbols-rounded');
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = icon || large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need) bad.push((Math.round(r * 100) / 100) + ':1 < ' + need + ' ' + el.tagName + '.' + String(el.className).slice(0, 30) + ' "' + own.slice(0, 25) + '"');
  }
  return JSON.stringify([...new Set(bad)]);
})()`;

/** Recolhíveis e links com menos de 24 px de altura. */
const SMALL = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('summary, button.link')) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || el.closest('[hidden]')) continue;
    if (r.height < 23.5) bad.push(el.tagName + '.' + el.className + ' ' + Math.round(r.height) + 'px "' + el.textContent.trim().slice(0, 20) + '"');
  }
  return JSON.stringify(bad);
})()`;

/** Controles focáveis cuja aparência NÃO muda ao receber o foco do teclado (nem o deles nem a dos 3 ancestrais mais próximos). */
const FOCUS = `(() => {
  const sig = (el) => { const out = []; for (let n = el, i = 0; n && i < 4; n = n.parentElement, i += 1) { const s = getComputedStyle(n); out.push([s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.backgroundColor, s.color, s.textDecorationLine, s.transform].join('|')); } return out.join('#'); };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]') && !el.closest('[inert]'); };
  const bad = [];
  const list = [...document.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')].filter((el) => visible(el) && !el.disabled && el.tabIndex >= 0);
  for (const el of list.slice(0, 80)) {
    el.blur();
    const before = sig(el);
    el.focus({ focusVisible: true });
    if (document.activeElement !== el) continue;
    const after = sig(el);
    if (before === after) bad.push(el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 30) + ' "' + (el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 20) + '"');
    el.blur();
  }
  return JSON.stringify({ checked: Math.min(list.length, 80), bad });
})()`;

/** Controles (botão, campo, seletor, link) sem nome para o leitor de tela: sem texto, sem aria-label/labelledby, sem title, sem <label>. */
const NAMELESS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]'); };
  const named = (el) => {
    if ((el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim()) return true;
    const by = el.getAttribute('aria-labelledby');
    if (by && by.split(/\\s+/).some((id) => { const n = document.getElementById(id); return n && n.textContent.trim(); })) return true;
    if (el.labels && [...el.labels].some((l) => l.textContent.trim())) return true;
    if (el.closest('label') && el.closest('label').textContent.trim()) return true;
    if (el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) && el.value) return true;
    if (el.tagName === 'INPUT' && (el.placeholder || '').trim()) return true;
    const own = [...el.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? n.textContent : ''))).join('').trim();
    return own.length > 0 && !/^[a-z_]+$/.test(own); // só o nome de um ícone da fonte ("close") não é nome
  };
  const bad = [];
  for (const el of document.querySelectorAll('button, a[href], select, textarea, input:not([type=hidden]), [role=button], [role=tab], [role=slider]')) {
    if (visible(el) && !named(el)) bad.push(el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 30));
  }
  return JSON.stringify(bad);
})()`;

module.exports = { CONTRAST, SMALL, FOCUS, NAMELESS };
