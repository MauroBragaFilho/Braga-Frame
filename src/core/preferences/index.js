'use strict';

/**
 * Serviço de preferências (dono: prefs): três escopos (geral, jogo, canal), prioridade provisória
 * canal > jogo > geral, aprendizado com as decisões do usuário e histórico com "reverter".
 *
 * Arquivos em `userData`: `preferences.json` (valores, ajustes do aprendizado e histórico) e
 * `learned.json` (observações dos cortes decididos). Gravação sempre atômica.
 *
 * Regras:
 *  - resolução por chave: canal (valor do usuário, depois aprendido) > jogo (idem) > geral (idem) > padrão;
 *  - nada aprendido vale sem evidência mínima (padrão 5 cortes) e sem estar ligado; tudo é visível,
 *    editável, desativável e desfazível pelo histórico.
 */

const path = require('node:path');
const { readJsonFile, writeJsonAtomic } = require('./atomic');
const { DEFS, GROUPS, findDef, validate, formatValue, pairProblem, sameValue, clone } = require('./keys');
const { SCOPE_TYPES, makeScope, scopeLabel, scopeKey, cleanName } = require('./scope');
const learning = require('./learning');
const { LearnedStore } = require('./learnedStore');

const DEFAULT_MIN_EVIDENCE = 5;
const MIN_EVIDENCE_LIMITS = Object.freeze({ min: 3, max: 100 });
const MAX_HISTORY = 300;

class PrefsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PrefsError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A mudança do valor aprendido merece um aviso na tela? Números: a partir de 20% do valor de que o usuário foi avisado
 * por último; listas: quando entra ou sai um item (só a ordem mudar não conta); o resto (perfil): qualquer troca.
 */
const RELEVANT_CHANGE = 0.2;
function isRelevantChange(before, after) {
  if (before === undefined || before === null) return true;
  if (typeof before === 'number' && typeof after === 'number') {
    const base = Math.max(Math.abs(before), 0.05);
    return Math.abs(after - before) / base >= RELEVANT_CHANGE;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const set = (list) => new Set(list.map((x) => String(x).toLowerCase()));
    const a = set(before);
    const b = set(after);
    return a.size !== b.size || [...a].some((x) => !b.has(x));
  }
  return !sameValue(before, after);
}

function emptyData() {
  return {
    version: 1,
    general: { values: {} },
    games: Object.create(null),
    channels: Object.create(null),
    learning: { enabled: true, minEvidence: DEFAULT_MIN_EVIDENCE, items: Object.create(null) },
    history: []
  };
}

function loadBuckets(raw) {
  const out = Object.create(null);
  if (!isObj(raw)) return out;
  for (const [key, bucket] of Object.entries(raw)) {
    if (!isObj(bucket) || !isObj(bucket.values)) continue;
    out[key] = { name: cleanName(bucket.name) || key, values: { ...bucket.values } };
  }
  return out;
}

function normalizeData(raw) {
  const data = emptyData();
  if (!isObj(raw)) return data;
  if (isObj(raw.general) && isObj(raw.general.values)) data.general.values = { ...raw.general.values };
  data.games = loadBuckets(raw.games);
  data.channels = loadBuckets(raw.channels);
  const lr = isObj(raw.learning) ? raw.learning : {};
  if (typeof lr.enabled === 'boolean') data.learning.enabled = lr.enabled;
  const minEv = Number(lr.minEvidence);
  if (Number.isInteger(minEv) && minEv >= MIN_EVIDENCE_LIMITS.min && minEv <= MIN_EVIDENCE_LIMITS.max) data.learning.minEvidence = minEv;
  if (isObj(lr.items)) {
    for (const [id, st] of Object.entries(lr.items)) if (isObj(st) && /^(general|game|channel):/.test(id)) data.learning.items[id] = { ...st };
  }
  if (Array.isArray(raw.history)) data.history = raw.history.filter((e) => isObj(e) && typeof e.id === 'string' && typeof e.label === 'string').slice(-MAX_HISTORY);
  return data;
}

