'use strict';

/**
 * Aviso de versão nova (dono: base; docs/atualizacao.md). SÓ AVISA: consulta a última Release publicada no GitHub do projeto, compara com a versão
 * instalada e devolve o endereço da página da Release. Não baixa nem instala nada: quem instala é o usuário, por cima, e os projetos continuam.
 *
 * Privacidade: uma chamada GET a api.github.com sem corpo, só com o nome e a versão do app no User-Agent (nada do usuário, do computador nem dos
 * projetos). O renderer a faz ao abrir (se o usuário não desligou) e quando ele clica em "Verificar agora".
 *
 * Nunca lança: qualquer falha (sem rede, prazo, limite do GitHub, resposta estranha) vira `{ status: 'error', ... }` e o app segue como estava.
 */

const API = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 8000;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const INSTALLER_RE = /^braga-frame-\d+\.\d+\.\d+-windows-x64-setup\.exe$/;

/** "v1.2.3" ou "1.2.3" -> [1, 2, 3]; qualquer outra coisa (pré-lançamento, "1.2", texto) -> null. */
function parseVersion(text) {
  const m = VERSION_RE.exec(String(text === undefined || text === null ? '' : text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 ou 1; null se alguma das duas não é X.Y.Z. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** A URL é uma página de Releases do repositório (https, github.com, /<dono>/<repo>/releases…)? É a única que o app abre no navegador. */
function isReleaseUrl(url, repo) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  const base = `/${String(repo).toLowerCase()}/releases`;
  const path = u.pathname.toLowerCase();
  return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port && (path === base || path.startsWith(`${base}/`));
}

/**
 * O endereço de DOWNLOAD de um arquivo da Release é o esperado? https://github.com/<repo>/releases/download/<tag>/<nome>, sem usuário nem porta. `origin` (só no
 * modo de teste) é a origem do servidor local que faz o papel do GitHub: ali o caminho é o mesmo, a origem é a dele.
 */
function isAssetUrl(url, { repo, tag, name, origin = null } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.username || u.password) return false;
  const expected = `/${String(repo).toLowerCase()}/releases/download/${encodeURIComponent(String(tag)).toLowerCase()}/${encodeURIComponent(String(name)).toLowerCase()}`;
  if (u.pathname.toLowerCase() !== expected) return false;
  if (origin) return u.origin === origin;
  return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port;
}

/**
 * O instalador da Release, pronto para baixar e conferir: { name, url, size, sha256 } ou null. Só vale com o nome no padrão da versão da tag
 * (braga-frame-<versão>-windows-x64-setup.exe), tamanho inteiro, o `digest` sha256 que o GitHub calcula do arquivo e o endereço de download do próprio
 * repositório. Sem o digest não há como conferir o arquivo: então não há instalador baixável (o aviso continua funcionando).
 */
function pickInstaller(json, repo, version, { origin = null } = {}) {
  if (!json || !Array.isArray(json.assets)) return null;
  const tag = String(json.tag_name).trim();
  const want = `braga-frame-${version}-windows-x64-setup.exe`;
  const a = json.assets.find((x) => x && x.name === want && INSTALLER_RE.test(String(x.name)));
  if (!a || !Number.isSafeInteger(a.size) || a.size <= 0) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
  if (!m) return null;
  if (!isAssetUrl(a.browser_download_url, { repo, tag, name: a.name, origin })) return null;
  // `href`: o endereço JÁ normalizado ("..", maiúsculas…), o mesmo que isAssetUrl conferiu e que o fetch vai pedir
  return { name: a.name, url: new URL(String(a.browser_download_url)).href, size: a.size, sha256: m[1].toLowerCase() };
}

/**
 * Release da API do GitHub -> { version, tag, url, publishedAt, sizeBytes, asset } ou null (rascunho, pré-lançamento, tag que não é X.Y.Z).
 * `url` é a da própria Release se for do repositório; senão monta a da tag (nunca confia num endereço de fora). `asset`: veja pickInstaller (ou null).
 */
function parseRelease(json, repo, opts = {}) {
  if (!json || typeof json !== 'object' || json.draft === true || json.prerelease === true) return null;
  const parts = parseVersion(json.tag_name);
  if (!parts) return null;
  const tag = String(json.tag_name).trim();
  const url = isReleaseUrl(json.html_url, repo) ? String(json.html_url) : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  const installer = Array.isArray(json.assets) ? json.assets.find((a) => a && INSTALLER_RE.test(String(a.name))) : null;
  const version = parts.join('.');
  return {
    version,
    tag,
    url,
    publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
    sizeBytes: installer && Number.isSafeInteger(installer.size) && installer.size > 0 ? installer.size : null,
    asset: pickInstaller(json, repo, version, opts)
  };
}

/**
 * Modo de teste: NODE_ENV=test E app não empacotado (em produção, nunca). Nele o e2e troca o endereço do GitHub por um servidor local e o app NÃO abre o
 * navegador de verdade (app:updateOpen só devolve o endereço).
 *
 * Base da API: a do GitHub; só no modo de teste e só em loopback vale BF_TEST_UPDATE_API. Em produção a variável é ignorada por completo.
 */
function testMode(env, isPackaged) {
  return Boolean(env) && env.NODE_ENV === 'test' && isPackaged === false;
}

function apiBase(env = process.env, isPackaged = true) {
  const raw = env && env.BF_TEST_UPDATE_API;
  if (typeof raw === 'string' && raw && testMode(env, isPackaged)) {
    try {
      const u = new URL(raw);
      if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.origin;
    } catch { /* inválida: ignora */ }
  }
  return API;
}

const ERRORS = Object.freeze({
  network: 'Não consegui verificar agora: sem conexão ou o GitHub não respondeu. Tente de novo mais tarde.',
  timeout: 'Não consegui verificar agora: o GitHub demorou demais para responder. Tente de novo mais tarde.',
  rate: 'O GitHub recusou a consulta por excesso de pedidos. Tente de novo daqui a alguns minutos.',
  http: 'Não consegui verificar agora: o GitHub respondeu com um erro. Tente de novo mais tarde.',
  format: 'Não consegui verificar agora: a resposta do GitHub veio num formato inesperado.'
});

/**
 * @param {{ currentVersion: string, repo: string, fetchImpl?: Function, timeoutMs?: number, base?: string, now?: () => Date }} o
 * @returns {Promise<{ status: 'available'|'current'|'none'|'error', current: string, checkedAt: string, latest?: object, url?: string, reason?: string, message?: string }>}
 *   available: há versão mais nova (latest, url); current: já está na mais nova; none: o projeto ainda não publicou nenhuma versão X.Y.Z;
 *   error: não deu para saber (reason: network | timeout | rate | http | format; message em português).
 */
async function checkForUpdate({ currentVersion, repo, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, base = API, now = () => new Date() } = {}) {
  const origin = base === API ? null : base; // só o modo de teste troca a base (apiBase): o download vem dessa mesma origem
  const out = { current: String(currentVersion), checkedAt: now().toISOString() };
  const fail = (reason) => ({ ...out, status: 'error', reason, message: ERRORS[reason] });
  if (typeof fetchImpl !== 'function') return fail('network');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `BragaFrame/${out.current} (verificacao-de-versao)` }
    });
    if (res.status === 404) return { ...out, status: 'none' }; // repositório sem nenhuma Release publicada
    if (res.status === 403 || res.status === 429) return fail('rate');
    if (!res.ok) return fail('http');
    let json;
    try { json = await res.json(); } catch { return fail('format'); }
    const release = parseRelease(json, repo, { origin });
    if (!release) return { ...out, status: 'none' }; // a última é rascunho, pré-lançamento ou tem tag fora do padrão X.Y.Z
    const cmp = compareVersions(release.version, currentVersion);
    if (cmp === null) return fail('format');
    return cmp > 0 ? { ...out, status: 'available', latest: release, url: release.url } : { ...out, status: 'current', latest: release };
  } catch (err) {
    return fail(err && err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isAssetUrl, pickInstaller, testMode, API, DEFAULT_TIMEOUT_MS, ERRORS, parseVersion, compareVersions, isReleaseUrl, parseRelease, apiBase, checkForUpdate };
