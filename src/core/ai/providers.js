'use strict';

/**
 * Provedores de IA conhecidos. Todos falam o protocolo `chat/completions` compatível com a OpenAI (um cliente só, client.js).
 * NENHUM provedor é pré-selecionado: quem escolhe o provedor e o modelo é o USUÁRIO (decisão do dono, docs/recursos/analise-ia.md, seção 15).
 * Única exceção, também decisão do dono (23/10/2026): escolhido o OpenRouter, o modelo começa no ROTEADOR GRATUITO (`openrouter/free`) até o usuário
 * escolher outro (runtime.js, `_providerOf`).
 * O endereço de cada um vem daqui (só o "Personalizado" aceita outro endereço); `suggestedModel` é apenas uma SUGESTÃO mostrada ao
 * escolher o modelo (o campo começa vazio: a oferta dos provedores muda). Os endereços são os documentados pelos próprios provedores;
 * não foram exercitados em rede real (veja docs/recursos/analise-ia.md, "Não verificado").
 *
 * `privacy` é uma frase CAUTELOSA (diz "pode"), mostrada no aviso antes do primeiro envio; não substitui os termos do plano do usuário.
 */
const PRESETS = Object.freeze([
  {
    id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', suggestedModel: 'gemini-3.8-flash', // 16/11/2026: o 2.5 Flash não aceita mais chaves novas (a própria API indica o 3.8 Flash); a lista do provedor confirma
    keyHint: 'Chave criada no Google AI Studio.',
    privacy: 'No plano gratuito do Google, o conteúdo enviado pode ser usado para melhorar os produtos deles.'
  },
  {
    id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', suggestedModel: 'llama-3.3-70b-versatile',
    keyHint: 'Chave criada no console da Groq.',
    privacy: 'Confira os termos da Groq para o seu plano; planos gratuitos têm limites de uso por minuto.'
  },
  {
    // `freeCapable`: tem lista de modelos ao vivo e o modo "Usar apenas modelos gratuitos" (ligado por padrão, garantido no código:
    // src/core/ai/openrouter, docs/recursos/openrouter-gratuito.md). `suggestedModel` é só a dica do campo e NUNCA um modelo pago.
    id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', suggestedModel: 'openrouter/free', freeCapable: true,
    keyHint: 'Chave criada no painel do OpenRouter.',
    privacy: 'O OpenRouter repassa o pedido ao provedor do modelo escolhido, e cada provedor tem a sua política de dados.'
  },
  {
    id: 'custom', label: 'Personalizado', baseUrl: '', suggestedModel: '',
    keyHint: 'Qualquer servidor compatível com a API de chat da OpenAI.',
    privacy: 'O conteúdo vai para o servidor que você informou; confira quem o opera e os termos dele.'
  }
]);

const byId = (id) => PRESETS.find((p) => p.id === id) || null;

/** URL base: http(s), sem usuário/senha, sem barra final. Lança Error com mensagem em português. */
function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new Error('Endereço do servidor inválido. Use algo como https://servidor/v1.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('O endereço do servidor deve começar com https:// (ou http:// para um servidor no seu computador ou na sua rede local).');
  if (url.username || url.password) throw new Error('O endereço não deve conter usuário ou senha.');
  if (url.search || url.hash) throw new Error('O endereço não deve ter parâmetros (?…) nem âncora (#…).');
  return url.origin + (url.pathname.replace(/\/+$/, '') || '');
}

/** Servidor na própria máquina: a chave pode ir por http:// e o aviso de nuvem não se aplica. */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
}

/**
 * Servidor na REDE LOCAL do usuário (decisão do dono, 16/11/2026: um gateway próprio em outra máquina da casa). Vale para:
 *   - endereço IP privado: 10.x, 172.16 a 172.31.x, 192.168.x, 169.254.x (enlace), 100.64 a 100.127.x (faixa das VPNs de malha), e no
 *     IPv6 fc00::/7 (rede privada) e fe80::/10 (enlace);
 *   - nome que só a rede local resolve: sem ponto, ou terminado em .local, .lan ou .home.arpa.
 * A chave pode ir por http:// para lá, mas SEM criptografia: o estado do provedor marca `localNetwork` e a tela avisa.
 * É uma conferência pelo TEXTO do endereço (o `URL` já normaliza as formas de escrever um IP); não consulta o DNS.
 */
function isLocalNetworkHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || isLoopbackHost(h)) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return false;
    const [a, b] = n;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h)) return true; // nome sem ponto
  return /^[a-z0-9.-]+\.(local|lan|home\.arpa)$/.test(h);
}

/** A chave pode ir por http:// para este endereço? Só para a própria máquina ou a rede local; para qualquer outro, só https://. */
const keyOverHttpAllowed = (hostname) => isLoopbackHost(hostname) || isLocalNetworkHost(hostname);

/** Frase mostrada (no aviso de privacidade e abaixo do endereço) quando o servidor é http:// na rede local. */
const LOCAL_NETWORK_NOTE = 'Este endereço usa http:// na rede local: a chave e o conteúdo vão sem criptografia. Use só numa rede em que você confia.';

const originOf = (url) => { try { return new URL(String(url)).origin.toLowerCase(); } catch { return ''; } };
const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return ''; } };

module.exports = { PRESETS, byId, normalizeBaseUrl, isLoopbackHost, isLocalNetworkHost, keyOverHttpAllowed, LOCAL_NETWORK_NOTE, originOf, hostOf };