class Preferences {
  /**
   * @param {object} opts { dir (userData), now?: () => ISO, log?: (level, msg), profileName?: (id) => nome|null }
   *   `profileName` traduz o id de um perfil de exportação para o nome mostrado ao usuário nos textos do histórico e dos avisos.
   */
  constructor({ dir, now = () => new Date().toISOString(), log = () => {}, profileName = null } = {}) {
    if (!dir) throw new Error('Preferences: informe a pasta de dados (dir).');
    this.dir = dir;
    this.now = now;
    this.log = log;
    this.profileName = typeof profileName === 'function' ? profileName : null;
    this.file = path.join(dir, 'preferences.json');
    const read = readJsonFile(this.file);
    this.notices = [];
    this.recovered = read.status === 'corrupt' ? { file: 'preferences.json', backup: read.backup } : null;
    if (this.recovered) {
      this.log('warn', `preferences.json ilegível; cópia preservada em ${read.backup || '(não foi possível copiar)'}`);
      this.notices.push({ code: 'PREFS_RECOVERED', file: 'preferences.json', message: `As preferências salvas estavam ilegíveis e recomeçaram nos padrões. ${read.backup ? `O arquivo antigo foi guardado em "${read.backup}".` : 'Não foi possível guardar uma cópia do arquivo antigo.'}` });
    }
    this.data = normalizeData(read.data);
    this.learned = new LearnedStore(path.join(dir, 'learned.json'), { now });
    if (this.learned.recovered) {
      const backup = this.learned.recovered.backup;
      this.log('warn', `learned.json ilegível; cópia preservada em ${backup || '(não foi possível copiar)'}`);
      this.notices.push({ code: 'LEARNED_RECOVERED', file: 'learned.json', message: `O aprendizado salvo estava ilegível e recomeçou do zero. ${backup ? `O arquivo antigo foi guardado em "${backup}".` : 'Não foi possível guardar uma cópia do arquivo antigo.'}` });
    }
    this._seq = this.data.history.reduce((max, e) => Math.max(max, Number(String(e.id).replace(/\D/g, '')) || 0), 0);
    this._itemsCache = null;
    this._dirty = false;
    this._depth = 0;
  }

  // ---------- armazenamento ----------

  _save() {
    writeJsonAtomic(this.file, this.data);
  }

  /**
   * Executa uma alteração e a grava (atômico). Se a gravação falhar, o estado em memória volta ao que
   * era e o erro explica a causa: memória e disco nunca divergem. Só grava se algo foi registrado no histórico.
   */
  _mutate(fn) {
    if (this._depth > 0) return fn();
    const snapshot = JSON.stringify(this.data);
    const seq = this._seq;
    this._dirty = false;
    this._depth += 1;
    try {
      const out = fn();
      if (this._dirty) this._save();
      return out;
    } catch (err) {
      this.data = normalizeData(JSON.parse(snapshot));
      this._seq = seq;
      this._itemsCache = null;
      if (err instanceof PrefsError) throw err;
      throw new PrefsError('WRITE_FAILED', `Não foi possível gravar as preferências (${err.message}). Verifique o espaço em disco e as permissões da pasta de dados do app.`);
    } finally {
      this._depth -= 1;
      this._dirty = false;
    }
  }

  _bucket(scope, create = false) {
    if (scope.type === 'general') return this.data.general;
    const map = scope.type === 'game' ? this.data.games : this.data.channels;
    if (!map[scope.key] && create) map[scope.key] = { name: scope.name, values: {} };
    return map[scope.key] || null;
  }

  _dropIfEmpty(scope) {
    if (scope.type === 'general') return;
    const map = scope.type === 'game' ? this.data.games : this.data.channels;
    if (map[scope.key] && !Object.keys(map[scope.key].values).length) delete map[scope.key];
  }

  _log(entry) {
    this._seq += 1;
    const full = { id: `h${String(this._seq).padStart(6, '0')}`, at: this.now(), ...entry };
    this.data.history.push(full);
    this._trimHistory();
    this._dirty = true;
    return full;
  }

  /**
   * Passou do limite: sai primeiro a entrada AUTOMÁTICA (aprendizado) mais antiga e só depois a mais antiga de todas,
   * para o aprendizado não empurrar para fora as alterações que o usuário fez à mão (as que ele pode desfazer).
   */
  _trimHistory() {
    const list = this.data.history;
    while (list.length > MAX_HISTORY) {
      let index = list.findIndex((e) => e.auto === true);
      if (index < 0 || index === list.length - 1) index = 0; // a entrada que acabou de entrar nunca sai
      list.splice(index, 1);
    }
  }

