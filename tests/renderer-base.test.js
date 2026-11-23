'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RENDERER = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const FEATURE_IDS = ['shell', 'cuts', 'export', 'queue', 'subtitles', 'audio', 'analysis', 'sources', 'general', 'prefs', 'timeline', 'tools'];

/** Arquivos .js e .css de renderer/features/, inclusive das subpastas das telas divididas (features/analysis/, features/export/), como "features/x/y.js". */
function featureFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(RENDERER, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk('features');
  return out;
}

const refs = (re) => [...html.matchAll(re)].map((m) => m[1]);
const scripts = refs(/<script[^>]*\ssrc="([^"]+)"/g);
const styles = refs(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g);

test('index.html referencia app.js, app.css e todos os arquivos de features (arquitetura 1.4)', () => {
  assert.ok(scripts.includes('app.js') && styles.includes('app.css'));
  for (const base of ['fonts.css', 'material-symbols.css']) assert.ok(styles.includes(base), `falta <link> de ${base}`);
  assert.ok(styles.indexOf('material-symbols.css') < styles.indexOf('app.css') && styles.indexOf('fonts.css') < styles.indexOf('app.css'), 'fontes antes de app.css');
  assert.ok(styles.indexOf('app.css') < styles.indexOf('features/shell.css'), 'app.css (tokens) antes dos estilos das features');
  for (const script of ['theme-init.js', 'slider-sync.js']) assert.ok(scripts.includes(script), `falta <script> de ${script}`);
  assert.ok(scripts.indexOf('theme-init.js') < scripts.indexOf('app.js') && html.indexOf('theme-init.js') < html.indexOf('app.css'), 'o tema é escolhido antes da primeira pintura');
  assert.ok(scripts.indexOf('util.js') > -1 && scripts.indexOf('util.js') < scripts.indexOf('app.js'), 'util.js (el, debounce, caminhos) antes do app.js');
  // as telas divididas: cada parte carrega antes do controlador da tela
  for (const [screen, parts] of [['analysis', ['logic', 'humor', 'engine', 'results', 'controls', 'provider']], ['export', ['logic', 'profile', 'framing', 'preview', 'view', 'layouts']]]) {
    for (const part of parts) {
      const i = scripts.indexOf(`features/${screen}/${part}.js`);
      assert.ok(i > -1 && i < scripts.indexOf(`features/${screen}.js`), `features/${screen}/${part}.js antes de features/${screen}.js`);
    }
  }
  for (const id of FEATURE_IDS) {
    assert.ok(scripts.includes(`features/${id}.js`), `falta <script> de features/${id}.js`);
    assert.ok(styles.includes(`features/${id}.css`), `falta <link> de features/${id}.css`);
  }
});

test('tudo que o index.html referencia existe e nada em features/ fica sem referência', () => {
  for (const file of [...scripts, ...styles]) {
    assert.ok(fs.existsSync(path.join(RENDERER, file)), `arquivo referenciado não existe: ${file}`);
  }
  const onDisk = featureFiles();
  const orphans = onDisk.filter((f) => !scripts.includes(f) && !styles.includes(f));
  assert.deepEqual(orphans, [], 'arquivos em renderer/features/ ausentes do index.html (só a base edita o index.html)');
});

test('app.js, o modelo e os tempos (BFTime) carregam antes das features; shell antes dos demais', () => {
  const order = scripts;
  assert.ok(order.indexOf('../src/core/projects/model.js') < order.indexOf('app.js'));
  assert.ok(order.indexOf('../src/core/projects/timecode.js') >= 0, 'falta <script> de timecode.js (BF.util.fmt/parseTime/secs vêm dele)');
  assert.ok(order.indexOf('../src/core/projects/timecode.js') < order.indexOf('app.js'), 'timecode.js antes do app.js');
  assert.ok(order.indexOf('app.js') < order.indexOf('features/shell.js'));
  for (const id of FEATURE_IDS) assert.ok(order.indexOf('app.js') < order.indexOf(`features/${id}.js`), id);
});

