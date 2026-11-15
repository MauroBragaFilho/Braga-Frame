'use strict';

/**
 * IA na nuvem: configuração, chaves, aceite de privacidade e a chamada de chat. Duas origens, escolhidas pelo hospedeiro:
 *
 *   - 'local' (app próprio): provedor E modelo escolhidos pelo usuário (Gemini, Groq, OpenRouter ou Personalizado); NENHUM vem
 *     pré-selecionado e nada é enviado antes da escolha. A configuração (sem chave) fica em userData/ai/config.json e a chave no
 *     SecretStore (userData/ai/secrets.json). Uma chave por provedor.
 *   - 'host' (embutido no BDS): o hospedeiro entrega `options.ai = { describe(), chat(params) }` e FAZ a requisição ele mesmo: o Braga
 *     Frame nunca recebe nem guarda a chave. A configuração do provedor é só leitura aqui (muda nas configurações do BDS), com UMA exceção
 *     (decisão do dono, 23/10/2026): se o provedor do BDS é o OpenRouter vale o modo "Usar apenas modelos gratuitos" (ligado por padrão, com o
 *     interruptor daqui): o modelo dele passa pelo mesmo guard e a cadeia de fallback do BDS é filtrada (`acceptProvider`).
 *
 * OpenRouter (docs/recursos/openrouter-gratuito.md): o provedor tem lista de modelos ao vivo e o modo "Usar apenas modelos gratuitos", LIGADO
 * por padrão e guardado por provedor (`freeOnly`), junto com até 3 modelos de reserva (`fallbackModels`). A regra é GARANTIDA AQUI, no caminho
 * real do chat (não só na interface): cada modelo passa pelo guard antes de qualquer pedido (NOT_FREE: o pedido nem sai), o corpo nunca leva
 * `models`/`route` pagos, há ~3 s entre pedidos, a falha de um modelo tenta o próximo GRATUITO e o erro chega explicado em português.
 * Sem o serviço `openrouter` (src/ipc/handlers/aiOpenrouter.js) o OpenRouter NÃO fica pronto (falha fechada).
 *
 * O aceite de privacidade é do Braga Frame nas duas origens: nada é enviado antes de o usuário confirmar o aviso (por provedor) e `chat`
 * recusa (CONSENT_REQUIRED) enquanto não houver aceite. O aceite NÃO EXPIRA: vale até o usuário revogá-lo (decisão do dono); não há prazo,
 * contagem de usos nem renovação automática. Ele é do DESTINATÁRIO: no provedor Personalizado, mudar o endereço (outro destinatário) faz o
 * aceite ser pedido de novo; nos demais o endereço é fixo. O "Testar conexão" manda só um pedido fixo e minúsculo, sem dado do projeto.
 */

const path = require('node:path');
const { writeJsonAtomic, readJsonFile } = require('../preferences/atomic');
const { AiError, cancelled } = require('./errors');
const providers = require('./providers');
const { SecretStore } = require('./secretStore');
const { chatCompletion, redact } = require('./client');
const { checkModel } = require('./openrouter/guard');
const { mapThrownError, fullMessage, redactSecret } = require('./openrouter/errors');
const { UNSUITABLE_ID_RE, ROUTER_ID } = require('./openrouter/catalog');
const { FREE_MODE_PRIVACY } = require('./openrouter');

const MAX_FALLBACK_MODELS = 3; // modelos de reserva do OpenRouter, na ordem
const MODEL_ID_RE = /^[A-Za-z0-9~][A-Za-z0-9._~/:-]{0,119}$/;

/** Lista de modelos de reserva limpa: só ids válidos, sem repetir, no máximo MAX_FALLBACK_MODELS. */
function cleanModelList(list) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (MODEL_ID_RE.test(value) && !out.includes(value)) out.push(value);
    if (out.length >= MAX_FALLBACK_MODELS) break;
  }
  return out;
}

const LIMIT_RANGES = Object.freeze({
  maxCalls: [2, 60, 14],          // chamadas por análise (blocos + a escolha final)
  maxInputTokens: [4000, 120000, 24000], // tokens de entrada por chamada (estimados)
  windowMinutes: [10, 60, 35],    // tamanho de cada bloco de transcrição
  attempts: [1, 5, 3]             // tentativas por chamada (a primeira conta)
});