  /**
   * Registra o aprendizado de um item. Quando ele só MUDOU de valor (já havia sido anunciado), atualiza a entrada
   * automática dele em vez de criar outra por mediana nova (eram dezenas por sessão); a entrada vai para o fim da lista.
   */
  _logLearned(item, label, fresh) {
    if (!fresh) {
      const list = this.data.history;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.auto === true && e.kind === 'learned' && e.itemId === item.id && !e.revertedAt) {
          list.splice(i, 1);
          e.at = this.now();
          e.label = label;
          list.push(e);
          this._dirty = true;
          return e;
        }
      }
    }
    return this._log({
      kind: 'learned', auto: true, itemId: item.id, scope: item.scope, key: item.key,
      before: { enabled: false }, after: { enabled: true }, label
    });
  }

  /** Valor explícito (do usuário) de `def` no escopo, ou { has:false }. Valor inválido no arquivo é ignorado. */
  _explicit(scope, def) {
    const bucket = this._bucket(scope);
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket.values, def.key)) return { has: false };
    const checked = validate(def, bucket.values[def.key]);
    return checked.ok ? { has: true, value: checked.value } : { has: false };
  }

  // ---------- esquema ----------

  schema() {
    return {
      groups: GROUPS.map((g) => ({ ...g })),
      keys: DEFS.map((d) => ({ ...d, options: d.options ? d.options.map((o) => [...o]) : undefined, default: clone(d.default) })),
      minEvidence: { default: DEFAULT_MIN_EVIDENCE, ...MIN_EVIDENCE_LIMITS }
    };
  }

  _def(key) {
    const def = findDef(key);
    if (!def) throw new PrefsError('UNKNOWN_KEY', `Preferência desconhecida: "${key}".`);
    return def;
  }

  _scope(input) {
    const scope = makeScope(input);
    if (!scope) {
      const why = input && SCOPE_TYPES.includes(input.type) ? 'informe o nome do jogo ou do canal' : 'use geral, jogo ou canal';
      throw new PrefsError('INVALID_SCOPE', `Escopo inválido: ${why}.`);
    }
    return scope;
  }

  // ---------- aprendizado: itens ----------

  _items() {
    if (!this._itemsCache) this._itemsCache = learning.computeItems(this.learned.all());
    return this._itemsCache;
  }

  _itemView(item) {
    const st = this.data.learning.items[item.id] || {};
    const itemEnabled = st.enabled !== false;
    const edited = st.override !== undefined && st.override !== null;
    const needed = this.data.learning.minEvidence;
    let state;
    if (!this.data.learning.enabled) state = 'paused';
    else if (item.n < needed) state = 'waiting';
    else if (!itemEnabled) state = 'disabled';
    else state = 'active';
    const def = findDef(item.key);
    return {
      id: item.id, key: item.key, label: def.label, type: def.type, scope: item.scope,
      value: edited ? clone(st.override) : clone(item.value), computed: clone(item.value), edited,
      enabled: itemEnabled, state, n: item.n, needed, evidence: item.evidence
    };
  }

  /** Preferência aprendida em vigor para (escopo, chave), ou null. */
  _learnedActive(scope, key) {
    for (const item of this._items()) {
      if (item.key !== key || item.scope.type !== scope.type || item.scope.key !== scope.key) continue;
      const view = this._itemView(item);
      return view.state === 'active' ? view : null;
    }
    return null;
  }

  // ---------- resolução ----------

  _chain({ game, channel } = {}) {
    const chain = [];
    const c = makeScope({ type: 'channel', name: channel });
    const g = makeScope({ type: 'game', name: game });
    if (c) chain.push(c);
    if (g) chain.push(g);
    chain.push({ type: 'general', key: '', name: '' });
    return chain;
  }

  /**
   * Valores em vigor para um projeto com este jogo/canal. `details[chave]` explica a origem:
   * { value, scope: 'channel'|'game'|'general'|'default', source: 'explicit'|'learned'|'default',
   *   scopeName, label, evidence?, itemId? }.
   */
  resolve(names = {}) {
    const chain = this._chain(names);
    const values = {};
    const details = {};
    for (const def of DEFS) {
      let found = null;
      for (const scope of chain) {
        const own = this._explicit(scope, def);
        if (own.has) { found = { scope: scope.type, source: 'explicit', value: own.value, scopeName: scope.name }; break; }
        const learnt = this._learnedActive(scope, def.key);
        if (learnt) { found = { scope: scope.type, source: 'learned', value: learnt.value, scopeName: scope.name, evidence: learnt.evidence, itemId: learnt.id }; break; }
      }
      if (!found) found = { scope: 'default', source: 'default', value: clone(def.default) };
      found.label = this._originLabel(found);
      values[def.key] = found.value;
      details[def.key] = found;
    }
    const warnings = [];
    const min = values['analysis.minDurationSec'];
    const max = values['analysis.maxDurationSec'];
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
      warnings.push({ key: 'analysis.minDurationSec', message: `A duração mínima (${formatValue(findDef('analysis.minDurationSec'), min)}) é maior que a máxima (${formatValue(findDef('analysis.maxDurationSec'), max)}): os valores vêm de escopos diferentes. Ajuste um deles.` });
    }
    return { values, details, warnings, learning: { enabled: this.data.learning.enabled, minEvidence: this.data.learning.minEvidence } };
  }

  _originLabel(found) {
    if (found.source === 'default') return 'padrão';
    const where = found.scope === 'general' ? 'geral' : `${found.scope === 'game' ? 'jogo' : 'canal'} ${found.scopeName}`;
    return found.source === 'learned' ? `aprendida · ${where}` : where;
  }

  explain(key, names = {}) {
    this._def(key);
    return this.resolve(names).details[key];
  }

  get(key, names = {}) {
    return this.explain(key, names).value;
  }

  // ---------- edição ----------

  _snapshot(scope, key) {
    const bucket = this._bucket(scope);
    return bucket && Object.prototype.hasOwnProperty.call(bucket.values, key) ? { has: true, value: clone(bucket.values[key]) } : { has: false };
  }

  _fmt(key, value) {
    const profileName = (id) => {
      try { return this.profileName ? this.profileName(id) : null; } catch { return null; } // sem o nome, vale o id
    };
    return formatValue(findDef(key), value, { profileName });
  }

  /** Define o valor do usuário para `key` no escopo. Devolve { changed, entry? }. */
  set(scopeInput, key, value) {
    return this._mutate(() => this._set(scopeInput, key, value));
  }

  _set(scopeInput, key, value) {
    const scope = this._scope(scopeInput);
    const def = this._def(key);
    const checked = validate(def, value);
    if (!checked.ok) throw new PrefsError('INVALID_VALUE', checked.message);
    const bucketNow = this._bucket(scope);
    const siblingKey = key === 'analysis.minDurationSec' ? 'analysis.maxDurationSec' : (key === 'analysis.maxDurationSec' ? 'analysis.minDurationSec' : null);
    if (siblingKey) {
      const sibling = findDef(siblingKey);
      const own = bucketNow ? this._explicit(scope, sibling) : { has: false };
      const problem = pairProblem(key, checked.value, own.has ? own.value : sibling.default);
      if (problem) throw new PrefsError('INVALID_VALUE', problem);
    }
    const before = this._snapshot(scope, key);
    if (before.has && sameValue(before.value, checked.value)) return { changed: false };
    const bucket = this._bucket(scope, true);
    bucket.values[key] = checked.value;
    if (scope.type !== 'general') bucket.name = scope.name; // o nome mais recente (maiúsculas/acentos do usuário)
    const label = before.has
      ? `Alterou "${def.label}" (${scopeLabel(scope)}): ${this._fmt(key, before.value)} → ${this._fmt(key, checked.value)}`
      : `Definiu "${def.label}" = ${this._fmt(key, checked.value)} (${scopeLabel(scope)})`;
    const entry = this._log({ kind: 'pref', scope, key, before, after: { has: true, value: clone(checked.value) }, label });
    return { changed: true, entry };
  }

  /** Remove o valor do usuário do escopo (a chave volta a herdar). */
  unset(scopeInput, key) {
    return this._mutate(() => this._unset(scopeInput, key));
  }

  _unset(scopeInput, key) {
    const scope = this._scope(scopeInput);
    const def = this._def(key);
    const before = this._snapshot(scope, key);
    if (!before.has) return { changed: false };
    const bucket = this._bucket(scope);
    delete bucket.values[key];
    this._dropIfEmpty(scope);
    const entry = this._log({
      kind: 'pref', scope, key, before, after: { has: false },
      label: `Removeu "${def.label}" (${scopeLabel(scope)}): era ${this._fmt(key, before.value)}; volta a herdar de um escopo mais amplo ou do padrão`
    });
    return { changed: true, entry };
  }

  /** Valores do usuário num escopo + o que ele herda para cada chave. */
  list(scopeInput) {
    const scope = this._scope(scopeInput);
    const bucket = this._bucket(scope);
    const values = {};
    for (const def of DEFS) {
      const own = bucket ? this._explicit(scope, def) : { has: false };
      if (own.has) values[def.key] = own.value;
    }
    const names = scope.type === 'game' ? { game: scope.name } : (scope.type === 'channel' ? { channel: scope.name } : {});
    return { scope, values, inherited: this.resolve(names).details };
  }

  /** Nomes de jogos e canais conhecidos por preferências e aprendizado (para sugestões). */
  names() {
    const games = new Map();
    const channels = new Map();
    for (const b of Object.values(this.data.games)) games.set(scopeKey(b.name), b.name);
    for (const b of Object.values(this.data.channels)) channels.set(scopeKey(b.name), b.name);
    for (const obs of Object.values(this.learned.all())) {
      if (obs.game) games.set(scopeKey(obs.game), obs.game);
      if (obs.channel) channels.set(scopeKey(obs.channel), obs.channel);
    }
    const sorted = (map) => [...map.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { games: sorted(games), channels: sorted(channels) };
  }

  // ---------- aprendizado: observar e consultar ----------

  /**
   * Registra o estado atual de cortes de um projeto: { projectId, game, channel, cuts:[{ id, state }] }.
   * Devolve { ignored? , changes } — `changes` lista o que passou a valer (ou mudou de valor) agora.
   */
  observe({ projectId, game = '', channel = '', cuts = [], onlyKnown = false } = {}) {
    if (!this.data.learning.enabled) return { ignored: true, changes: [] };
    let changed;
    try {
      changed = this.learned.apply(projectId, { game, channel }, cuts, { onlyKnown: onlyKnown === true });
    } catch (err) {
      this._itemsCache = null;
      throw new PrefsError('WRITE_FAILED', `Não foi possível gravar o que foi aprendido (${err.message}). Verifique o espaço em disco e as permissões da pasta de dados do app.`);
    }
    if (changed) this._itemsCache = null;
    return { ignored: false, changes: this._announce() };
  }

  /** Anuncia (no histórico e para a tela) preferências aprendidas que atingiram a evidência ou mudaram de valor. */
  _announce() {
    return this._mutate(() => this._announceNow());
  }

  _announceNow() {
    const changes = [];
    if (!this.data.learning.enabled) return changes;
    const needed = this.data.learning.minEvidence;
    for (const item of this._items()) {
      if (item.n < needed) continue;
      const st = this.data.learning.items[item.id];
      if (st && st.enabled === false) continue;
      if (st && st.override !== undefined && st.override !== null) continue;
      if (st && st.announced && sameValue(st.announced.value, item.value)) continue;
      const def = findDef(item.key);
      const fresh = !(st && st.announced);
      // `notified` = o último valor de que o usuário foi avisado na tela; uma oscilação pequena (a mediana andando a cada
      // corte novo) atualiza o histórico e o cache, mas só vira aviso quando passa de um limite em relação a ele
      const lastNotified = fresh ? undefined : (st.announced.notified !== undefined ? st.announced.notified : st.announced.value);
      const notify = fresh || isRelevantChange(lastNotified, item.value);
      this.data.learning.items[item.id] = {
        ...(st || {}),
        announced: { value: clone(item.value), at: this.now(), notified: clone(notify ? item.value : lastNotified) }
      };
      const text = `"${def.label}" = ${this._fmt(item.key, item.value)} (${scopeLabel(item.scope)}) — ${item.evidence}`;
      this._logLearned(item, `${fresh ? 'Nova preferência aprendida' : 'Preferência aprendida atualizada'}: ${text}`, fresh);
      changes.push({ itemId: item.id, key: item.key, label: def.label, scope: item.scope, value: clone(item.value), evidence: item.evidence, fresh, notify, text });
    }
    return changes;
  }

  /** Preferências aprendidas dos escopos geral, do jogo e do canal informados. */
  learnedView({ game, channel } = {}) {
    const wanted = new Set(['general:']);
    const g = makeScope({ type: 'game', name: game });
    const c = makeScope({ type: 'channel', name: channel });
    if (g) wanted.add(`game:${g.key}`);
    if (c) wanted.add(`channel:${c.key}`);
    const rank = { channel: 0, game: 1, general: 2 };
    const order = new Map(DEFS.map((d, i) => [d.key, i]));
    const items = this._items()
      .filter((item) => wanted.has(`${item.scope.type}:${item.scope.key}`))
      .map((item) => this._itemView(item))
      .sort((a, b) => rank[a.scope.type] - rank[b.scope.type] || order.get(a.key) - order.get(b.key));
    return {
      enabled: this.data.learning.enabled,
      minEvidence: this.data.learning.minEvidence,
      observed: this.learned.count(),
      items
    };
  }

  /**
   * Ajusta uma preferência aprendida: { enabled } liga/desliga, { value } edita (vira o valor do item,
   * ainda marcado como aprendido e editado), { restore:true } volta ao valor calculado.
   */
  setLearned(itemId, patch = {}) {
    return this._mutate(() => this._setLearned(itemId, patch));
  }

  _setLearned(itemId, patch) {
    const item = this._items().find((i) => i.id === itemId);
    if (!item) throw new PrefsError('NOT_FOUND', 'Esta preferência aprendida não existe mais (as decisões que a sustentavam mudaram).');
    const def = findDef(item.key);
    const cur = this.data.learning.items[itemId] || {};
    const view = this._itemView(item);
    const before = { enabled: cur.enabled !== false, override: cur.override === undefined ? null : clone(cur.override) };
    const next = { ...cur };
    let label;
    if (typeof patch.enabled === 'boolean') {
      if ((cur.enabled !== false) === patch.enabled) return { changed: false, item: view };
      next.enabled = patch.enabled;
      label = `${patch.enabled ? 'Ativou' : 'Desativou'} a preferência aprendida "${def.label}" (${scopeLabel(item.scope)})`;
    } else if (patch.restore === true) {
      if (!view.edited) return { changed: false, item: view };
      delete next.override;
      label = `Voltou ao valor aprendido de "${def.label}" (${scopeLabel(item.scope)}): ${this._fmt(item.key, item.value)}`;
    } else if (patch.value !== undefined) {
      const checked = validate(def, patch.value);
      if (!checked.ok) throw new PrefsError('INVALID_VALUE', checked.message);
      if (view.edited ? sameValue(view.value, checked.value) : sameValue(item.value, checked.value)) return { changed: false, item: view };
      next.override = checked.value;
      label = `Editou a preferência aprendida "${def.label}" (${scopeLabel(item.scope)}): ${this._fmt(item.key, view.value)} → ${this._fmt(item.key, checked.value)}`;
    } else {
      throw new PrefsError('INVALID_ARGS', 'Informe o que mudar: enabled, value ou restore.');
    }
    this.data.learning.items[itemId] = next;
    const after = { enabled: next.enabled !== false, override: next.override === undefined ? null : clone(next.override) };
    const entry = this._log({ kind: 'learned', itemId, scope: item.scope, key: item.key, before, after, label });
    return { changed: true, entry, item: this._itemView(item) };
  }

  /** Ajustes do aprendizado: { enabled, minEvidence }. Com `patch`, altera (registrando no histórico). */
  learning(patch) {
    return this._mutate(() => this._learning(patch));
  }

  _learning(patch) {
    const lr = this.data.learning;
    const out = { changes: [] };
    if (patch && typeof patch === 'object') {
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new PrefsError('INVALID_VALUE', '"Aprender com minhas decisões": use ligado ou desligado.');
        if (patch.enabled !== lr.enabled) {
          const before = { enabled: lr.enabled };
          lr.enabled = patch.enabled;
          this._log({
            kind: 'learning', before, after: { enabled: lr.enabled },
            label: lr.enabled ? 'Ligou "Aprender com minhas decisões"' : 'Desligou "Aprender com minhas decisões" (nada aprendido vale enquanto estiver desligado)'
          });
          out.changes.push(...this._announce());
        }
      }
      if (patch.minEvidence !== undefined) {
        const n = Number(patch.minEvidence);
        if (!Number.isInteger(n) || n < MIN_EVIDENCE_LIMITS.min || n > MIN_EVIDENCE_LIMITS.max) {
          throw new PrefsError('INVALID_VALUE', `Evidência mínima: informe um número inteiro entre ${MIN_EVIDENCE_LIMITS.min} e ${MIN_EVIDENCE_LIMITS.max}.`);
        }
        if (n !== lr.minEvidence) {
          const before = { minEvidence: lr.minEvidence };
          lr.minEvidence = n;
          this._log({ kind: 'learning', before, after: { minEvidence: n }, label: `Evidência mínima para aprender: ${before.minEvidence} → ${n} cortes` });
          out.changes.push(...this._announce());
        }
      }
    }
    return { enabled: lr.enabled, minEvidence: lr.minEvidence, observed: this.learned.count(), changes: out.changes };
  }

  /** Apaga as observações (e o estado dos itens aprendidos). Não desfaz pelo histórico. */
  forget() {
    const had = this.learned.count();
    this._mutate(() => {
      this.data.learning.items = Object.create(null);
      this._log({ kind: 'forget', before: null, after: null, irreversible: true, label: `Esqueceu o que foi aprendido (${had} ${had === 1 ? 'corte observado' : 'cortes observados'})` });
    });
    try {
      this.learned.clear();
    } catch (err) {
      throw new PrefsError('WRITE_FAILED', `Não foi possível apagar o que foi aprendido (${err.message}). Verifique as permissões da pasta de dados do app.`);
    } finally {
      this._itemsCache = null;
    }
    return { forgotten: had };
  }

  // ---------- histórico ----------

  /** Entradas do histórico, da mais nova para a mais antiga. */
  history(limit = 50) {
    const n = Math.max(1, Math.min(MAX_HISTORY, Math.floor(Number(limit)) || 50));
    return this.data.history.slice(-n).reverse().map((e) => ({ ...e, revertible: !e.revertedAt && !e.irreversible }));
  }

  /** Desfaz uma entrada do histórico (volta ao estado de ANTES dela) e registra isso como entrada nova. */
  revert(id) {
    return this._mutate(() => this._revert(id));
  }

  _revert(id) {
    const entry = this.data.history.find((e) => e.id === id);
    if (!entry) throw new PrefsError('NOT_FOUND', 'Esta alteração não está mais no histórico.');
    if (entry.irreversible) throw new PrefsError('NOT_REVERSIBLE', 'Esta ação não pode ser desfeita.');
    if (entry.revertedAt) throw new PrefsError('ALREADY_REVERTED', 'Esta alteração já foi desfeita.');
    let current;
    if (entry.kind === 'pref') {
      const scope = this._scope(entry.scope);
      current = this._snapshot(scope, entry.key);
      if (entry.before.has) {
        const bucket = this._bucket(scope, true);
        bucket.values[entry.key] = clone(entry.before.value);
        if (scope.type !== 'general') bucket.name = scope.name;
      } else {
        const bucket = this._bucket(scope);
        if (bucket) delete bucket.values[entry.key];
        this._dropIfEmpty(scope);
      }
    } else if (entry.kind === 'learned') {
      const cur = this.data.learning.items[entry.itemId] || {};
      current = {};
      for (const field of Object.keys(entry.before)) current[field] = field === 'enabled' ? cur.enabled !== false : (cur[field] === undefined ? null : clone(cur[field]));
      const next = { ...cur };
      for (const [field, value] of Object.entries(entry.before)) {
        if (field === 'override' && value === null) delete next.override;
        else next[field] = clone(value);
      }
      this.data.learning.items[entry.itemId] = next;
    } else if (entry.kind === 'learning') {
      const lr = this.data.learning;
      current = {};
      for (const field of Object.keys(entry.before)) current[field] = lr[field];
      Object.assign(lr, entry.before);
    } else {
      throw new PrefsError('NOT_REVERSIBLE', 'Esta ação não pode ser desfeita.');
    }
    entry.revertedAt = this.now();
    const created = this._log({
      kind: entry.kind, scope: entry.scope, key: entry.key, itemId: entry.itemId, revertOf: entry.id,
      before: current, after: clone(entry.before), label: `Desfez: ${entry.label}`
    });
    return { entry: created };
  }
}

module.exports = { Preferences, PrefsError, DEFAULT_MIN_EVIDENCE, MIN_EVIDENCE_LIMITS, MAX_HISTORY };
