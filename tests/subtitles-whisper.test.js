'use strict';

/**
 * Teste REAL do whisper: instala o motor OFICIAL (release b5130 do GitHub, pela entrada src/core/tools/entries/whisper.js
 * e o ToolInstaller) e o modelo tiny (Hugging Face, tamanho e SHA-256 lidos da fonte) numa pasta temporária, gera fala
 * sintetizada pelo Windows (System.Speech) e confere:
 *   - a fala é transcrita e os tempos das falas ficam relativos ao início do corte;
 *   - silêncio, ruído e vídeo sem áudio resultam em "nenhuma fala detectada" (nada é inventado);
 *   - progresso, cancelamento (sem processo nem pasta sobrando) e o registro de uso da ferramenta.
 * Precisa de internet para instalar (~40 MB). Sem rede o teste é PULADO com o motivo explicado (BF_REQUIRE_NETWORK=1 faz falhar);
 * BF_SKIP_NETWORK_TESTS=1 pula sem tentar baixar nada.
 * BF_SUBTITLES_TEST_CACHE=<pasta> reaproveita um motor/modelo já instalados (só para acelerar o desenvolvimento).
 * Tudo o que ele baixa vai para a pasta temporária e é apagado no fim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./subtitles-helpers');
const { createContext } = require('../src/ipc/context');
const { generateSubtitles } = require('../src/core/subtitles/generate');
const S = require('../src/core/subtitles/shared');

const REQUIRE_NET = process.env.BF_REQUIRE_NETWORK === '1';
const CACHE = process.env.BF_SUBTITLES_TEST_CACHE || '';
const NETWORK_CODES = new Set(['NETWORK', 'TIMEOUT', 'INCOMPLETE', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'HTTP_429']);

const norm = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
const whisperProcesses = () => {
  try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq whisper-cli.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).split('\n').filter((l) => /whisper-cli/i.test(l)).length; } catch { return 0; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  throw new Error('tempo esgotado');
}

test('whisper REAL: motor oficial + modelo tiny, fala sintetizada e nada inventado', { timeout: 600000, skip: process.env.BF_SKIP_NETWORK_TESTS === '1' ? 'BF_SKIP_NETWORK_TESTS=1 (não baixa o motor nem o modelo)' : (H.tools.ffmpeg ? false : 'ffmpeg não encontrado') }, async (t) => {
  const releaseLock = await H.acquireWhisperLock(); // não roda junto com o teste real da placa (conta whisper-cli.exe)
  const userData = H.tmpDir('bf-subs-real-');
  const media = H.tmpDir('bf-subs-media-');
  const state = { ready: false, why: '' };
  const voices = H.listVoices();
  const pt = voices.find((v) => /^pt/i.test(v.culture));
  const en = voices.find((v) => /^en/i.test(v.culture));
  const fe = H.fakeElectron(userData);
  const ctx = createContext(fe.deps);
  require('../src/ipc/handlers/tools').register(ctx);
  require('../src/ipc/handlers/subtitles').register(ctx);
  const call = (channel, payload) => fe.call(channel, payload);
  const events = (channel) => fe.sent.filter(([c]) => c === channel).map(([, p]) => p);

  try {
    await t.test('instala o motor oficial e o modelo tiny pelas rotas do app', async (st) => {
      const cacheTools = path.join(CACHE, 'tools', 'whisper');
      const cacheModels = path.join(CACHE, 'models');
      if (CACHE && fs.existsSync(cacheTools) && fs.existsSync(cacheModels)) {
        H.copyDir(cacheTools, path.join(userData, 'tools', 'whisper'));
        H.copyDir(cacheModels, path.join(userData, 'models'));
        ctx.refreshTools({ force: true });
        st.diagnostic('motor e modelo copiados do cache de desenvolvimento (BF_SUBTITLES_TEST_CACHE)');
      } else {
        const engine = await call('tools:install', { id: 'whisper' });
        if (!engine.ok && NETWORK_CODES.has(engine.code) && !REQUIRE_NET) { state.why = `sem acesso à internet para baixar o motor oficial (${engine.code}: ${engine.message})`; return; }
        assert.equal(engine.ok, true, JSON.stringify(engine));
        const model = await call('subtitles:installModel', { id: 'tiny' });
        if (!model.ok && NETWORK_CODES.has(model.code) && !REQUIRE_NET) { state.why = `sem acesso à internet para baixar o modelo (${model.code}: ${model.message})`; return; }
        assert.equal(model.ok, true, JSON.stringify(model));
        if (CACHE) {
          H.copyDir(path.join(userData, 'tools', 'whisper'), cacheTools);
          H.copyDir(path.join(userData, 'models'), cacheModels);
        }
      }
      const status = await call('subtitles:status');
      assert.equal(status.engine.installed, true);
      assert.equal(status.engine.origin, 'app', 'o motor em uso é o instalado pelo app');
      assert.equal(status.engine.version, 'b5130');
      assert.ok(status.engine.path.endsWith('whisper-cli.exe') || status.engine.path.endsWith('whisper-cli'));
      assert.ok(status.engine.path.includes(path.join('tools', 'whisper', 'b5130')));
      assert.equal(status.models.find((m) => m.id === 'tiny').installed, true);
      const manifest = JSON.parse(fs.readFileSync(path.join(userData, 'tools', 'whisper', 'b5130', 'manifest.json'), 'utf8'));
      assert.equal(manifest.sha256, 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c', 'pacote oficial conferido (SHA-256 fixado na entrada)');
      assert.equal(manifest.size, 8573270);
      assert.match(manifest.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\//);
      const tinyManifest = JSON.parse(fs.readFileSync(path.join(userData, 'models', 'whisper-tiny', fs.readdirSync(path.join(userData, 'models', 'whisper-tiny'))[0], 'manifest.json'), 'utf8'));
      assert.match(tinyManifest.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-tiny-q5_1\.bin$/);
      assert.equal(tinyManifest.sha256.length, 64);
      st.diagnostic(`motor b5130 (${manifest.size} bytes) e modelo tiny (${tinyManifest.size} bytes, sha256 ${tinyManifest.sha256.slice(0, 12)}…) instalados em ${userData}`);
      state.ready = true;
    });

    const speech = path.join(media, 'fala.wav');
    if (pt) H.synthesize('Olá pessoal, bem-vindos ao nosso canal. Hoje vamos jogar uma partida muito divertida. Vamos lá!', pt.name, speech);
    const ready = (st, needVoice) => {
      if (!state.ready) { st.skip(state.why || 'a instalação do motor/modelo não foi concluída'); return false; }
      if (needVoice && !pt) { st.skip('o Windows não tem voz pt-BR (System.Speech) neste computador'); return false; }
      return true;
    };

    await t.test('fala em português: transcrita, com tempos relativos ao corte e progresso real', async (st) => {
      if (!ready(st, true)) return;
      const v = H.makeVideo(path.join(media, 'fala.mp4'), [{ silence: 3 }, { wav: speech }, { silence: 3 }]);
      const speechStart = v.parts[1].start; // 3,0 s
      const cut = { cutId: 'c1', start: 2, end: v.duration - 1 };
      fe.sent.length = 0;
      let usage = null;
      const watcher = setInterval(() => { if (!usage) usage = ctx.toolUsage.inUse('whisper', 'whisper'); }, 20);
      const res = await call('subtitles:generate', { ...cut, input: v.file, language: 'pt', modelId: 'tiny', maxChars: 22 });
      clearInterval(watcher);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.noSpeech, false);
      assert.equal(res.modelId, 'tiny');
      assert.equal(res.language, 'pt');
      assert.ok(res.cues.length >= 3, `falas: ${JSON.stringify(res.cues)}`);

      const dur = cut.end - cut.start;
      const text = res.cues.map((c) => c.text).join(' ');
      const found = ['ola', 'pessoal', 'bem-vindos', 'canal', 'hoje', 'vamos', 'jogar', 'partida', 'divertida'].filter((w) => norm(text).includes(w));
      assert.ok(found.length >= 7, `palavras reconhecidas: ${found.join(', ')} | texto: ${text}`);
      assert.ok(res.cues.every((c) => c.start >= 0 && c.end <= dur + 0.01 && c.end > c.start), 'dentro do corte');
      assert.ok(res.cues.every((c, i) => i === 0 || c.start >= res.cues[i - 1].start), 'em ordem');
      const expectedFirst = speechStart - cut.start; // a fala começa 1,0 s depois do início do corte
      assert.ok(Math.abs(res.cues[0].start - expectedFirst) < 0.7, `primeira fala em ${res.cues[0].start} s (esperado ~${expectedFirst} s relativo ao corte)`);
      assert.ok(res.cues.at(-1).end <= v.parts[1].end - cut.start + 1, 'a última fala termina junto com a fala');
      assert.ok(res.cues.every((c) => !c.needsReview), 'fala sintetizada nítida: nada para revisar');
      assert.ok(res.trimmedSec > 0.5, 'o silêncio do trecho foi tirado antes do whisper');

      const progress = events('subtitles:progress');
      assert.ok(progress.length >= 4 && progress.every((p) => p.cutId === 'c1'));
      const phases = [...new Set(progress.map((p) => p.phase))];
      for (const p of ['audio', 'silence', 'model', 'done']) assert.ok(phases.includes(p), `fase ${p}: ${phases}`);
      const pct = progress.map((p) => p.percent);
      assert.ok(pct.every((x, i) => i === 0 || x >= pct[i - 1]), `progresso nunca anda para trás: ${pct}`);
      assert.equal(pct.at(-1), 100);
      assert.equal(typeof usage, 'string', 'durante a geração o motor consta como em uso');
      assert.match(usage, /geração de legendas/);
      assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null, 'depois da geração, liberado');
      assert.deepEqual((await call('subtitles:status')).generating, []);
      st.diagnostic(`cues: ${res.cues.map((c) => `[${c.start}-${c.end}] ${c.text}`).join(' | ')} (${res.elapsedMs} ms)`);
    });

    await t.test('o resultado vira legenda exportável: SRT e ASS lidos de volta têm o mesmo texto', async (st) => {
      if (!ready(st, true)) return;
      const v = H.makeVideo(path.join(media, 'fala2.mp4'), [{ silence: 1 }, { wav: speech }]);
      const res = await call('subtitles:generate', { cutId: 'c2', start: 0, end: v.duration, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true);
      const { prepareBurnIn } = require('../src/core/subtitles/burnIn');
      const F = require('../src/core/subtitles/formats');
      const cut = { id: 'c2', title: 'x', start: 0, end: v.duration, revision: 1, subtitles: { enabled: true, mode: 'sidecar', basedOn: { start: 0, end: v.duration, revision: 1 }, cues: res.cues, style: {} } };
      const out = prepareBurnIn(cut, { tmpDir: path.join(media, 'job'), width: 1080, height: 1920 });
      const srt = F.parseSrt(fs.readFileSync(out.sidecars[0].path, 'utf8'));
      assert.equal(srt.map((c) => c.text).join(' ').replace(/\s+/g, ' '), res.cues.map((c) => c.text).join(' ').replace(/\s+/g, ' '));
    });

    await t.test('inglês (voz en-US) com o idioma en', async (st) => {
      if (!state.ready) { st.skip(state.why); return; }
      if (!en) { st.skip('o Windows não tem voz en-US (System.Speech) neste computador'); return; }
      const wav = path.join(media, 'speech-en.wav');
      H.synthesize('Hello everyone, welcome to my channel. Today we are going to play a very fun game.', en.name, wav);
      const v = H.makeVideo(path.join(media, 'en.mp4'), [{ silence: 1 }, { wav }, { silence: 1 }]);
      const res = await call('subtitles:generate', { cutId: 'c3', start: 0, end: v.duration, input: v.file, language: 'en', modelId: 'tiny' });
      assert.equal(res.ok, true);
      const words = norm(res.cues.map((c) => c.text).join(' '));
      const found = ['hello', 'everyone', 'welcome', 'channel', 'today', 'play', 'game'].filter((w) => words.includes(w));
      assert.ok(found.length >= 5, `palavras: ${found} | ${words.join(' ')}`);
    });

    await t.test('fala baixa (pico a -41 dBFS) NÃO é confundida com silêncio e é transcrita', async (st) => {
      if (!ready(st, true)) return;
      // a entrada é um WAV (1 s de silêncio + fala baixa): o ffmpeg lê o áudio de qualquer arquivo. O AAC de um MP4 destrói fala
      // tão baixa antes mesmo do app (no teste, o MP4 daria "[Música]" por causa do AAC, não do app).
      const quiet = path.join(media, 'baixa.wav');
      H.ffmpeg(['-i', speech, '-af', 'volume=-35dB', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', quiet]);
      const lead = path.join(media, 'baixa-1s.wav');
      H.ffmpeg(['-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=16000:cl=mono', '-i', quiet, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s16le', lead]);
      const res = await call('subtitles:generate', { cutId: 'c4', start: 0, end: 11, input: lead, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true);
      assert.notEqual(res.reason, 'silence', 'som baixo não é silêncio');
      assert.ok(res.speechSec > 8, `trecho com som: ${res.speechSec} s`);
      assert.equal(res.noSpeech, false, JSON.stringify(res));
      assert.ok(norm(res.cues.map((c) => c.text).join(' ')).includes('pessoal'));
    });

    await t.test('áudio em silêncio: "nenhuma fala detectada" e o whisper nem é chamado', async (st) => {
      if (!ready(st)) return;
      const v = H.makeVideo(path.join(media, 'silencio.mp4'), [{ silence: 8 }]);
      const via = await call('subtitles:generate', { cutId: 'c5', start: 0, end: 8, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(via.ok, true);
      assert.equal(via.noSpeech, true);
      assert.equal(via.reason, 'silence');
      assert.deepEqual(via.cues, []);
      assert.match(via.message, /Nenhuma fala detectada/);
      assert.match(via.message, /silêncio/);
      // prova de que o motor não roda: com um "motor" que falharia se fosse chamado, o resultado é o mesmo
      const direct = await generateSubtitles({ ffmpeg: H.tools.ffmpeg, whisper: process.execPath, modelPath: process.execPath, input: v.file, start: 0, end: 8, workRoot: path.join(media, 'w1') });
      assert.deepEqual([direct.noSpeech, direct.reason, direct.cues.length], [true, 'silence', 0]);
    });

    await t.test('ruído e música sem fala (whisper devolve "[Música]"): nenhuma fala, e o motivo do descarte fica registrado', async (st) => {
      if (!ready(st)) return;
      const v = H.makeVideo(path.join(media, 'ruido.mp4'), [{ noise: 8, amp: 0.2 }]);
      const res = await call('subtitles:generate', { cutId: 'c6', start: 0, end: 8, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true);
      assert.equal(res.noSpeech, true, `inventou fala em ruído: ${JSON.stringify(res.cues)}`);
      assert.deepEqual(res.cues, []);
      assert.equal(res.reason, 'no-speech');
      assert.ok(res.discarded.length >= 1, 'o que o motor devolveu foi descartado COM registro (nada some em silêncio)');
      assert.ok(res.discarded.every((d) => d.reason && typeof d.text === 'string'));
      st.diagnostic(`descartados: ${JSON.stringify(res.discarded)}`);
      const tone = H.makeVideo(path.join(media, 'tom.mp4'), [{ tone: 8 }]);
      const res2 = await call('subtitles:generate', { cutId: 'c7', start: 0, end: 8, input: tone.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res2.noSpeech, true, `inventou fala num tom: ${JSON.stringify(res2.cues)}`);
    });

    await t.test('ruído no meio de fala: só a fala vira legenda', async (st) => {
      if (!ready(st, true)) return;
      const v = H.makeVideo(path.join(media, 'mista.mp4'), [{ noise: 4, amp: 0.2 }, { wav: speech }, { noise: 4, amp: 0.2 }]);
      const res = await call('subtitles:generate', { cutId: 'c8', start: 0, end: v.duration, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true);
      const noiseWindows = [[0, 3.6], [v.parts[2].start + 0.4, v.duration]];
      for (const c of res.cues) {
        assert.ok(!noiseWindows.some(([a, b]) => c.start >= a && c.end <= b), `fala dentro do ruído: ${JSON.stringify(c)}`);
        assert.ok(!/\[|\]|música/i.test(c.text), `anotação de áudio virou fala: ${c.text}`);
      }
      assert.ok(norm(res.cues.map((c) => c.text).join(' ')).includes('pessoal'));
    });

    await t.test('vídeo sem faixa de áudio: nenhuma fala detectada (sem erro)', async (st) => {
      if (!ready(st)) return;
      const v = H.makeVideo(path.join(media, 'mudo.mp4'), [{ silence: 5 }], { noAudio: true });
      const res = await call('subtitles:generate', { cutId: 'c9', start: 0, end: 4, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true);
      assert.equal(res.noSpeech, true);
      assert.equal(res.reason, 'no-audio');
      assert.match(res.message, /não tem áudio/);
    });

    await t.test('cancelar no meio: CANCELLED, nenhum processo do motor e nenhuma pasta de trabalho sobram', async (st) => {
      if (!ready(st, true)) return;
      const many = Array.from({ length: 10 }, () => ({ wav: speech }));
      const v = H.makeVideo(path.join(media, 'longo.mp4'), many);
      fe.sent.length = 0;
      const pending = call('subtitles:generate', { cutId: 'c10', start: 0, end: v.duration, input: v.file, language: 'pt', modelId: 'tiny' });
      await waitFor(() => events('subtitles:progress').some((p) => p.phase === 'transcribe'));
      assert.equal((await call('subtitles:generate', { cutId: 'outro', start: 0, end: 5, input: v.file, modelId: 'tiny' })).code, 'BUSY', 'uma geração por vez');
      assert.equal((await call('subtitles:removeModel', { id: 'tiny' })).code, 'MODEL_IN_USE', 'o modelo em uso não é removido');
      assert.deepEqual(await call('subtitles:cancel', { cutId: 'c10' }), { ok: true, cancelled: true });
      const res = await pending;
      assert.equal(res.ok, false);
      assert.equal(res.code, 'CANCELLED');
      await sleep(500);
      assert.equal(whisperProcesses(), 0, 'nenhum whisper-cli.exe ficou rodando');
      const work = path.join(userData, 'cache', 'subtitles');
      assert.deepEqual(fs.existsSync(work) ? fs.readdirSync(work) : [], [], 'pasta de trabalho apagada');
      assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null);
      assert.equal((await call('subtitles:status')).models.find((m) => m.id === 'tiny').installed, true, 'o modelo continua instalado');
    });

    await t.test('caminho com acentos e espaços (o whisper-cli não aceita acentos nos argumentos)', async (st) => {
      if (!ready(st, true)) return;
      const accented = path.join(userData, 'Usuário João', 'dados');
      const fe2 = H.fakeElectron(accented);
      const ctx2 = createContext(fe2.deps);
      // a pasta dos modelos tem acento no nome: o caminho relativo do modelo NÃO é ASCII e o app precisa usar um atalho/cópia na pasta de trabalho
      const modelsDir = path.join(accented, 'Modelos ação');
      ctx2.subtitlesOptions = { modelsDir };
      require('../src/ipc/handlers/subtitles').register(ctx2);
      H.copyDir(path.join(userData, 'models'), modelsDir);
      ctx2.tools.whisper = ctx.tools.whisper;
      const v = H.makeVideo(path.join(media, 'acento.mp4'), [{ silence: 1 }, { wav: speech }]);
      const res = await fe2.call('subtitles:generate', { cutId: 'c11', start: 0, end: v.duration, input: v.file, language: 'pt', modelId: 'tiny' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(norm(res.cues.map((c) => c.text).join(' ')).includes('pessoal'));
    });

    await t.test('limpeza: nada sobrou nas pastas de trabalho do app', async (st) => {
      if (!ready(st)) return;
      assert.deepEqual(H.listTree(path.join(userData, 'models')).filter((p) => /\.part$|(^|\/)\.tmp(\/|$)/.test(p)), []);
      assert.deepEqual(H.listTree(path.join(userData, 'tools')).filter((p) => /\.part$|(^|\/)\.tmp(\/|$)/.test(p)), []);
      assert.equal(whisperProcesses(), 0);
    });
  } finally {
    H.cleanup(userData);
    H.cleanup(media);
    releaseLock();
    void S;
  }
});