test('index.html respeita a CSP: sem script/estilo inline nem atributos de evento', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'script inline');
  assert.doesNotMatch(html, /<style[\s>]/, '<style> inline');
  assert.doesNotMatch(html, /\sstyle="/, 'atributo style');
  assert.doesNotMatch(html, /\son[a-z]+="/, 'atributo de evento');
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});

test('a CSP tem exatamente a política esperada (fecha também object-src, base-uri e form-action, que o default-src não cobre)', () => {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));
  assert.deepEqual(directives, {
    'default-src': ["'self'"],
    'media-src': ['file:', 'blob:'],
    'img-src': ["'self'", 'data:', 'blob:', 'file:'],
    'style-src': ["'self'"],
    'font-src': ["'self'"],
    'script-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"]
  });
  // e nada no renderer depende do que foi fechado
  for (const file of ['app.js', 'util.js', ...featureFiles().filter((f) => f.endsWith('.js'))]) {
    const code = fs.readFileSync(path.join(RENDERER, file), 'utf8');
    assert.doesNotMatch(code, /createElement\(\s*['"](?:form|base|object|embed|iframe)['"]/, `${file} cria elemento que a CSP bloqueia`);
  }
});

test('o esqueleto tem os pontos de montagem do contrato', () => {
  for (const id of ['appName', 'sourceName', 'btnOpen', 'toolsWarn', 'workspace', 'video', 'timelineSlot', 'tabBar', 'subTabs', 'tabPanels', 'log', 'toasts', 'modalRoot', 'app',
    'sidebar', 'sidebarToggleBtn', 'toolState', 'stateDot', 'stateText', 'pageTitle', 'windowControls', 'win-full', 'win-min', 'win-max', 'win-close']) {
    assert.match(html, new RegExp(`id="${id}"`), `falta #${id}`);
  }
  assert.ok(html.indexOf('id="timelineSlot"') > html.indexOf('id="video"'), '#timelineSlot abaixo do player');
});

test('estrutura do shell no padrão do BDS: sidebar (marca, abas, rodapé) e coluna principal (cabeçalho, conteúdo, estado)', () => {
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `falta ${needle}`); return i; };
  assert.match(html, /<div id="app" class="app app-shell no-project"/);
  // ordem do DOM: sidebar { marca, abas, rodapé } antes da coluna principal { cabeçalho (com o estado #log), avisos, conteúdo }
  const order = ['<aside class="sidebar"', 'class="brand-mark"', 'id="appName"', 'id="tabBar"', 'class="sidebar-footer"', 'id="toolState"',
    '<div class="main-column">', '<header class="global-header"', 'id="pageTitle"', 'id="log"', 'id="btnOpen"', 'id="win-close"', 'id="toolsWarn"', 'id="workspace"'];
  order.reduce((previous, needle) => { const i = at(needle); assert.ok(i > previous, `${needle} fora de ordem`); return i; }, -1);
  assert.match(html, /class="brand-mark"[^>]*>BF</, 'marca "BF"');
  assert.match(html, /role="tablist"[^>]*aria-orientation="vertical"/, 'menu vertical');
  // os controles de janela são botões de verdade com nome acessível
  for (const id of ['win-full', 'win-min', 'win-max', 'win-close']) assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-label="[^"]+"`), id);
  // o player e o painel de abas ficam no conteúdo, nessa ordem (a boas-vindas é a tela Novo projeto, uma aba: não há mais faixa de estado vazio)
  assert.ok(at('class="player"') < at('id="tabPanels"'));
  assert.doesNotMatch(html, /id="empty"/, 'sem a faixa de boas-vindas antiga');
  // as abas internas do item do menu ficam no painel, em cima dos painéis das telas; o layout do menu (window.BFMenu) carrega antes do app.js
  assert.ok(at('id="subTabs"') > at('<aside class="side"') && at('id="subTabs"') < at('id="tabPanels"'), '#subTabs dentro do painel, antes dos painéis');
  assert.ok(at('../src/core/ui/menuLayout.js') < at('<script src="app.js">'), 'menuLayout.js antes do app.js');
  assert.match(fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8'), /window\.BFMenu\.plan\(/, 'o shell monta o menu pelo layout');
});

