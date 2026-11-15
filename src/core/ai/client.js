'use strict';

/**
 * Cliente ÚNICO do protocolo `chat/completions` compatível com a OpenAI (serve a Gemini, Groq, OpenRouter e a qualquer servidor
 * personalizado). Sem dependências: usa o `fetch` do Node/Electron.
 *
 * Segurança da chave:
 *   - só vai no cabeçalho `Authorization: Bearer …`, para o endereço do provedor escolhido (nunca em URL, corpo, log ou erro);
 *   - nunca por http:// para um servidor que não seja a própria máquina (KEY_INSECURE);
 *   - todo texto de erro passa por `redact`, que tira a chave e qualquer pedaço parecido com uma chave.
 *
 * Para o modo "só gratuitos" do OpenRouter (docs/recursos/openrouter-gratuito.md): `beforeSend(body)` dá a última palavra sobre o corpo que
 * vai sair (conferir o modelo, tirar `models`/`route` pagos), `extraBody` leva campos do provedor, a resposta traz o `model` que de fato
 * respondeu e o erro HTTP traz `responseBody` (já sem a chave) e `responseHeaders` de limite de uso, para explicar a falha com precisão.
 */

const { AiError, cancelled } = require('./errors');
const { isLoopbackHost } = require('./providers');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ERROR_BODY_KEPT = 2000; // quanto do corpo de um erro HTTP fica no erro (já sem a chave), para quem explica a falha ao usuário
const KEPT_RESPONSE_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
// "<id> is not a valid model ID" (o OpenRouter responde HTTP 400, não 404; observado em rede real) e variações: é modelo inválido, como o 404.
// Um 400 que fala de response_format/JSON é outra coisa (a repetição sem JSON depende de continuar BAD_REQUEST).
const INVALID_MODEL_RE = /is not a valid model|invalid model|unknown model|no such model|model[^.]{0,80}(?:does not exist|not found)/i;
const FORMAT_PARAM_RE = /response_format|json_object|json mode|json_schema/i;

/**
 * Tira a chave (e trechos que parecem chaves/tokens) e o identificador da CONTA no provedor (`user_id`/"user_…", que o OpenRouter repete no
 * corpo de alguns erros: observado em rede real) de um texto que pode ir a log, erro ou tela.
 */
function redact(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey && String(apiKey).length >= 6) out = out.split(String(apiKey)).join('•••');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer •••');
  out = out.replace(/\b(?:sk|gsk|AIza|key|or)[-_A-Za-z0-9]{16,}/g, '•••');
  out = out.replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"•••"');
  out = out.replace(/\buser_[A-Za-z0-9]{8,}\b/g, '•••');
  return out;
}

function retryAfterOf(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  const when = Date.parse(text);
  return Number.isFinite(when) ? Math.max(0, Math.round((when - Date.now()) / 1000)) : null;
}

