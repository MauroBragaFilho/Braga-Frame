'use strict';

/**
 * Detector LOCAL de layout (Conversa | Jogo) a partir de QUADROS DE REFERÊNCIA que o usuário escolhe (até 4 por layout).
 *
 * Por que existe: o `layout` que a análise guarda em cada corte vem de uma IA que só lê TEXTO, então é um palpite. Este
 * detector olha a imagem. É explicável e conservador: na dúvida devolve "incerto" (nunca chuta).
 *
 * Como funciona (tudo em miniaturas de 64x36 em tons de cinza, sem rede e sem aprendizado de máquina):
 *  1. De cada miniatura tira-se um mapa de BORDAS (gradiente). Bordas descrevem o "cenário" do OBS (moldura da câmera, QR code,
 *     painel do chat, barra de vida) e não dependem do brilho da cena.
 *  2. Com as referências de cada layout acha-se o CENÁRIO FIXO dele: as células que TÊM borda, com bordas parecidas entre as
 *     referências do mesmo layout (estáveis) e diferentes das de TODAS as referências do outro layout (distintivas). Só blocos
 *     conexos contam (células soltas que ficaram parecidas por acaso são descartadas).
 *     Para isso os quadros de um mesmo layout precisam ser DIFERENTES entre si (momentos diferentes); quadros quase iguais são recusados.
 *  3. Um quadro novo é comparado ao cenário fixo de cada layout por correlação (1 - NCC: 0 = idêntico, 1 = sem relação).
 *  4. Decide só se o melhor layout é parecido de verdade (pontuação <= MAX_SCORE) e MUITO mais parecido que o outro
 *     (pelo menos RATIO vezes). Senão: incerto.
 *  5. Para um corte, 3 quadros (20%, 50% e 80% do corte): vale o layout se ao menos 2 quadros decidem e nenhum discorda.
 *
 * Medido com uma live de teste (veja docs/recursos/exportEngine.md, "Detector local de layout"). Os limiares abaixo foram escolhidos
 * varrendo os MESMOS quadros rotulados da medição (não há conjunto independente) e só uma live foi medida: os números do documento
 * podem estar otimistas para outras cenas do OBS. Nada aqui é específico de um vídeo (valem os mesmos números para qualquer fonte).
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const THUMB_W = 64;
const THUMB_H = 36;
const THUMB_LEN = THUMB_W * THUMB_H;
const LAYOUTS = Object.freeze(['conversa', 'jogo']);
const MIN_REFS = 2; // por layout: com um só quadro não dá para separar cenário fixo de conteúdo
const MAX_REFS = 4;
const DIVERSE_MIN = 0.02; // diferença média mínima (luminância 0..1) entre dois quadros de referência do mesmo layout
const SAMPLE_FRACTIONS = Object.freeze([0.2, 0.5, 0.8]);

// cenário fixo
const STABLE_MAX = 0.03; // desvio padrão máximo, entre as referências do mesmo layout, do mapa de bordas numa célula estável
const EDGE_MIN = 0.04; // borda média mínima na célula: cenário é o que TEM borda (moldura, QR code, texto), não áreas lisas que ficaram iguais por acaso
const DISTINCT_MIN = 0.06; // diferença mínima para TODAS as referências do outro layout numa célula distintiva
const BLOB_MIN = 10; // células conexas mínimas de um bloco do cenário
const MIN_CELLS = 20; // abaixo disto o layout não tem cenário fixo reconhecível (referências ruins)

// decisão
const MAX_SCORE = 0.35;
const RATIO = 3;

class DetectorError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DetectorError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isThumb = (t) => (t instanceof Uint8Array || t instanceof Float32Array) && t.length === THUMB_LEN;

/** Menor diferença média de luminância (0..1) entre dois quadros quaisquer da lista (1 se há menos de dois). */
function minPairDistance(list) {
  let min = 1;
  const scale = list[0] instanceof Uint8Array ? 1 / 255 : 1;
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      let sum = 0;
      for (let i = 0; i < THUMB_LEN; i++) sum += Math.abs(list[a][i] - list[b][i]);
      min = Math.min(min, (sum * scale) / THUMB_LEN);
    }
  }
  return min;
}

