'use strict';

/**
 * Aba "Exportar" — cartão "Exportar para o editor de vídeo" (DaVinci Resolve, Premiere). Os cortes viram uma timeline que o editor abre
 * (XML do Final Cut 7, EDL, lista de tempos) e as legendas, alinhadas à timeline, saem em .srt e .ass (com o estilo em .json).
 * Nada é recodificado: o vídeo original não é tocado. Lógica e gravação: src/core/export/timeline.js e src/ipc/handlers/timeline.js.
 * Carrega ANTES de export.js, que chama `BFExportEditor.build()` e põe o cartão na aba.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const FORMATS = [
    { id: 'xml', label: 'XML', hint: 'Premiere e DaVinci: Arquivo > Importar (Final Cut Pro 7)', on: true },
    { id: 'edl', label: 'EDL', hint: 'mais simples; os dois editores aceitam', on: false },
    { id: 'times', label: 'Lista de tempos', hint: '00:00:02.000 -> 00:00:10.500, para a janela de cortes do Resolve', on: false },
    { id: 'subs', label: 'Legendas', hint: '.srt (texto e tempo), .ass e o estilo em .json', on: true }
  ];

  const state = { dir: '', busy: false, last: null };
  let ui = null;

  const project = () => BF.state.project;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const baseNameOf = (file) => String(file || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'Braga Frame';

  function counts() {
    const p = project();
    const cuts = p ? p.cuts : [];
    const approved = cuts.filter((c) => c.status === 'approved');
    const all = cuts.filter((c) => c.status !== 'rejected');
    const withSubs = (list) => list.filter((c) => c.subtitles && Array.isArray(c.subtitles.cues) && c.subtitles.cues.some((q) => q && String(q.text || '').trim())).length;
    return { approved: approved.length, all: all.length, subsApproved: withSubs(approved), subsAll: withSubs(all) };
  }

  function chosenFormats() {
    return FORMATS.filter((f) => ui.boxes[f.id].checked).map((f) => f.id);
  }

  function build() {
    ui = { boxes: {} };
    const rows = FORMATS.map((f) => {
      const box = el('input', { type: 'checkbox', id: `exp-ed-${f.id}`, checked: f.on, onchange: refresh });
      ui.boxes[f.id] = box;
      return el('label', { class: 'exp-ed-opt' }, box, el('span', {}, el('strong', {}, f.label), el('span', { class: 'muted small' }, ` — ${f.hint}`)));
    });
    ui.scope = el('select', { id: 'exp-ed-scope', 'aria-label': 'Quais cortes exportar', onchange: refresh },
      el('option', { value: 'approved' }, 'Só os aprovados'),
      el('option', { value: 'all' }, 'Todos, menos os rejeitados'));
    ui.info = el('p', { class: 'muted small', id: 'exp-ed-info' });
    ui.dir = el('span', { class: 'exp-dir muted small', id: 'exp-ed-dir' });
    ui.run = el('button', { type: 'button', id: 'exp-ed-run', class: 'sm', onclick: run }, el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, 'movie_edit'), 'Exportar para o editor…');
    ui.reveal = el('button', { type: 'button', id: 'exp-ed-reveal', class: 'secondary sm', hidden: true, onclick: () => state.last && BF.api('shell:reveal', { path: `${state.last.dir}\\${state.last.files[0]}` }) }, 'Mostrar na pasta');
    ui.msg = el('p', { class: 'small exp-msg', id: 'exp-ed-msg', role: 'status', hidden: true });
    ui.warn = el('ul', { class: 'small muted exp-ed-warn', id: 'exp-ed-warn', hidden: true });
    ui.style = el('p', { class: 'muted small', id: 'exp-ed-style' }, 'O estilo da legenda (fonte, cor, contorno) não viaja no .srt nem no XML: use o .ass ou o .json ao lado para refazê-lo no editor, ou exporte o vídeo com a legenda incorporada.');
    ui.root = el('section', { class: 'exp-sec exp-editor', id: 'exp-editor' },
      el('h3', { class: 'exp-h' }, 'Exportar para o editor de vídeo'),
      el('p', { class: 'muted small' }, 'Gera uma timeline com os cortes sobre o vídeo original (nada é recodificado) para abrir no DaVinci Resolve ou no Premiere, com as legendas alinhadas.'),
      el('div', { class: 'exp-ed-opts' }, rows),
      el('label', { class: 'exp-ed-scope' }, el('span', { class: 'muted small' }, 'Cortes'), ui.scope),
      ui.info, ui.style,
      el('div', { class: 'exp-actions' }, ui.run, ui.reveal), ui.dir, ui.msg, ui.warn);
    refresh();
    return ui.root;
  }

  function refresh() {
    if (!ui) return;
    const c = counts();
    const useAll = ui.scope.value === 'all';
    const n = useAll ? c.all : c.approved;
    const withSubs = useAll ? c.subsAll : c.subsApproved;
    const formats = chosenFormats();
    const wantSubs = formats.includes('subs');
    ui.info.textContent = n
      ? `${plural(n, 'corte', 'cortes')}${wantSubs ? ` · ${withSubs} com legenda gerada${withSubs < n ? ' (gere as outras na aba Legendas)' : ''}` : ''}.`
      : (useAll ? 'Não há cortes para exportar.' : 'Nenhum corte aprovado. Aprove cortes na aba Cortes ou escolha "Todos".');
    ui.style.hidden = !wantSubs;
    ui.run.disabled = state.busy || !project() || !n || !formats.length;
    ui.run.title = !formats.length ? 'Escolha ao menos um formato.' : '';
    ui.dir.textContent = state.dir ? `Última pasta: ${state.dir}` : '';
    ui.dir.hidden = !state.dir;
  }

  function show(text, kind) {
    ui.msg.textContent = text;
    ui.msg.className = `small exp-msg${kind === 'error' ? ' exp-msg-error' : ''}`;
    ui.msg.hidden = !text;
  }

  async function run() {
    const p = project();
    if (!p || state.busy) return;
    const picked = await BF.api('export:pickDir', {});
    if (!picked.ok || picked.canceled || !picked.path) return;
    state.dir = picked.path;
    state.busy = true;
    refresh();
    show('Gravando os arquivos…');
    ui.warn.hidden = true;
    const info = BF.state.info || {};
    const res = await BF.api('timeline:export', {
      cuts: p.cuts, dir: picked.path, name: baseNameOf(p.source.path), status: ui.scope.value, formats: chosenFormats(),
      source: { path: p.source.path, duration: p.source.duration || info.duration || 0, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio }
    });
    state.busy = false;
    if (!res.ok) {
      state.last = null;
      ui.reveal.hidden = true;
      show(res.message || 'Não foi possível exportar.', 'error');
      BF.ui.log(res.message || 'Falha ao exportar para o editor.', 'error');
      refresh();
      return;
    }
    state.last = res;
    const s = res.summary;
    show(`${plural(res.files.length, 'arquivo gravado', 'arquivos gravados')} em ${res.dir}: ${plural(s.clips, 'corte', 'cortes')}, ${Math.round(s.seconds)} s${s.cues ? `, ${plural(s.cues, 'fala', 'falas')} de legenda` : ''}, ${String(s.fps).replace('.', ',')} quadros/s.`);
    ui.warn.replaceChildren(...res.warnings.map((w) => el('li', {}, w)));
    ui.warn.hidden = !res.warnings.length;
    ui.reveal.hidden = false;
    BF.ui.toast('Arquivos para o editor gravados.', 'ok');
    BF.ui.log(`Exportação para o editor: ${res.files.join(', ')}`, 'ok');
    refresh();
  }

  BF.bus.on('cuts:changed', refresh);
  BF.bus.on('project:loaded', () => { state.last = null; if (ui) { ui.reveal.hidden = true; ui.msg.hidden = true; ui.warn.hidden = true; } refresh(); });

  window.BFExportEditor = { build, refresh };
})();
