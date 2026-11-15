'use strict';

/**
 * Traduz a saída de erro do yt-dlp (e do TwitchDownloaderCLI) em mensagens em português com CAUSA e SOLUÇÃO
 * (dono: sources). Os padrões vêm de saídas reais (YouTube e Twitch, 2026) e de mensagens documentadas do yt-dlp.
 * Regra do produto: o que depende de acesso, permissão ou disponibilidade da fonte é dito como tal
 * (`dependsOnAccess`) e nunca vira "erro do app".
 *
 *   mapYtdlpError(stderr, { exitCode, platform, usedCookies, hasJsRuntime }) -> {
 *     code, message (causa + solução), cause, solution, dependsOnAccess, retryable, raw }
 *   mapTwitchDownloaderError(text, exitCode) -> mesmo formato
 *   warningsFromStderr(stderr, { platform, hasJsRuntime }) -> [{ code, message }]   (avisos que não impedem)
 *
 * `raw` = trecho curto do erro original, sem caminhos do computador (serve para pedir ajuda; nunca é a única explicação).
 */

const MAX_RAW = 280;

/** Remove caminhos locais e o nome do usuário do Windows de um texto. */
function stripLocalPaths(text) {
  return String(text || '')
    .replace(/(?:[a-zA-Z]:\\|\\\\)[^\s"'<>|]*/g, '<caminho>')
    .replace(/(?:^|(?<=[\s"'(]))\/(?:home|Users|tmp|var|opt|root)\/[^\s"'<>|]*/g, '<caminho>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Linhas "ERROR: ..." do stderr, sem o prefixo, na ordem em que apareceram. */
function errorLines(stderr) {
  const out = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const m = /^\s*ERROR:\s*(.*)$/i.exec(line);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

function shortRaw(lines) {
  const text = stripLocalPaths(lines.join(' | '));
  return text.length > MAX_RAW ? `…${text.slice(-MAX_RAW)}` : text;
}

const ASK_COOKIES = 'Em Avançado, ligue "Usar cookies do navegador" e escolha o navegador em que você está logado.';

/** [regex, builder(ctx) -> { code, cause, solution, dependsOnAccess, retryable }] — o primeiro que casar vale. */
const RULES = [
  [/could not find .+ cookies database|could not copy .*cookie|failed to decrypt|dpapi|cannot decrypt|unable to .*cookies? from browser|failed to load cookies|cookies? from browser/i,
    () => ({
      code: 'COOKIES_BROWSER',
      cause: 'Não foi possível ler os cookies do navegador escolhido (ele pode estar aberto, não ter perfil ou bloquear o acesso).',
      solution: 'Feche o navegador por completo e tente de novo, escolha outro (o Firefox costuma funcionar melhor) ou desligue a opção em Avançado.',
      dependsOnAccess: false, retryable: true
    })],
  [/unsupported browser specified for cookies/i,
    () => ({ code: 'COOKIES_BROWSER', cause: 'O navegador escolhido para os cookies não é suportado.', solution: 'Escolha outro navegador em Avançado.', dependsOnAccess: false, retryable: false })],
  [/confirm (?:that )?you.{0,3}re not a bot/i,
    (c) => ({
      code: 'BOT_CHECK',
      cause: 'O YouTube pediu para confirmar que você não é um robô (isso depende da sua rede e do momento; não é um defeito do vídeo).',
      solution: c.usedCookies ? 'Tente de novo mais tarde; entrar de novo no YouTube no navegador escolhido também ajuda.' : `Tente de novo em alguns minutos. Se continuar: ${ASK_COOKIES}`,
      dependsOnAccess: true, retryable: true
    })],
  [/confirm your age|age[- ]restricted|inappropriate for some users|age verification/i,
    (c) => ({
      code: 'AGE_RESTRICTED',
      cause: 'O vídeo tem restrição de idade: o YouTube só mostra para uma conta logada e maior de idade.',
      solution: c.usedCookies ? 'Confira se o navegador escolhido está logado no YouTube com uma conta que pode ver o vídeo.' : ASK_COOKIES,
      dependsOnAccess: true, retryable: false
    })],
  [/private video|video is private|this video is private/i,
    () => ({
      code: 'PRIVATE',
      cause: 'O vídeo é privado: só o dono (ou quem recebeu acesso) consegue ver.',
      solution: `Peça acesso ao dono. Se a sua conta já tem acesso: ${ASK_COOKIES}`,
      dependsOnAccess: true, retryable: false
    })],
  [/members[- ]only|join this channel|channel'?s members|members-only|available to this channel/i,
    () => ({
      code: 'MEMBERS_ONLY',
      cause: 'O vídeo é só para membros do canal.',
      solution: `Se a sua conta é membro: ${ASK_COOKIES}`,
      dependsOnAccess: true, retryable: false
    })],
  [/subscriber|subs[- ]only|only available for (?:sub|follower)|sub-only/i,
    (c) => ({
      code: 'SUBSCRIBERS_ONLY',
      cause: `O vídeo é só para ${c.platform === 'twitch' ? 'inscritos (subs) do canal' : 'inscritos'}.`,
      solution: `Se a sua conta é inscrita: ${ASK_COOKIES}`,
      dependsOnAccess: true, retryable: false
    })],
  [/not available in your country|blocked it in your country|geo[- ]?restrict|available in your location|uploader has not made this video available|not made this video available in your/i,
    () => ({
      code: 'GEO_BLOCKED',
      cause: 'O vídeo não está liberado para a sua região.',
      solution: 'Não há como contornar por aqui. Peça ao dono do canal o arquivo ou outro link.',
      dependsOnAccess: true, retryable: false
    })],
  [/live event will begin|premieres in|this live event|upcoming/i,
    () => ({
      code: 'NOT_STARTED',
      cause: 'A transmissão ainda não começou (ou é uma estreia agendada).',
      solution: 'Volte depois que a live terminar e o vídeo estiver disponível.',
      dependsOnAccess: true, retryable: false
    })],
  [/does not exist|video unavailable|this video is unavailable|this video is not available|has been removed|no longer available|been deleted|account associated with this video has been terminated|copyright claim|video .* is unavailable|http error 404|expired/i,
    (c) => ({
      code: 'UNAVAILABLE',
      cause: c.platform === 'twitch'
        ? 'Esse VOD não existe mais ou o link está errado (a Twitch apaga VODs depois de alguns dias).'
        : 'O vídeo foi removido, está indisponível ou o link está errado.',
      solution: 'Confira o link. Se o vídeo ainda abre no navegador, tente de novo; se não abre, o dono apagou ou limitou o acesso.',
      dependsOnAccess: true, retryable: false
    })],
  [/n challenge solving failed|signature solving failed|javascript runtime|js runtime|ejs/i,
    () => ({
      code: 'NO_JS_RUNTIME',
      cause: 'O YouTube exigiu um ambiente JavaScript para liberar o vídeo e ele não está disponível.',
      solution: 'Instale o Deno na aba Ferramentas e tente de novo.',
      dependsOnAccess: false, retryable: false
    })],
  [/requested format is not available|no video formats found|only images are available/i,
    (c) => ({
      code: 'NO_FORMAT',
      cause: c.platform === 'youtube' && c.hasJsRuntime === false
        ? 'O YouTube não liberou nenhuma qualidade. Sem o Deno instalado isso é comum.'
        : 'Não há essa qualidade para este vídeo (ou a fonte não liberou nenhuma agora).',
      solution: c.platform === 'youtube' && c.hasJsRuntime === false
        ? 'Instale o Deno na aba Ferramentas e tente de novo; ou escolha outra qualidade.'
        : 'Escolha outra qualidade ou tente de novo daqui a pouco.',
      dependsOnAccess: true, retryable: true
    })],
  [/unsupported url/i,
    () => ({ code: 'UNSUPPORTED_URL', cause: 'Esse link não é de um vídeo que o app consiga baixar.', solution: 'Cole o link de um vídeo do YouTube ou de um VOD da Twitch.', dependsOnAccess: false, retryable: false })],
  [/http error 401|unauthorized|login required|requires login|authentication required|sign in/i,
    (c) => ({
      code: 'LOGIN_REQUIRED',
      cause: `${c.platform === 'twitch' ? 'A Twitch' : 'A fonte'} exige que você esteja logado para ver este vídeo.`,
      solution: ASK_COOKIES,
      dependsOnAccess: true, retryable: false
    })],
  [/http error 403|403: forbidden|error 403/i,
    (c) => c.outdatedYtdlp ? ({
      code: 'FORBIDDEN',
      cause: `O YouTube recusou o download (HTTP 403). O yt-dlp deste computador (versão ${c.outdatedYtdlp.version}, de ${c.outdatedYtdlp.ageDays} dias atrás) está desatualizado, e essa é a causa mais comum: o YouTube muda com frequência e versões antigas passam a ser recusadas.`,
      solution: c.outdatedYtdlp.hostName
        ? `Atualize o yt-dlp pelo ${c.outdatedYtdlp.hostName} (ele é o dono dessa ferramenta; o Braga Frame não guarda outra cópia) e tente de novo.`
        : 'Abra a aba Ferramentas, instale o yt-dlp oficial (mais recente) e tente de novo.',
      dependsOnAccess: true, retryable: true
    }) : ({
      code: 'FORBIDDEN',
      cause: 'O servidor recusou o download (HTTP 403): o endereço do vídeo expirou ou a fonte bloqueou este computador por um tempo.',
      solution: c.usedCookies ? 'Tente de novo; se continuar, aguarde alguns minutos.' : `Tente de novo (o download continua de onde parou). Se continuar: ${ASK_COOKIES}`,
      dependsOnAccess: true, retryable: true
    })],
  [/http error 429|too many requests|rate[- ]limit/i,
    () => ({ code: 'RATE_LIMITED', cause: 'A fonte limitou os pedidos deste computador (HTTP 429).', solution: 'Espere alguns minutos e tente de novo; o download continua de onde parou.', dependsOnAccess: true, retryable: true })],
  [/no space left on device|errno 28|not enough space|disk full|espaço insuficiente/i,
    () => ({ code: 'DISK_FULL', cause: 'Acabou o espaço em disco na pasta de destino.', solution: 'Libere espaço ou escolha outra pasta em "Salvar em"; o que já foi baixado fica guardado para continuar.', dependsOnAccess: false, retryable: false })],
  [/permission denied|errno 13|access is denied|winerror 5\b|read-only file system/i,
    () => ({ code: 'PERMISSION', cause: 'O app não tem permissão para gravar nessa pasta (ou um antivírus/outro programa a bloqueou).', solution: 'Escolha outra pasta em "Salvar em" (por exemplo, dentro de Vídeos).', dependsOnAccess: false, retryable: false })],
  [/ffmpeg.*(?:not found|not installed|no such file)|ffprobe and ffmpeg not found|ffmpeg is not installed|avconv/i,
    () => ({ code: 'NO_FFMPEG', cause: 'O FFmpeg não foi encontrado: ele junta o vídeo e o áudio baixados.', solution: 'Instale o FFmpeg (veja a aba Ferramentas) e use "Verificar de novo".', dependsOnAccess: false, retryable: false })],
  [/postprocessing|conversion failed|error opening output|invalid data found when processing input/i,
    () => ({ code: 'MERGE_FAILED', cause: 'O download terminou, mas o FFmpeg não conseguiu juntar vídeo e áudio.', solution: 'Tente de novo (os pedaços baixados são reaproveitados). Se repetir, escolha outra qualidade.', dependsOnAccess: false, retryable: true })],
  [/filename too long|file name too long|winerror 206|errno 36/i,
    () => ({ code: 'PATH_TOO_LONG', cause: 'O caminho da pasta de destino é longo demais para o Windows.', solution: 'Escolha uma pasta mais curta em "Salvar em" (por exemplo, C:\\Vídeos).', dependsOnAccess: false, retryable: false })],
  [/unable to download|getaddrinfo|failed to resolve|name or service not known|name resolution|connection (?:reset|refused|aborted)|timed out|timeout|network is unreachable|temporary failure|errno 1100[0-9]|winerror 100[0-9]{2}|ssl|proxy|remote end closed|incomplete ?read|read error|connection error|transporterror/i,
    () => ({ code: 'NETWORK', cause: 'Sem conexão com o servidor (a internet caiu, o endereço não abriu ou há um proxy/antivírus no caminho).', solution: 'Confira a internet e tente de novo; o download continua de onde parou.', dependsOnAccess: false, retryable: true })]
];

/**
 * @param {string} stderr saída de erro completa do yt-dlp
 * @param {{ exitCode?:number|null, platform?:string, usedCookies?:boolean, hasJsRuntime?:boolean }} [ctx]
 */
function mapYtdlpError(stderr, ctx = {}) {
  const lines = errorLines(stderr);
  // só as linhas "ERROR:" explicam a falha; os WARNING de nova tentativa (proxy, DNS) são ruído
  const haystack = lines.length ? lines.join('\n') : String(stderr || '');
  for (const [regex, build] of RULES) {
    if (regex.test(haystack)) {
      const r = build(ctx);
      return { ...r, message: `${r.cause} ${r.solution}`, raw: shortRaw(lines.length ? lines : [haystack]) };
    }
  }
  const raw = shortRaw(lines.length ? lines : [haystack]);
  const cause = lines.length
    ? 'O download falhou por um motivo que o app não reconhece.'
    : `O yt-dlp terminou sem sucesso${ctx.exitCode !== undefined && ctx.exitCode !== null ? ` (código ${ctx.exitCode})` : ''} e sem dizer o motivo.`;
  const solution = 'Tente de novo; se repetir, confira se o vídeo abre no navegador e se o yt-dlp está atualizado (aba Ferramentas).';
  return { code: 'YTDLP_FAILED', cause, solution, message: `${cause} ${solution}${raw ? ` Detalhe: ${raw}` : ''}`, dependsOnAccess: false, retryable: true, raw };
}

/** Saída do TwitchDownloaderCLI (erros reais: "Invalid VOD, deleted/expired VOD possibly?"). */
function mapTwitchDownloaderError(text, exitCode) {
  const body = String(text || '');
  const first = (body.split(/\r?\n/).find((l) => /exception|error|invalid|unable|fail/i.test(l)) || body.split(/\r?\n/).find(Boolean) || '').trim();
  const raw = shortRaw([first]);
  let r;
  if (/invalid vod|deleted\/expired|vod .*not found|expired/i.test(body)) {
    r = { code: 'CHAT_VOD_GONE', cause: 'A Twitch não tem mais esse VOD (apagado ou expirado), então o chat também não pode ser baixado.', solution: 'Só é possível baixar o chat de VODs que ainda existem no site.', dependsOnAccess: true, retryable: false };
  } else if (/no space left|not enough space|disk full/i.test(body)) {
    r = { code: 'DISK_FULL', cause: 'Acabou o espaço em disco para guardar o chat.', solution: 'Libere espaço e tente de novo.', dependsOnAccess: false, retryable: false };
  } else if (/unable to connect|no such host|socket|timed out|timeout|connection|network|httprequest|ssl/i.test(body)) {
    r = { code: 'NETWORK', cause: 'Sem conexão com a Twitch para baixar o chat.', solution: 'Confira a internet e tente de novo.', dependsOnAccess: false, retryable: true };
  } else if (/unauthorized|forbidden|401|403|subscriber/i.test(body)) {
    r = { code: 'FORBIDDEN', cause: 'A Twitch não liberou o chat deste VOD (ele pode ser só para inscritos).', solution: 'O chat de VODs restritos não pode ser baixado por aqui.', dependsOnAccess: true, retryable: false };
  } else {
    r = {
      code: 'CHAT_FAILED',
      cause: 'O TwitchDownloaderCLI não conseguiu baixar o chat.',
      solution: 'Tente de novo; se repetir, o chat pode estar desativado neste VOD.',
      dependsOnAccess: true, retryable: true
    };
  }
  const exit = exitCode !== undefined && exitCode !== null && !r.raw ? ` (código ${exitCode})` : '';
  return { ...r, message: `${r.cause} ${r.solution}${exit}`, raw };
}

/** Avisos (WARNING) do yt-dlp que merecem aparecer para o usuário sem impedir nada. */
function warningsFromStderr(stderr, { platform, hasJsRuntime } = {}) {
  const out = [];
  const text = String(stderr || '');
  if (platform !== 'twitch' && hasJsRuntime !== true && /no supported javascript runtime|without a js runtime|js runtime/i.test(text)) {
    out.push({ code: 'NO_JS_RUNTIME', message: 'Sem o Deno o YouTube pode esconder algumas qualidades. Instale o Deno na aba Ferramentas para ver todas.' });
  }
  if (/po token|gvs po token/i.test(text)) {
    out.push({ code: 'PO_TOKEN', message: 'O YouTube pediu uma verificação extra em alguns formatos; algumas qualidades podem não aparecer.' });
  }
  return out;
}

module.exports = { mapYtdlpError, mapTwitchDownloaderError, warningsFromStderr, stripLocalPaths, errorLines, RULES };