/** Mapa de bordas (|dx| + |dy| por diferenças à frente) de uma miniatura de 64x36 (bytes 0..255 ou 0..1). */
function gradientMap(thumb) {
  const scale = thumb instanceof Uint8Array ? 1 / 255 : 1;
  const g = new Float32Array(THUMB_LEN);
  for (let y = 0; y < THUMB_H; y++) {
    for (let x = 0; x < THUMB_W; x++) {
      const i = y * THUMB_W + x;
      const c = thumb[i] * scale;
      const r = x + 1 < THUMB_W ? thumb[i + 1] * scale : c;
      const d = y + 1 < THUMB_H ? thumb[i + THUMB_W] * scale : c;
      g[i] = Math.abs(r - c) + Math.abs(d - c);
    }
  }
  return g;
}

function meanStd(maps) {
  const n = maps.length;
  const mean = new Float32Array(THUMB_LEN);
  const std = new Float32Array(THUMB_LEN);
  for (const m of maps) for (let i = 0; i < THUMB_LEN; i++) mean[i] += m[i] / n;
  for (const m of maps) for (let i = 0; i < THUMB_LEN; i++) std[i] += ((m[i] - mean[i]) ** 2) / n;
  for (let i = 0; i < THUMB_LEN; i++) std[i] = Math.sqrt(std[i]);
  return { mean, std };
}

