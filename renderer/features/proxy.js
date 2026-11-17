'use strict';

/**
 * Proxy de visualização no player (dono: base; docs/recursos/proxy.md). Quando o Chromium não toca o vídeo original (HEVC sem decodificador
 * na máquina, áudio AC-3/DTS que ele toca mudo, alguns MKV/TS do OBS), o app cria uma cópia LEVE (H.264 até 720p) só para o player e
 * troca o player para ela; o vídeo do projeto, os cortes, a análise e a exportação continuam sendo o ORIGINAL (a cópia tem a mesma duração).
 *
 * Dois gatilhos: (1) ao abrir o vídeo, se o codec dele é um que o Chromium não toca (`needed`); (2) o erro do player (BF.player.onUnplayable).
 * Só uma cópia por vez; abrir outro vídeo cancela a anterior (no processo principal). Eventos: proxy:progress, proxy:done, proxy:failed.
 */
(function () {
  const BF = window.BF;

  // áudio que o Chromium não decodifica: ele toca o vídeo, mudo, sem dar erro
  const UNSUPPORTED_AUDIO = ['ac3', 'eac3', 'dts', 'truehd', 'mlp', 'dca'];
  const HEVC_PROBE = 'video/mp4; codecs="hvc1.1.6.L93.B0"';

  const state = { path: null, using: false, running: false, p: 0, failedFor: null };

  /** O vídeo (info do ffprobe: videoCodec, audioCodec) precisa de proxy? `canPlayType` é o do elemento <video>. */
  function needed(info, canPlayType) {
    if (!info) return false;
    if (UNSUPPORTED_AUDIO.includes(String(info.audioCodec || '').toLowerCase())) return true;
    const v = String(info.videoCodec || '').toLowerCase();
    if (v === 'hevc' || v === 'h265') return typeof canPlayType === 'function' ? canPlayType(HEVC_PROBE) === '' : false;
    return false;
  }

  const sourcePath = () => (BF.state.project && BF.state.project.source ? BF.state.project.source.path : null);

  function etaText(sec) {
    if (!Number.isFinite(sec) || sec < 10) return '';
    return sec < 90 ? ` · cerca de ${Math.round(sec / 10) * 10} s restantes` : ` · cerca de ${Math.round(sec / 60)} min restantes`;
  }

  /** Troca o player para a cópia leve, no mesmo instante em que o vídeo estava. */
  function useProxy(url) {
    const video = BF.player.video;
    const at = BF.player.time();
    const wasPlaying = video && !video.paused;
    BF.player.load(url);
    if (video) {
      video.addEventListener('loadedmetadata', () => {
        if (at > 0) BF.player.seek(at);
        if (wasPlaying && typeof video.play === 'function') { const started = video.play(); if (started && typeof started.catch === 'function') started.catch(() => {}); }
      }, { once: true });
    }
    state.using = true;
    state.running = false;
    BF.bus.emit('player:proxy', { using: true });
    BF.ui.toast('O player agora usa uma cópia leve do vídeo, só para visualizar. Os cortes e a exportação continuam usando o vídeo original.', '', 9000);
    BF.ui.log('Player com cópia leve do vídeo (a exportação usa o original).', 'ok');
  }

  /** Pede a cópia ao processo principal. Devolve true se o assunto está tratado (o chamador não precisa avisar mais nada). */
  async function start(reason) {
    const file = sourcePath();
    if (!file || state.using) return false;
    if (state.failedFor === file) return false; // já falhou para este vídeo: a mensagem do player (e a do erro) já valem
    state.path = file;
    const res = await BF.api('proxy:ensure', { path: file });
    if (sourcePath() !== file) return true; // trocou de vídeo no meio
    if (!res.ok) {
      state.failedFor = file;
      state.running = false;
      BF.ui.toast(`${res.message || 'Não foi possível criar a cópia leve.'} ${BF.player.unplayableMessage || ''}`.trim(), 'error', 12000);
      return true;
    }
    if (res.state === 'ready') { useProxy(res.url); return true; }
    state.running = true;
    state.p = 0;
    BF.ui.toast(reason === 'error'
      ? 'Este vídeo não toca no player do app. Estou criando uma cópia leve só para visualizar; o corte e a exportação continuam usando o original.'
      : 'Este vídeo usa um formato que o player do app não toca direito. Estou criando uma cópia leve só para visualizar; o corte e a exportação continuam usando o original.', '', 10000);
    BF.ui.log('Criando a cópia leve do vídeo para o player… 0%', 'warn');
    return true;
  }

  // o erro do player (app.js chama): começa a cópia em vez de só avisar que não toca
  BF.player.onUnplayable = () => {
    if (state.using || state.failedFor === sourcePath() || !sourcePath()) return false;
    if (state.running) return true;
    start('error');
    return true;
  };

  BF.on('proxy:progress', ({ path: file, p, etaSec } = {}) => {
    if (file !== sourcePath() || !state.running) return;
    state.p = p;
    BF.ui.log(`Criando a cópia leve do vídeo para o player… ${Math.round((p || 0) * 100)}%${etaText(etaSec)}`, 'warn');
  });
  BF.on('proxy:done', ({ path: file, url } = {}) => {
    if (file !== sourcePath()) return;
    useProxy(url);
  });
  BF.on('proxy:failed', ({ path: file, message } = {}) => {
    if (file !== sourcePath()) return;
    state.running = false;
    state.failedFor = file;
    BF.ui.toast(`${message || 'Não foi possível criar a cópia leve.'} ${BF.player.unplayableMessage || ''}`.trim(), 'error', 12000);
  });

  // outro vídeo: a cópia do anterior não vale mais (o processo principal cancela a que ainda roda); decide se este já precisa da sua
  BF.bus.on('project:loaded', () => {
    if (state.running) BF.api('proxy:cancel', {});
    state.using = false;
    state.running = false;
    state.p = 0;
    state.path = sourcePath();
    if (needed(BF.state.info, BF.player.video && typeof BF.player.video.canPlayType === 'function' ? (t) => BF.player.video.canPlayType(t) : null)) start('codec');
  });

  BF.proxy = { state, needed, start, useProxy, UNSUPPORTED_AUDIO };
})();