function sanitizeLimits(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [key, [min, max, def]] of Object.entries(LIMIT_RANGES)) {
    const n = Number(src[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  }
  return out;
}

const emptyConfig = () => ({
  version: 1,
  provider: null, // nenhum provedor pré-selecionado: o usuário escolhe
  providers: {},
  accepted: {},
  limits: sanitizeLimits({})
});

/**
 * O aceite guardado vale para este provedor? Vale se a ORIGEM é a mesma e, no Personalizado, se o ENDEREÇO BASE é exatamente o que o
 * usuário aceitou (outro caminho no mesmo servidor também é outro destinatário). Não há prazo: só o destinatário e o usuário decidem.
 */
function acceptedFor(entry, provider) {
  if (!entry || entry.origin !== providers.originOf(provider.baseUrl)) return false;
  return provider.id === 'custom' ? entry.baseUrl === provider.baseUrl : true;
}

class AiRuntime {
  /**
   * @param {object} o
   * @param {string} o.dir            pasta `ai` dentro de userData
   * @param {object|(()=>object|null)} [o.safeStorage]  safeStorage do Electron (ou função que o devolve)
   * @param {Function} [o.fetchImpl]  fetch (testes)
   * @param {{describe:Function, chat:Function}|null} [o.host]  provedor do hospedeiro (BDS)
   * @param {string|null} [o.hostName]
   * @param {Function} [o.restrict]   restrição de permissão do arquivo de chaves (testes)
   * @param {object|null} [o.openrouter]  serviço do OpenRouter (`ctx.aiOpenrouter`: catálogo, guard, Pacer, fallback); sem ele o OpenRouter não fica pronto
   */
  constructor({ dir, safeStorage = null, fetchImpl = null, host = null, hostName = null, restrict, openrouter = null } = {}) {
    if (!dir) throw new Error('AiRuntime: informe a pasta.');
    this.dir = dir;
    this.configFile = path.join(dir, 'config.json');
    this.secrets = new SecretStore({ file: path.join(dir, 'secrets.json'), safeStorage, ...(restrict ? { restrict } : {}) });
    this.fetchImpl = fetchImpl;
    this.host = host && typeof host.describe === 'function' && typeof host.chat === 'function' ? host : null;
    this.hostName = hostName || null;
    this.openrouter = openrouter && typeof openrouter.checkModel === 'function' && typeof openrouter.runWithFreeFallback === 'function' ? openrouter : null;
    this.noJsonMode = new Set();
  }

  get source() { return this.host ? 'host' : 'local'; }

  // ---------- configuração ----------

  _load() {
    const base = emptyConfig();
    try {
      const { data } = readJsonFile(this.configFile);
      if (data && data.version === 1) {
        if (providers.byId(data.provider)) base.provider = data.provider;
        for (const preset of providers.PRESETS) {
          const raw = data.providers && data.providers[preset.id];
          if (!raw || typeof raw !== 'object') continue;
          const entry = {};
          if (typeof raw.model === 'string') entry.model = raw.model.trim().slice(0, 120);
          if (preset.id === 'custom' && typeof raw.baseUrl === 'string') {
            try { entry.baseUrl = raw.baseUrl ? providers.normalizeBaseUrl(raw.baseUrl) : ''; } catch { entry.baseUrl = ''; }
          }
          if (preset.freeCapable) {
            entry.freeOnly = raw.freeOnly !== false; // ligado por padrão: só o valor false guardado desliga
            entry.fallbackModels = cleanModelList(raw.fallbackModels);
          }
          base.providers[preset.id] = entry;
        }
        if (data.accepted && typeof data.accepted === 'object') {
          for (const [key, value] of Object.entries(data.accepted)) {
            if (/^[A-Za-z0-9:._-]{1,80}$/.test(key) && value && typeof value.origin === 'string') {
              const entry = { origin: value.origin.slice(0, 200), at: String(value.at || '').slice(0, 40) };
              if (typeof value.baseUrl === 'string') entry.baseUrl = value.baseUrl.slice(0, 300); // destinatário exato (endereço base) que o usuário aceitou
              base.accepted[key] = entry;
            }
          }
        }
        base.limits = sanitizeLimits(data.limits);
      }
    } catch { /* arquivo ilegível: recomeça (o atomic.js já guardou o estragado como .corrupt) */ }
    return base;
  }

  _save(config) { writeJsonAtomic(this.configFile, config); }

  /** Provedor escolhido pelo usuário (com o modelo que ele informou), ou null se ainda não escolheu nenhum. */
  _providerOf(config, id = config.provider) {
    const preset = providers.byId(id);
    if (!preset) return null;
    const own = config.providers[preset.id] || {};
    const freeCapable = preset.freeCapable === true;
    const freeOnly = freeCapable ? own.freeOnly !== false : false;
    return {
      id: preset.id,
      label: preset.label,
      // o endereço do OpenRouter é o do serviço dele (o oficial; só os testes apontam para um servidor local)
      baseUrl: preset.id === 'custom' ? (own.baseUrl || '') : ((freeCapable && this.openrouter && this.openrouter.baseUrl) || preset.baseUrl),
      // sem modelo padrão: o usuário informa. Única exceção (decisão do dono, 23/10/2026): no OpenRouter o modelo VEM no roteador gratuito
      // enquanto o usuário não escolher outro (o provedor continua sendo escolha dele; o guard, a chave e o aceite valem como sempre)
      model: typeof own.model === 'string' && own.model ? own.model : (freeCapable ? ROUTER_ID : ''),
      suggestedModel: preset.suggestedModel,
      keyRequired: preset.id !== 'custom',
      keyHint: preset.keyHint,
      // modo gratuito: o aviso ganha o parágrafo dos modelos gratuitos enquanto ele estiver ligado
      privacy: freeCapable && freeOnly ? `${preset.privacy} ${FREE_MODE_PRIVACY}` : preset.privacy,
      freeCapable,
      freeOnly,
      // a reserva só vale se passa no guard (ligado: só gratuitos); um arquivo editado à mão com um id pago nunca chega ao pedido
      fallbackModels: freeCapable ? cleanModelList(own.fallbackModels).filter((id) => !freeOnly || this._freeCheck(id).ok) : []
    };
  }

  /** O guard do modo gratuito para um id (com o catálogo que já está neste computador). Sem o serviço, só o roteador e o sufixo `:free`. */
  _freeCheck(modelId, freeOnly = true) {
    return this.openrouter ? this.openrouter.checkModel(modelId, { freeOnly }) : checkModel(modelId, { freeOnly });
  }

  /** A chave guardada de um provedor, SÓ para o processo principal (o cabeçalho de pedidos ao próprio provedor). null se não há, não dá para ler ou o provedor é do hospedeiro. */
  secretFor(providerId) {
    return this.host ? null : this.secrets.get(providerId);
  }

  limits() { return this._load().limits; }

  // ---------- provedor do hospedeiro (BDS) e o modo gratuito ----------

  /** O que o hospedeiro diz do provedor ativo (sem lançar), ou null. */
  _hostInfo() {
    let info = null;
    try { info = this.host.describe(); } catch { info = null; }
    return info && typeof info === 'object' ? info : null;
  }

  /** O servidor é o do OpenRouter? (`openrouter.ai`; nos testes, o servidor local que o serviço usa no lugar dele.) */
  _isOpenRouterHost(serverHost) {
    const host = String(serverHost || '').trim().toLowerCase();
    if (!host || !this.openrouter) return false;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') || host === providers.hostOf(this.openrouter.baseUrl).toLowerCase();
  }

  /**
   * "Usar apenas modelos gratuitos" TAMBÉM com o provedor do hospedeiro (decisão do dono, 23/10/2026): se o provedor ativo do BDS é o OpenRouter e o
   * modo está ligado (padrão; só o valor `false` guardado desliga), o modelo dele passa pelo MESMO guard do app próprio. A cadeia de fallback do
   * hospedeiro também é filtrada (`acceptProvider`, veja chat). -> { applies, freeOnly, ok, message }
   */
  _hostFreeGuard(info, config = this._load()) {
    if (!info || !this._isOpenRouterHost(info.serverHost)) return { applies: false, freeOnly: false, ok: true, message: '' };
    const freeOnly = (config.providers.openrouter || {}).freeOnly !== false;
    if (!freeOnly) return { applies: true, freeOnly: false, ok: true, message: '' };
    const verdict = this._freeCheck(info.model, true);
    return { applies: true, freeOnly: true, ok: verdict.ok, message: verdict.ok ? '' : this._hostNotFreeMessage(info.model) };
  }

  _hostNotFreeMessage(modelId) {
    const where = this.hostName || 'aplicativo';
    const why = this.openrouter && typeof this.openrouter.explainModel === 'function' ? this.openrouter.explainModel(modelId) : 'O modelo do assistente não é gratuito.';
    return `${why} O assistente do ${where} usa o OpenRouter e, com "Usar apenas modelos gratuitos" ligado, o app só usa modelos gratuitos: nada foi enviado e nada foi cobrado. Troque o modelo nas configurações do assistente do ${where} (o roteador gratuito é "openrouter/free") ou desligue o interruptor aqui se quiser usar um modelo pago, cobrado na sua conta do OpenRouter.`;
  }

  /** Um provedor `p` ({ id, label, model, serverHost }) da cadeia do hospedeiro pode ser usado? Só o OpenRouter está sujeito ao modo gratuito. */
  _hostAccepts(p) {
    if (!p || !this._isOpenRouterHost(p.serverHost)) return true;
    return this._freeCheck(p.model, true).ok;
  }

  /** Com o provedor do hospedeiro só dá para ver, EXCETO o interruptor "Usar apenas modelos gratuitos" quando o provedor do BDS é o OpenRouter. */
  _saveHost(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const keys = Object.keys(p).filter((k) => p[k] !== undefined);
    if (keys.length !== 1 || keys[0] !== 'freeOnly') throw new AiError('INVALID_ARGS', `O provedor é configurado no ${this.hostName || 'aplicativo'}; aqui só dá para ver.`);
    if (!this._hostFreeGuard(this._hostInfo()).applies) throw new AiError('INVALID_ARGS', 'O modo gratuito só existe quando o provedor do assistente é o OpenRouter.');
    if (typeof p.freeOnly !== 'boolean') throw new AiError('INVALID_ARGS', 'Informe se o modo "Usar apenas modelos gratuitos" fica ligado ou desligado.');
    const config = this._load();
    config.providers.openrouter = { ...(config.providers.openrouter || {}), freeOnly: p.freeOnly };
    this._save(config);
    return this.state();
  }

  // ---------- estado público (NUNCA inclui a chave) ----------

  /** Provedor em uso: o do hospedeiro ou o escolhido aqui. `consentKey` identifica o aceite de privacidade. */
  describe() {
    const config = this._load();
    if (this.host) {
      const info = this._hostInfo();
      if (!info) {
        return { source: 'host', hostName: this.hostName, id: null, label: '', model: '', baseUrl: '', host: '', hasKey: false, keyRequired: true, ready: false, reason: `O ${this.hostName || 'aplicativo'} ainda não tem um provedor de IA configurado.`, consentKey: null, accepted: false, privacy: '', loopback: false };
      }
      const id = String(info.id || 'padrao').slice(0, 40);
      const consentKey = `host:${id}`;
      const guard = this._hostFreeGuard(info, config);
      const blocked = info.ready === true && guard.applies && guard.freeOnly && !guard.ok; // o provedor do BDS está pronto, mas o modelo não é gratuito
      const ready = info.ready === true && !blocked;
      return {
        source: 'host', hostName: this.hostName, id, label: String(info.label || info.name || id).slice(0, 60), model: String(info.model || '').slice(0, 120),
        baseUrl: '', host: String(info.serverHost || '').slice(0, 120), hasKey: info.hasKey === true, keyRequired: info.keyRequired !== false, ready,
        reason: blocked ? guard.message : (ready ? '' : `${info.reason ? `${String(info.reason).slice(0, 160)} ` : ''}Configure o provedor de IA no ${this.hostName || 'aplicativo'}.`),
        ...(blocked ? { reasonCode: 'NOT_FREE' } : {}),
        consentKey, accepted: Boolean(config.accepted[consentKey]),
        privacy: `O conteúdo vai para o servidor do provedor que você configurou no ${this.hostName || 'aplicativo'}.${guard.applies && guard.freeOnly ? ` ${FREE_MODE_PRIVACY}` : ''}`,
        loopback: info.isLocal === true,
        ...(guard.applies ? { freeCapable: true, freeOnly: guard.freeOnly } : {})
      };
    }
    const p = this._providerOf(config);
    if (!p) {
      // nenhum provedor escolhido: nada está pronto e nada pode ser enviado
      return {
        source: 'local', hostName: null, id: null, label: '', model: '', suggestedModel: '', baseUrl: '', host: '', hasKey: false, keyStatus: 'none',
        keyRequired: true, keyHint: '', ready: false, reason: 'Escolha o provedor de IA.', reasonCode: 'NOT_CONFIGURED', consentKey: null, accepted: false, privacy: '', loopback: false
      };
    }
    const keyStatus = this.secrets.status(p.id);
    let reason = '';
    let reasonCode = '';
    if (!p.baseUrl) { reason = 'Informe o endereço do servidor.'; reasonCode = 'NOT_CONFIGURED'; }
    else if (!p.model) { reason = 'Informe o modelo.'; reasonCode = 'NOT_CONFIGURED'; }
    else if (p.freeCapable && !this.openrouter) { reason = 'O modo gratuito do OpenRouter não está disponível neste app.'; reasonCode = 'NOT_CONFIGURED'; }
    else if (p.freeCapable && p.freeOnly && !this._freeCheck(p.model, true).ok) { reason = this._freeCheck(p.model, true).message; reasonCode = 'NOT_FREE'; }
    else if (p.keyRequired && keyStatus === 'none') { reason = 'Informe a chave de API.'; reasonCode = 'NO_KEY'; }
    else if (keyStatus === 'unreadable') { reason = 'A chave guardada não pôde ser lida neste computador. Informe a chave de novo.'; reasonCode = 'NO_KEY'; }
    return {
      source: 'local', hostName: null, id: p.id, label: p.label, model: p.model, suggestedModel: p.suggestedModel, baseUrl: p.baseUrl, host: providers.hostOf(p.baseUrl),
      hasKey: keyStatus !== 'none', keyStatus, keyRequired: p.keyRequired, keyHint: p.keyHint, ready: !reason, reason, reasonCode, consentKey: p.id,
      accepted: acceptedFor(config.accepted[p.id], p), privacy: p.privacy,
      loopback: p.baseUrl ? providers.isLoopbackHost(new URL(p.baseUrl).hostname) : false,
      ...(p.freeCapable ? { freeCapable: true, freeOnly: p.freeOnly, fallbackModels: p.fallbackModels } : {})
    };
  }

  /** Estado para a interface. Sem chave, em nenhum campo. */
  state() {
    const config = this._load();
    const current = this.describe();
    const mode = this.secrets.mode();
    return {
      source: this.source,
      hostName: this.hostName,
      readOnly: this.source === 'host',
      presets: this.source === 'host' ? [] : providers.PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, suggestedModel: p.suggestedModel, freeCapable: p.freeCapable === true })),
      selected: this.source === 'host' ? null : config.provider, // null = o usuário ainda não escolheu
      provider: current,
      ready: current.ready,
      accepted: current.accepted,
      encryption: this.source === 'host' ? null : mode,
      encryptionNote: this.source === 'host' ? '' : (mode === 'safeStorage'
        ? 'A chave é guardada cifrada pelo Windows (só a sua conta lê).'
        : 'O sistema não oferece cifragem aqui: a chave fica em um arquivo local sem cifra, com permissão restrita à sua conta.'),
      limits: config.limits,
      limitRanges: Object.fromEntries(Object.entries(LIMIT_RANGES).map(([k, [min, max]]) => [k, [min, max]]))
    };
  }

  // ---------- alterações ----------

  /**
   * patch: { provider?, model?, baseUrl? (só Personalizado), apiKey?, clearKey?, limits? }. Valida tudo antes de gravar qualquer coisa.
   * A chave nunca volta na resposta. No Personalizado, trocar o endereço = outro destinatário: o aceite do aviso de privacidade é apagado
   * (será pedido de novo) e, se a ORIGEM mudou, a chave também (não se reenvia a chave a servidor novo). Remover só a chave NÃO revoga o aceite.
   */
  save(patch = {}) {
    if (this.host) return this._saveHost(patch);
    const config = this._load();
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.provider !== undefined) {
      if (!providers.byId(p.provider)) throw new AiError('INVALID_ARGS', 'Provedor desconhecido.');
      config.provider = p.provider;
    }
    const id = config.provider;
    const touchesProvider = p.model !== undefined || p.baseUrl !== undefined || (typeof p.apiKey === 'string' && p.apiKey.trim()) || p.clearKey === true;
    if (touchesProvider && !id) throw new AiError('INVALID_ARGS', 'Escolha o provedor de IA primeiro.');
    const own = id ? { ...(config.providers[id] || {}) } : {};
    let dropKey = false;
    let dropConsent = false;
    if (p.model !== undefined) {
      const model = String(p.model).trim();
      if (model.length > 120 || /[\s]/.test(model)) throw new AiError('INVALID_ARGS', 'O nome do modelo não pode ter espaços (máximo 120 caracteres).');
      own.model = model;
    }
    if (p.baseUrl !== undefined) {
      if (id !== 'custom') throw new AiError('INVALID_ARGS', 'O endereço só pode ser mudado no provedor Personalizado.');
      let next;
      try { next = p.baseUrl ? providers.normalizeBaseUrl(p.baseUrl) : ''; } catch (err) { throw new AiError('INVALID_ARGS', err.message); }
      if (next !== (own.baseUrl || '')) dropConsent = true; // outro endereço = outro destinatário: o aceite é pedido de novo
      if (providers.originOf(next) !== providers.originOf(own.baseUrl || '')) dropKey = true; // outro servidor: a chave não vai junto
      own.baseUrl = next;
    }
    if (p.freeOnly !== undefined || p.fallbackModels !== undefined) {
      if (!id || !providers.byId(id).freeCapable) throw new AiError('INVALID_ARGS', 'O modo gratuito e os modelos de reserva só existem no OpenRouter.');
      if (p.freeOnly !== undefined) {
        if (typeof p.freeOnly !== 'boolean') throw new AiError('INVALID_ARGS', 'Informe se o modo "Usar apenas modelos gratuitos" fica ligado ou desligado.');
        own.freeOnly = p.freeOnly;
      }
      if (p.fallbackModels !== undefined) {
        if (!Array.isArray(p.fallbackModels) || p.fallbackModels.length > MAX_FALLBACK_MODELS) throw new AiError('INVALID_ARGS', `Escolha até ${MAX_FALLBACK_MODELS} modelos de reserva.`);
        const list = [];
        for (const raw of p.fallbackModels) {
          const value = typeof raw === 'string' ? raw.trim() : '';
          if (!MODEL_ID_RE.test(value)) throw new AiError('INVALID_ARGS', 'Um dos modelos de reserva tem um nome inválido.');
          if (!list.includes(value)) list.push(value);
        }
        own.fallbackModels = list;
      }
    }
    if (id && providers.byId(id).freeCapable) {
      // com o modo gratuito ligado a reserva só pode ter modelos gratuitos: o que o usuário manda é recusado; ao ligar o modo, o que não serve sai
      const freeNow = own.freeOnly !== false;
      if (freeNow && Array.isArray(own.fallbackModels)) {
        if (p.fallbackModels !== undefined) {
          for (const modelId of own.fallbackModels) {
            const verdict = this._freeCheck(modelId, true);
            if (!verdict.ok) throw new AiError('NOT_FREE', verdict.message);
          }
        } else if (p.freeOnly === true) {
          own.fallbackModels = own.fallbackModels.filter((modelId) => this._freeCheck(modelId, true).ok);
        }
      }
    }
    if (p.limits !== undefined) config.limits = sanitizeLimits({ ...config.limits, ...(p.limits && typeof p.limits === 'object' ? p.limits : {}) });
    if (id) config.providers[id] = own;

    if (typeof p.apiKey === 'string' && p.apiKey.trim()) {
      try { this.secrets.set(id, p.apiKey); } catch (err) { throw new AiError('INVALID_ARGS', redact(err.message, p.apiKey)); }
      dropKey = false; // a chave nova é do endereço novo
    } else if (p.clearKey === true || dropKey) {
      this.secrets.remove(id);
    }
    if (dropConsent && id) delete config.accepted[id];
    this._save(config);
    return this.state();
  }

  /**
   * Registra (ou revoga) o aceite do aviso de privacidade para o provedor em uso. O aceite NÃO tem prazo: vale até o usuário revogá-lo
   * (ou até o destinatário mudar). `at` só registra QUANDO foi aceito; nada o lê para expirar.
   */
  accept(accepted) {
    const config = this._load();
    const current = this.describe();
    if (!current.consentKey) throw new AiError('NOT_CONFIGURED', 'Escolha o provedor de IA antes de aceitar o aviso.');
    if (accepted === false) delete config.accepted[current.consentKey];
    else {
      config.accepted[current.consentKey] = this.source === 'host'
        ? { origin: 'host', at: new Date().toISOString() }
        : { origin: providers.originOf(current.baseUrl), baseUrl: current.baseUrl, at: new Date().toISOString() };
    }
    this._save(config);
    return this.state();
  }

  // ---------- chamadas ----------

  _requireReady(current) {
    if (!current.ready) throw new AiError(current.reasonCode || (current.hasKey || !current.keyRequired ? 'NOT_CONFIGURED' : 'NO_KEY'), current.reason || 'O provedor de IA não está configurado.');
  }

  /** Pedido de chat ao provedor em uso. Recusa (CONSENT_REQUIRED) enquanto o aviso de privacidade não foi aceito. */
  async chat(params, { requireConsent = true } = {}) {
    const current = this.describe();
    this._requireReady(current);
    if (requireConsent && !current.accepted) {
      throw new AiError('CONSENT_REQUIRED', 'Antes de enviar qualquer trecho, confirme o aviso de privacidade do provedor de IA.');
    }
    if (this.host) {
      // com o OpenRouter no BDS e o modo gratuito ligado, o hospedeiro só pode usar provedores que passam no guard (a cadeia de fallback dele também)
      const guard = this._hostFreeGuard(this._hostInfo());
      let out;
      try {
        out = await this.host.chat({
          system: params.system, messages: params.messages, maxTokens: params.maxTokens, temperature: params.temperature,
          jsonMode: params.jsonMode === true, signal: params.signal || null,
          ...(guard.applies && guard.freeOnly ? { acceptProvider: (p) => this._hostAccepts(p) } : {})
        });
      } catch (err) {
        if (err && err.code === 'AI_NOT_ALLOWED') throw new AiError('NOT_FREE', this._hostNotFreeMessage((this._hostInfo() || {}).model));
        throw err;
      }
      const text = out && typeof out.text === 'string' ? out.text : '';
      const usage = out && out.usage ? out.usage : {};
      return {
        text,
        usage: {
          promptTokens: Number.isFinite(usage.promptTokens) ? usage.promptTokens : (Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null),
          completionTokens: Number.isFinite(usage.completionTokens) ? usage.completionTokens : (Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null)
        },
        finishReason: (out && out.finishReason) || null,
        provider: { id: current.id, label: current.label, model: (out && out.model) || current.model },
        ...(out && typeof out.model === 'string' && out.model ? { answeredModel: out.model } : {})
      };
    }
    const config = this._load();
    const p = this._providerOf(config);
    const apiKey = this.secrets.get(p.id);
    if (p.freeCapable) return this._chatOpenRouter(params, p, apiKey);
    const res = await chatCompletion({
      baseUrl: p.baseUrl, apiKey, model: p.model, system: params.system, messages: params.messages, maxTokens: params.maxTokens,
      temperature: params.temperature, jsonMode: params.jsonMode === true, signal: params.signal, timeoutMs: params.timeoutMs,
      fetchImpl: this.fetchImpl || undefined, noJsonMode: this.noJsonMode
    }).catch((err) => {
      // defesa em profundidade: mesmo um erro inesperado nunca leva a chave adiante
      if (err && typeof err.message === 'string') err.message = redact(err.message, apiKey);
      throw err;
    });
    return { ...res, provider: { id: p.id, label: p.label, model: p.model } };
  }

  /**
   * Pedido de chat ao OpenRouter com a regra "só gratuitos" GARANTIDA aqui, no caminho real (docs/recursos/openrouter-gratuito.md):
   *  - cada modelo da lista [escolhido, ...reservas] passa pelo guard antes de qualquer pedido, e o corpo que de fato vai sair é conferido
   *    de novo (NOT_FREE: o pedido nem sai) e limpo de `models`/`route`/plugin de busca pagos;
   *  - o Pacer deixa ~3 s entre pedidos (20 por minuto) e respeita o que o servidor mandou esperar;
   *  - a falha de um modelo (404, 429 por minuto ou do provedor, 5xx, tempo esgotado) tenta o PRÓXIMO da lista, só entre gratuitos
   *    (com o modo ligado); 401, 402, a cota do dia e o pedido recusado não trocam de modelo;
   *  - a falha chega explicada em português (o que houve + o que fazer), sem a chave, com o código certo para a análise decidir.
   * Devolve como o chat de sempre, mais `answeredModel` (o campo `model` da resposta: quem de fato respondeu) e `requestedModel`.
   * `params.onSwitch({ from, to, reason })` avisa quando troca de modelo; `params.extraBody` leva campos extras do provedor (passam pelo guard).
   */
  async _chatOpenRouter(params, p, apiKey) {
    const or = this.openrouter;
    const freeOnly = p.freeOnly;
    const attempt = async (modelId) => {
      if (params.signal && params.signal.aborted) throw cancelled();
      await or.pacer.wait({ signal: params.signal || undefined });
      const res = await chatCompletion({
        baseUrl: p.baseUrl, apiKey, model: modelId, system: params.system, messages: params.messages, maxTokens: params.maxTokens,
        temperature: params.temperature, jsonMode: params.jsonMode === true, signal: params.signal, timeoutMs: params.timeoutMs,
        fetchImpl: this.fetchImpl || undefined, noJsonMode: this.noJsonMode, extraBody: params.extraBody,
        beforeSend: (body) => {
          const verdict = this._freeCheck(body.model, freeOnly);
          if (!verdict.ok) throw new AiError('NOT_FREE', verdict.message);
          return or.sanitizeBody(body, { freeOnly }).body;
        }
      });
      // Medido em rede real (23/10/2026): o roteador gratuito sorteou "nvidia/nemotron-3.5-content-safety:free", um classificador de moderação
      // que respondeu "User Safety: unsafe" a um pedido de análise (HTTP 200, sem JSON). Resposta de modelo de moderação/segurança nunca é
      // resposta de análise: vale como falha da tentativa (a reserva do usuário, se houver, ou uma nova tentativa sorteiam outro modelo).
      const answered = typeof res.model === 'string' ? res.model : '';
      if (answered && answered !== modelId && UNSUITABLE_ID_RE.test(answered)) {
        throw new AiError('BAD_RESPONSE', `O roteador gratuito sorteou "${redactSecret(answered, apiKey).slice(0, 120)}", um modelo de moderação que não serve para esta análise. Para evitar isso, escolha um modelo fixo da lista.`);
      }
      return res;
    };
    try {
      const out = await or.runWithFreeFallback([p.model, ...p.fallbackModels], attempt, { freeOnly, onSwitch: params.onSwitch, signal: params.signal || undefined, apiKey });
      return { ...out.value, provider: { id: p.id, label: p.label, model: p.model }, answeredModel: out.model, requestedModel: out.requestedModel };
    } catch (err) {
      throw this._explainOpenRouterError(err, p, apiKey);
    }
  }

  /** A falha do OpenRouter já explicada em português (mensagem + o que fazer), com o código certo e sem a chave. Devolve o mesmo erro, ajustado. */
  _explainOpenRouterError(err, p, apiKey) {
    if (!err || typeof err !== 'object') return err;
    if (typeof err.message === 'string') err.message = redactSecret(err.message, apiKey);
    if (err.code === 'CANCELLED') return err;
    const tried = Array.isArray(err.fallbackAttempts) ? err.fallbackAttempts : [];
    const info = mapThrownError(err, { model: tried.length ? tried[tried.length - 1].model : p.model, apiKey });
    if (!info || info.status === null) return err; // sem status (rede, tempo esgotado, NOT_FREE…): a mensagem de origem já é clara
    if (info.code !== 'UNKNOWN') err.code = info.code;
    err.message = redactSecret(fullMessage(info), apiKey);
    if (info.retryable && Number.isFinite(info.retryAfterMs)) err.retryAfterSec = Math.max(1, Math.ceil(info.retryAfterMs / 1000));
    err.details = {
      ...(err.details && typeof err.details === 'object' ? err.details : {}),
      solution: info.solution, scope: info.scope,
      ...(tried.length > 1 ? { models: tried.map((t) => ({ model: t.model, code: t.code })) } : {})
    };
    return err;
  }

  /**
   * Antes de uma análise: com o OpenRouter e o modo gratuito ligado, confere a lista pública de modelos (vale o cache de 6 h; sem rede, o
   * último cache) para o guard decidir com os dados de hoje. Não envia nada do usuário (o catálogo é público) e nunca lança por falta de rede.
   * Devolve { checked, source, fetchedAt, warning } (warning = { code, message } quando a lista usada é velha ou não existe).
   */
  async prepare() {
    const out = { checked: false, source: null, fetchedAt: null, warning: null };
    if (!this.openrouter || typeof this.openrouter.prepare !== 'function') return out;
    if (this.host) {
      const guard = this._hostFreeGuard(this._hostInfo());
      if (!guard.applies || !guard.freeOnly) return out;
    } else {
      const p = this._providerOf(this._load());
      if (!p || !p.freeCapable || !p.freeOnly) return out;
    }
    const res = await this.openrouter.prepare();
    return { checked: true, source: res.source, fetchedAt: res.fetchedAt, warning: res.warning || null };
  }

  /** "Testar conexão": um pedido fixo e minúsculo (sem nenhum dado do projeto). Devolve { ok, message, ms }; falha lança AiError. */
  async test({ signal } = {}) {
    const current = this.describe();
    this._requireReady(current);
    const t0 = Date.now();
    const res = await this.chat({ system: 'Responda apenas com a palavra: ok', messages: [{ role: 'user', content: 'Teste de conexão.' }], maxTokens: 16, temperature: 0, signal }, { requireConsent: false });
    return { ok: true, message: `Conexão ok com ${current.label} (${current.model}).`, ms: Date.now() - t0, replied: res.text.trim().length > 0 };
  }
}

module.exports = { AiRuntime, LIMIT_RANGES, sanitizeLimits };