/** Só os blocos conexos (4 vizinhos) de pelo menos BLOB_MIN células. */
function keepBlobs(on) {
  const seen = new Uint8Array(THUMB_LEN);
  const kept = [];
  for (let start = 0; start < THUMB_LEN; start++) {
    if (!on[start] || seen[start]) continue;
    const comp = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % THUMB_W;
      const y = (i / THUMB_W) | 0;
      const around = [x + 1 < THUMB_W ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < THUMB_H ? i + THUMB_W : -1, y > 0 ? i - THUMB_W : -1];
      for (const k of around) {
        if (k >= 0 && on[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (comp.length >= BLOB_MIN) kept.push(...comp);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Monta o modelo a partir das referências: `refs = { conversa: [miniatura…], jogo: [miniatura…] }`.
 * Devolve { ok, layouts:{ conversa:{ n, cells:number[], mean }, jogo:{…} }, problems:[{ layout, code, message }] }.
 * `ok` só é verdadeiro se os DOIS layouts têm referências suficientes e um cenário fixo reconhecível.
 */
function buildModel(refs) {
  const problems = [];
  const model = { ok: false, layouts: {}, problems };
  const maps = {};
  for (const layout of LAYOUTS) {
    const list = (refs && Array.isArray(refs[layout]) ? refs[layout] : []).filter(isThumb).slice(0, MAX_REFS);
    maps[layout] = list.map(gradientMap);
    model.layouts[layout] = { n: list.length, cells: [], mean: null };
    const name = layout === 'jogo' ? 'Jogo' : 'Conversa';
    if (list.length < MIN_REFS) {
      problems.push({ layout, code: 'FEW_REFS', message: `${name}: escolha pelo menos ${MIN_REFS} quadros de referência, de momentos diferentes (${list.length} escolhido${list.length === 1 ? '' : 's'}).` });
    } else if (minPairDistance(list) < DIVERSE_MIN) {
      // quadros quase iguais não mostram o que muda e o que fica: o modelo confundiria conteúdo com cenário
      problems.push({ layout, code: 'SIMILAR_REFS', message: `${name}: dois dos quadros escolhidos são quase iguais. Escolha quadros de momentos bem diferentes (a câmera, o jogo ou o chat mudam de um para o outro).` });
    }
  }
  if (problems.length) return model;
  for (const layout of LAYOUTS) {
    const other = LAYOUTS.find((x) => x !== layout);
    const { mean, std } = meanStd(maps[layout]);
    const on = new Uint8Array(THUMB_LEN);
    for (let i = 0; i < THUMB_LEN; i++) {
      if (std[i] > STABLE_MAX || mean[i] < EDGE_MIN) continue;
      let nearest = Infinity;
      for (const m of maps[other]) nearest = Math.min(nearest, Math.abs(mean[i] - m[i]));
      if (nearest >= DISTINCT_MIN) on[i] = 1;
    }
    const cells = keepBlobs(on);
    model.layouts[layout].cells = cells;
    model.layouts[layout].mean = mean;
    if (cells.length < MIN_CELLS) {
      problems.push({
        layout, code: 'NO_SCENERY',
        message: `${layout === 'jogo' ? 'Jogo' : 'Conversa'}: os quadros escolhidos não têm uma parte fixa em comum que os distinga do outro layout. Escolha quadros de momentos diferentes em que a câmera, o chat ou o QR code apareçam do mesmo jeito.`
      });
    }
  }
  model.ok = problems.length === 0;
  return model;
}

/** 1 - correlação entre o mapa de bordas do quadro e o cenário fixo do layout, só nas células dele (0 = igual, ~1 = sem relação). */
function scoreAgainst(layoutModel, grad) {
  const { cells, mean } = layoutModel;
  if (!mean || cells.length < MIN_CELLS) return null;
  let mg = 0;
  let mm = 0;
  for (const i of cells) { mg += grad[i]; mm += mean[i]; }
  mg /= cells.length;
  mm /= cells.length;
  let num = 0;
  let a = 0;
  let b = 0;
  for (const i of cells) {
    const x = grad[i] - mg;
    const y = mean[i] - mm;
    num += x * y;
    a += x * x;
    b += y * y;
  }
  if (a < 1e-9 || b < 1e-9) return 1; // quadro liso (tela preta, por exemplo): sem relação
  return 1 - num / Math.sqrt(a * b);
}

/**
 * Classifica UM quadro. { layout: 'conversa'|'jogo'|null, scores:{conversa,jogo}, confidence:0..1, reason }.
 * `confidence` = quanto o melhor layout é mais parecido que o outro: 1 - melhor/outro (decidir exige pelo menos 1 - 1/RATIO, ou seja, 0,67).
 */
function classifyFrame(model, thumb) {
  if (!model || !model.ok) return { layout: null, scores: { conversa: null, jogo: null }, confidence: 0, reason: 'sem_modelo' };
  if (!isThumb(thumb)) return { layout: null, scores: { conversa: null, jogo: null }, confidence: 0, reason: 'sem_quadro' };
  const grad = gradientMap(thumb);
  const scores = { conversa: scoreAgainst(model.layouts.conversa, grad), jogo: scoreAgainst(model.layouts.jogo, grad) };
  const best = scores.conversa <= scores.jogo ? 'conversa' : 'jogo';
  const other = best === 'conversa' ? 'jogo' : 'conversa';
  const confidence = scores[other] > 0 ? Math.max(0, Math.min(1, 1 - scores[best] / scores[other])) : 0;
  if (scores[best] > MAX_SCORE) return { layout: null, scores, confidence, reason: 'longe_dos_dois' };
  if (scores[other] < RATIO * scores[best]) return { layout: null, scores, confidence, reason: 'parecido_com_os_dois' };
  return { layout: best, scores, confidence, reason: 'ok' };
}

/**
 * Classifica um corte por seus quadros (normalmente 3: 20%, 50% e 80%). `thumbs` pode ter `null` (quadro que não saiu).
 * Vale o layout se ao menos 2 quadros decidem e todos os que decidem concordam; senão `layout: null` ("layout incerto").
 * `confidence` = a menor entre os quadros que decidiram.
 */
function classifyCut(model, thumbs) {
  const samples = (Array.isArray(thumbs) ? thumbs : []).map((t) => classifyFrame(model, t));
  const decided = samples.filter((s) => s.layout);
  const votes = new Set(decided.map((s) => s.layout));
  if (decided.length < 2) return { layout: null, confidence: 0, reason: decided.length ? 'poucos_quadros' : 'incerto', samples };
  if (votes.size > 1) return { layout: null, confidence: 0, reason: 'quadros_discordam', samples };
  const confidence = Math.min(...decided.map((s) => s.confidence));
  return { layout: [...votes][0], confidence, reason: 'ok', samples };
}

/** Instantes (segundos) dos quadros de um corte: 20%, 50% e 80% entre início e fim. */
function cutTimes(cut) {
  const start = Number(cut && cut.start);
  const end = Number(cut && cut.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return SAMPLE_FRACTIONS.map((f) => Number((start + (end - start) * f).toFixed(3)));
}

// ---------- extração dos quadros (ffmpeg real, baixa resolução) ----------

/**
 * Miniatura 64x36 em tons de cinza do quadro em `timeSec` (Uint8Array de 2304 bytes) ou null se o ffmpeg não entregar quadro.
 * Lê o vídeo (nunca escreve nada ao lado dele).
 */
function grabThumb({ ffmpeg, sourcePath, timeSec, signal, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (typeof sourcePath !== 'string' || !sourcePath || !fs.existsSync(sourcePath)) {
      reject(new DetectorError('INPUT_MISSING', 'O vídeo de origem não foi encontrado.'));
      return;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, Number(Number(timeSec).toFixed(3)) || 0)), '-i', sourcePath,
      '-frames:v', '1', '-an', '-vf', `scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'];
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new DetectorError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`));
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    const kill = () => { try { child.kill(); } catch { /* já terminou */ } };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { aborted = true; kill(); }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => { size += c.length; if (size <= THUMB_LEN * 2) chunks.push(c); });
    child.stderr.on('data', () => {});
    child.on('error', (err) => { clearTimeout(timer); reject(new DetectorError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) { reject(new DetectorError(signal && signal.aborted ? 'CANCELLED' : 'TIMEOUT', signal && signal.aborted ? 'Detecção cancelada.' : 'O ffmpeg demorou demais para ler um quadro.')); return; }
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length !== THUMB_LEN) { resolve(null); return; }
      resolve(new Uint8Array(buf));
    });
  });
}