/** Texto curto do erro devolvido pelo servidor (já sem chaves), só para ajudar quem lê a mensagem. */
function serverDetail(body, apiKey) {
  let text = '';
  try {
    const data = JSON.parse(body);
    const e = Array.isArray(data) ? data[0] && data[0].error : data && data.error;
    text = (e && (e.message || (typeof e === 'string' ? e : ''))) || '';
  } catch { text = String(body || '').replace(/\s+/g, ' '); }
  return redact(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Só os cabeçalhos de limite de uso (nunca cookie, autorização ou o que mais vier) como objeto simples. */
function keptHeaders(res) {
  const out = {};
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== 'function') return out;
  for (const name of KEPT_RESPONSE_HEADERS) {
    let value = null;
    try { value = headers.get(name); } catch { value = null; }
    if (value !== null && value !== undefined && String(value).length <= 200) out[name] = String(value);
  }
  return out;
}

/**
 * Erro de uma resposta HTTP de falha. Além do código e da mensagem em português, o erro leva `status`, `retryAfterSec`, `responseBody`
 * (o corpo, ATÉ ~2 mil caracteres e JÁ sem a chave) e `responseHeaders` (só os de limite de uso): quem precisa explicar a falha com
 * precisão (src/core/ai/openrouter/errors.js) lê isso; nada disso vai para a tela nem para eventos.
 */
function httpError(status, res, detail, body) {
  const extra = { status, retryAfterSec: retryAfterOf(res) };
  const withDetail = (msg) => `${msg}${detail ? ` (${detail})` : ''}`;
  let code;
  let message;
  if (status === 401 || status === 403) {
    code = 'AUTH';
    message = withDetail('O provedor recusou a chave de API. Confira se ela está correta e ativa, e tente de novo.');
  } else if (status === 404) {
    code = 'MODEL';
    message = withDetail('O provedor não encontrou o modelo (ou o endereço). Confira o nome do modelo.');
  } else if (status === 400 && INVALID_MODEL_RE.test(detail || '') && !FORMAT_PARAM_RE.test(detail || '')) {
    code = 'MODEL';
    message = withDetail('O provedor não reconhece o modelo (nome errado, removido ou indisponível). Confira o nome do modelo.');
  } else if (status === 429) {
    code = 'RATE_LIMIT';
    message = withDetail('O provedor atingiu o limite de uso (cota ou pedidos por minuto).');
  } else if (status === 408 || status >= 500) {
    code = 'SERVER';
    message = withDetail(`O provedor de IA está com problema (HTTP ${status}).`);
  } else {
    code = 'BAD_REQUEST';
    message = withDetail(`O provedor recusou o pedido (HTTP ${status}).`);
  }
  const err = Object.assign(new AiError(code, message, extra), extra);
  if (typeof body === 'string' && body) err.responseBody = body;
  const headers = keptHeaders(res);
  if (Object.keys(headers).length) err.responseHeaders = headers;
  return err;
}

/**
 * @param {object} o
 * @param {string} o.baseUrl   URL base já normalizada (…/v1)
 * @param {string} [o.apiKey]
 * @param {string} o.model
 * @param {string} [o.system]
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {boolean} [o.jsonMode]    pede `response_format: json_object` (se o servidor recusar, repete sem ele)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.fetchImpl]
 * @param {Set<string>} [o.noJsonMode]  memória de "este servidor/modelo não aceita response_format"
 * @param {object} [o.extraBody]    campos extras do provedor (ex.: preferências do OpenRouter); nunca sobrescrevem model/messages/stream
 * @param {(body:object)=>(object|void)} [o.beforeSend]  última palavra sobre o corpo que VAI SAIR (a cada tentativa, inclusive a repetida sem
 *   response_format): pode lançar (ex.: AiError NOT_FREE: o pedido nem sai) e/ou devolver um corpo substituto (ex.: sem `models` pago)
 * @returns {Promise<{ text:string, usage:{promptTokens:number|null,completionTokens:number|null,cost?:number}, finishReason:string|null, model:string|null }>}
 *   `model` = o campo `model` da resposta: o modelo que de fato respondeu (com o roteador gratuito do OpenRouter, é quem foi sorteado);
 *   `usage.cost` = o custo em US$ que o provedor informou (OpenRouter), quando informou
 */
async function chatCompletion(o) {
  const { baseUrl, apiKey, model, signal } = o;
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (!baseUrl) throw new AiError('NOT_CONFIGURED', 'O provedor de IA não tem endereço configurado.');
  if (!model) throw new AiError('NOT_CONFIGURED', 'Informe o modelo do provedor de IA.');
  if (signal && signal.aborted) throw cancelled();
  let url;
  try { url = new URL(baseUrl); } catch { throw new AiError('NOT_CONFIGURED', 'O endereço do provedor de IA é inválido.'); }
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) {
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw new AiError('KEY_INSECURE', 'Por segurança, a chave não é enviada por http:// a um servidor que não seja o seu computador. Use um endereço https://.');
    }
    headers.authorization = `Bearer ${apiKey}`;
  }
  const memoryKey = `${baseUrl}|${model}`;
  const official = url.hostname === 'api.openai.com';
  const messages = [...(o.system ? [{ role: 'system', content: o.system }] : []), ...o.messages];

  const attempt = async (withJson) => {
    const body = { ...(o.extraBody && typeof o.extraBody === 'object' && !Array.isArray(o.extraBody) ? o.extraBody : {}), model, messages, stream: false };
    if (Number.isFinite(o.maxTokens)) body[official ? 'max_completion_tokens' : 'max_tokens'] = Math.round(o.maxTokens);
    if (Number.isFinite(o.temperature)) body.temperature = o.temperature;
    if (withJson) body.response_format = { type: 'json_object' };
    let payload = body;
    if (typeof o.beforeSend === 'function') {
      const replaced = o.beforeSend(body); // pode lançar: o pedido nem sai
      if (replaced && typeof replaced === 'object') payload = replaced;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, o.timeoutMs || DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      } catch (err) {
        if (signal && signal.aborted) throw cancelled();
        if (timedOut || (err && err.name === 'AbortError')) throw new AiError('TIMEOUT', 'O provedor de IA demorou demais para responder.');
        throw new AiError('NETWORK', 'Não foi possível falar com o provedor de IA. Confira a internet e o endereço do provedor.');
      }
      let text;
      try {
        text = await res.text();
      } catch {
        if (signal && signal.aborted) throw cancelled();
        if (timedOut) throw new AiError('TIMEOUT', 'O provedor de IA demorou demais para responder.');
        throw new AiError('INTERRUPTED', 'A conexão com o provedor de IA caiu no meio da resposta.');
      }
      const keptBody = () => redact(text, apiKey).slice(0, MAX_ERROR_BODY_KEPT);
      if (!res.ok) throw httpError(res.status, res, serverDetail(text, apiKey), keptBody());
      let data;
      try { data = JSON.parse(text); } catch { throw new AiError('BAD_RESPONSE', 'O provedor respondeu algo que não é uma resposta de chat.'); }
      // alguns provedores (o OpenRouter, quando o modelo falha no meio) respondem HTTP 200 com um corpo { error } e sem `choices`: é erro
      if (data && typeof data === 'object' && data.error && !Array.isArray(data.choices)) {
        const code = Number(data.error && typeof data.error === 'object' ? data.error.code : NaN);
        throw httpError(Number.isFinite(code) && code >= 400 && code < 600 ? code : 502, res, serverDetail(text, apiKey), keptBody());
      }
      const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
      const message = choice && choice.message;
      if (!message) throw new AiError('BAD_RESPONSE', 'A resposta do provedor veio sem texto.');
      // só `message.content` vale: modelos que "pensam" mandam o raciocínio em `message.reasoning` (observado em rede real), que NUNCA é lido
      // nem tratado como resposta (o JSON do pedido só pode vir do conteúdo; sem conteúdo e com finish_reason 'length' = resposta cortada)
      const content = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content.map((p) => (p && p.text) || '').join('') : '');
      const usage = data.usage || {};
      return {
        text: content,
        usage: {
          promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
          // no OpenRouter já INCLUI os tokens de raciocínio (usage.completion_tokens_details.reasoning_tokens)
          completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
          // custo em US$ que o OpenRouter informa (0 nos modelos gratuitos); só aparece quando o provedor informa
          ...(Number.isFinite(usage.cost) ? { cost: usage.cost } : {})
        },
        finishReason: choice.finish_reason || null,
        model: typeof data.model === 'string' && data.model ? data.model.slice(0, 200) : null
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };

  const wantJson = o.jsonMode === true && !(o.noJsonMode && o.noJsonMode.has(memoryKey));
  try {
    return await attempt(wantJson);
  } catch (err) {
    // servidor/modelo que não aceita response_format: lembra e repete SEM ele (uma vez)
    if (wantJson && err && err.code === 'BAD_REQUEST' && /response_format|json_object|json mode|json_schema/i.test(String(err.message))) {
      if (o.noJsonMode) o.noJsonMode.add(memoryKey);
      return attempt(false);
    }
    throw err;
  }
}

module.exports = { chatCompletion, redact, retryAfterOf, serverDetail };