test('as fontes e licenças empacotadas existem, batem com o SHA-256 documentado e o CSS só aponta para arquivos locais', () => {
  const fonts = path.join(RENDERER, 'assets', 'fonts');
  for (const file of ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Montserrat-Bold.woff2', 'material-symbols-rounded.woff2', 'OFL-Inter.txt', 'OFL-Montserrat.txt', 'APACHE-MaterialSymbols.txt', 'FONTES_ORIGEM.md']) {
    assert.ok(fs.statSync(path.join(fonts, file)).size > 100, file);
  }
  const origem = fs.readFileSync(path.join(fonts, 'FONTES_ORIGEM.md'), 'utf8');
  for (const file of fs.readdirSync(fonts).filter((f) => f.endsWith('.woff2'))) {
    assert.ok(origem.includes(file), `${file} precisa constar em FONTES_ORIGEM.md`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(fonts, file))).digest('hex');
    assert.ok(origem.includes(sha), `SHA-256 de ${file} diferente do documentado`);
  }
  for (const css of ['fonts.css', 'material-symbols.css']) {
    const text = fs.readFileSync(path.join(RENDERER, css), 'utf8');
    const urls = [...text.matchAll(/url\(['"]?([^'")]+)/g)].map((m) => m[1]);
    assert.ok(urls.length > 0, css);
    for (const url of urls) {
      assert.doesNotMatch(url, /^(https?:)?\/\//, `${css} não pode usar fonte remota`);
      assert.ok(fs.existsSync(path.join(RENDERER, url)), `${css} aponta para arquivo inexistente: ${url}`);
    }
  }
  assert.match(fs.readFileSync(path.join(RENDERER, 'material-symbols.css'), 'utf8'), /\.material-symbols-rounded\s*\{[^}]*font-feature-settings: 'liga'/s);
});

test('app.css tem os tokens do BDS nos dois temas e mantém como alias os nomes que as features usam', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'app.css'), 'utf8');
  const defined = (name) => new RegExp(`${name}\\s*:`).test(css);
  const tokens = ['--bg', '--card', '--card-2', '--text', '--muted', '--line', '--accent', '--accent-hover', '--accent-light', '--accent-solid', '--accent-text', '--on-accent',
    '--btn-bg', '--btn-fg', '--btn-bg-hover', '--danger', '--danger-bg', '--danger-solid', '--success', '--warning', '--info', '--status-ok', '--status-warn', '--status-bad', '--status-info',
    '--input-bg', '--input-border', '--radius-sm', '--radius-md', '--radius-lg', '--radius-pill', '--font-title', '--font-body', '--fs-title', '--fs-section', '--fs-body', '--fs-label',
    '--space-1', '--space-6', '--dur-fast', '--dur-base', '--dur-slow', '--focus-ring', '--ease'];
  for (const token of tokens) assert.ok(defined(token), `token ${token} não definido em app.css`);
  // as cores exatas da linguagem do BDS
  const dark = /:root,\s*\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)[1];
  const light = /\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(dark, /--bg:\s*#000000/);
  assert.match(dark, /--card:\s*#1c1c1c/);
  assert.match(dark, /--card-2:\s*#262626/);
  assert.match(dark, /--accent:\s*#ff0000/);
  assert.match(dark, /--btn-bg:\s*#ffffff/);
  assert.match(dark, /--btn-fg:\s*#000000/);
  assert.match(light, /--bg:\s*#f4f4f4/);
  assert.match(light, /--btn-bg:\s*#000000/);
  assert.match(light, /--btn-fg:\s*#ffffff/);
  // nenhum nome usado pelas features pode ficar sem definição (em app.css ou no próprio arquivo da feature)
  for (const file of fs.readdirSync(path.join(RENDERER, 'features')).filter((f) => f.endsWith('.css'))) {
    const own = fs.readFileSync(path.join(RENDERER, 'features', file), 'utf8');
    const used = new Set([...own.matchAll(/var\((--[a-zA-Z0-9-]+)(,[^)]*)?\)/g)].filter((m) => !m[2]).map((m) => m[1]));
    for (const name of used) assert.ok(defined(name) || new RegExp(`${name}\\s*:`).test(own), `features/${file} usa ${name}, que ninguém define`);
  }
  for (const alias of ['--panel', '--panel-2', '--accent-bg', '--ok', '--bad', '--warn', '--side-w']) assert.ok(defined(alias), `alias ${alias}`);
  // componentes documentados no topo do arquivo
  for (const selector of ['.primary', '.secondary', '.danger', '.link', '.panel', '.card', '.empty-state', '.bds-chip', '.bds-switch', '.bds-progress', 'input[type="range"]']) {
    assert.ok(css.includes(selector), `componente ${selector}`);
  }
});

test('a estrutura do app define as telas work e wide, o modo embutido e o menu recolhido; app.js mapeia os ícones das abas', () => {
  const css = fs.readFileSync(path.join(RENDERER, 'app.css'), 'utf8');
  assert.match(css, /#app\[data-view-kind="work"\] \.workspace/);
  assert.match(css, /#app\[data-view-kind="wide"\] \.player\s*\{\s*display:\s*none/);
  assert.match(css, /\.app-shell\.collapsed,\s*\.app-shell\.embedded\s*\{\s*--sidebar-w:\s*64px/);
  const shellCss = fs.readFileSync(path.join(RENDERER, 'features', 'shell.css'), 'utf8');
  assert.match(shellCss, /\.global-header\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(shellCss, /\.header-actions\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(shellCss, /\.embedded \.window-controls\s*\{\s*display:\s*none/);
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  for (const [id, icon] of Object.entries({ cuts: 'content_cut', export: 'ios_share', queue: 'queue', subtitles: 'subtitles', audio: 'graphic_eq', analysis: 'insights', sources: 'video_library', prefs: 'tune', tools: 'build', projects: 'folder_special' })) {
    assert.match(app, new RegExp(`${id}: '${icon}'`), `ícone padrão da aba ${id}`);
  }
  assert.match(app, /WIDE_TABS = \['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools'\]/);
  assert.match(app, /classList\.toggle\('embedded'/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /ArrowUp/);
});

test('janela sem moldura: main.js usa frame:false e os canais window:* existem no handler app.js', () => {
  const handler = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'handlers', 'app.js'), 'utf8');
  for (const channel of ['window:state', 'window:minimize', 'window:maximize', 'window:fullscreen', 'window:close']) assert.ok(handler.includes(`'${channel}'`), channel);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /frame:\s*false/);
  assert.match(main, /backgroundColor:\s*'#000000'/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
});

test('cada feature registra a aba da tabela 1.4 com id e ordem corretos', () => {
  // Início (1), Projetos (5) e Novo projeto (6, a aba `sources`, a antiga Fontes) vêm antes de Cortes: é de lá que se começa
  const tabs = { home: 1, projects: 5, sources: 6, cuts: 10, export: 20, queue: 30, subtitles: 40, audio: 50, analysis: 60, general: 75, prefs: 80, tools: 90 };
  for (const [id, order] of Object.entries(tabs)) {
    const code = fs.readFileSync(path.join(RENDERER, 'features', `${id}.js`), 'utf8');
    assert.ok(code.includes(`id: '${id}',`), `${id}.js registra id`);
    assert.ok(code.includes(`order: ${order},`), `${id}.js usa order ${order}`);
  }
});