/** Quadros (miniaturas) de uma lista de instantes, `concurrency` por vez. Instante sem quadro vira null. */
async function grabThumbs({ ffmpeg, sourcePath, times, signal, concurrency = 3, onEach }) {
  const out = new Array(times.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < times.length) {
      const index = next++;
      if (signal && signal.aborted) throw new DetectorError('CANCELLED', 'Detecção cancelada.');
      out[index] = await grabThumb({ ffmpeg, sourcePath, timeSec: times[index], signal });
      if (onEach) onEach(index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, times.length || 1)) }, worker));
  return out;
}

/**
 * Detecta o layout de cada corte. `cuts`: [{ id, start, end }]. `refs`: { conversa:[miniatura], jogo:[miniatura] }.
 * Devolve { ok:false, problems } se as referências não servem; senão { ok:true, results:[{ cutId, layout, confidence, reason, samples }] }.
 * `onProgress(feito, total)` a cada corte concluído.
 */
async function detectCuts({ ffmpeg, sourcePath, cuts, refs, signal, onProgress, concurrency = 3 }) {
  const model = buildModel(refs);
  if (!model.ok) return { ok: false, problems: model.problems, model: summarize(model) };
  const list = Array.isArray(cuts) ? cuts : [];
  const results = [];
  let done = 0;
  for (const cut of list) {
    if (signal && signal.aborted) throw new DetectorError('CANCELLED', 'Detecção cancelada.');
    const times = cutTimes(cut);
    const thumbs = times.length ? await grabThumbs({ ffmpeg, sourcePath, times, signal, concurrency }) : [];
    const verdict = classifyCut(model, thumbs);
    results.push({ cutId: cut.id, ...verdict, samples: verdict.samples.map((s, i) => ({ t: times[i], layout: s.layout, scores: s.scores, reason: s.reason })) });
    done += 1;
    if (onProgress) onProgress(done, list.length);
  }
  return { ok: true, results, model: summarize(model) };
}

/** Resumo do modelo para a interface (sem as matrizes). */
function summarize(model) {
  return {
    ok: model.ok,
    layouts: Object.fromEntries(LAYOUTS.map((l) => [l, { refs: model.layouts[l] ? model.layouts[l].n : 0, sceneryPct: model.layouts[l] ? Math.round((model.layouts[l].cells.length / THUMB_LEN) * 100) : 0 }])),
    problems: model.problems
  };
}

/** Miniatura <-> texto (base64) para guardar no projeto. */
const thumbToBase64 = (thumb) => Buffer.from(thumb).toString('base64');
function thumbFromBase64(text) {
  if (typeof text !== 'string' || text.length !== Math.ceil(THUMB_LEN / 3) * 4) return null;
  const buf = Buffer.from(text, 'base64');
  return buf.length === THUMB_LEN ? new Uint8Array(buf) : null;
}

module.exports = {
  THUMB_W, THUMB_H, THUMB_LEN, LAYOUTS, MIN_REFS, MAX_REFS, DIVERSE_MIN, SAMPLE_FRACTIONS, STABLE_MAX, EDGE_MIN, DISTINCT_MIN, BLOB_MIN, MIN_CELLS, MAX_SCORE, RATIO,
  DetectorError, gradientMap, buildModel, scoreAgainst, classifyFrame, classifyCut, cutTimes, grabThumb, grabThumbs, detectCuts, summarize,
  thumbToBase64, thumbFromBase64
};
