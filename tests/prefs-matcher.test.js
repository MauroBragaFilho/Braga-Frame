'use strict';

/**
 * Correspondência com lives já analisadas (src/core/projects/matcher.js): forte, média, fraca, nenhuma e,
 * principalmente, os falsos positivos que NÃO podem perguntar "parece a live X".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../src/core/projects/matcher');
const { summary } = require('./prefs-helpers');

const { matchOne, findMatches, parseVideoUrl, videoRef, titleSimilarity, normalizeTitle } = matcher;
const level = (incoming, existing) => matchOne(incoming, existing).level;

const origin = (o) => ({ type: 'vod', ...o });
const yt = (id, extra) => origin({ platform: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}`, ...extra });

test('endereços do YouTube e da Twitch viram plataforma + código', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/AbC_123-xyz', 'youtube', 'AbC_123-xyz'],
    ['https://m.youtube.com/shorts/ZZZ1', 'youtube', 'ZZZ1'],
    ['youtube.com/embed/EMB1', 'youtube', 'EMB1'],
    ['https://www.twitch.tv/videos/2345678901', 'twitch', '2345678901'],
    ['https://www.twitch.tv/fulano/v/2345678901', 'twitch', '2345678901'],
    ['https://player.twitch.tv/?video=v2345678901&parent=x', 'twitch', 'v2345678901']
  ];
  for (const [url, platform, id] of cases) assert.deepEqual(parseVideoUrl(url), { platform, id }, url);
  for (const bad of ['', 'não é endereço', 'https://exemplo.com/watch?v=1', 'https://www.twitch.tv/fulano', 'https://www.youtube.com/', null, 42]) {
    assert.equal(parseVideoUrl(bad), null, String(bad));
  }
  // o "v" do código da Twitch é removido na referência
  assert.deepEqual(videoRef({ platform: 'twitch', videoId: 'v123' }), { platform: 'twitch', id: '123' });
  assert.deepEqual(videoRef({ url: 'https://www.twitch.tv/videos/123' }), { platform: 'twitch', id: '123' });
  assert.equal(videoRef({ title: 'só título' }), null);
});

test('títulos: sem acento/pontuação; números diferentes derrubam a semelhança', () => {
  assert.equal(normalizeTitle('  Live: RANKED — Valórant!! '), 'live ranked valorant');
  assert.equal(titleSimilarity('Ranked Valorant', 'ranked  valórant!'), 1);
  assert.ok(titleSimilarity('Ranked Valorant até Radiante', 'Ranked Valorant até Radiante - parte final') >= 0.8);
  assert.ok(titleSimilarity('Ranked Valorant #12', 'Ranked Valorant #13') <= 0.5, 'episódios diferentes');
  assert.ok(titleSimilarity('Live 21/10/2026', 'Live 22/10/2026') <= 0.5, 'datas diferentes');
  assert.equal(titleSimilarity('', 'algo'), 0);
  assert.ok(titleSimilarity('Minecraft hardcore', 'Valorant ranked') < 0.2);
});

// ---------- forte ----------

test('FORTE: mesmo código de vídeo, mesmo que o caminho, o nome e o tamanho sejam outros', () => {
  const old = summary({ source: { path: 'D:\\Lives\\antiga.mp4', size: 5e9, duration: 7200, origin: yt('abc123XYZ_1') } });
  const incoming = { path: 'E:\\Downloads\\outro nome qualquer.mkv', size: 1, duration: 10, origin: yt('abc123XYZ_1') };
  const r = matchOne(incoming, old);
  assert.equal(r.level, 'strong');
  assert.equal(r.score, 1000);
  assert.match(r.reasons[0], /mesmo vídeo do YouTube \(código abc123XYZ_1\)/);
});

test('FORTE: o código pode vir só do endereço (um lado com videoId, o outro com URL)', () => {
  const old = summary({ source: { origin: origin({ platform: 'twitch', videoId: '2345678901' }) } });
  assert.equal(level({ path: 'E:\\x.mp4', origin: origin({ url: 'https://www.twitch.tv/videos/2345678901' }) }, old), 'strong');
  assert.equal(level({ path: 'E:\\x.mp4', origin: origin({ videoId: 'v2345678901' }) }, old), 'strong', 'com o "v" na frente também');
});

test('FORTE: mesmo endereço em plataforma desconhecida', () => {
  const old = summary({ source: { origin: origin({ url: 'https://exemplo.com/videos/42?utm=a' }) } });
  const r = matchOne({ path: 'E:\\x.mp4', origin: origin({ url: 'http://www.exemplo.com/videos/42/' }) }, old);
  assert.equal(r.level, 'strong');
  assert.deepEqual(r.reasons, ['mesmo endereço do vídeo']);
});

test('códigos DIFERENTES excluem a correspondência, mesmo com mesmo canal, título e duração (live diária)', () => {
  const old = summary({ source: { duration: 14400, origin: yt('AAA111', { channel: 'Fulano', title: 'Ranked Valorant ao vivo' }) } });
  const incoming = { path: 'E:\\hoje.mp4', size: 1, duration: 14410, origin: yt('BBB222', { channel: 'Fulano', title: 'Ranked Valorant ao vivo' }) };
  const r = matchOne(incoming, old);
  assert.equal(r.level, 'none');
  assert.equal(r.excluded, true);
});

test('mesmo código em plataformas diferentes NÃO é forte (podem ser coincidências de código)', () => {
  const old = summary({ source: { origin: origin({ platform: 'youtube', videoId: '12345678901' }) } });
  assert.notEqual(level({ path: 'E:\\x.mp4', origin: origin({ platform: 'twitch', videoId: '12345678901' }) }, old), 'strong');
});

// ---------- média ----------

const base = { channel: 'Fulano Gamer', title: 'Ranked Valorant até Radiante' };

test('MÉDIA: mesmo canal + título normalizado + duração parecida (sem código de vídeo)', () => {
  const old = summary({ source: { duration: 14400, origin: origin(base) } });
  const incoming = { path: 'E:\\vod.mp4', size: 1, duration: 14460, origin: origin({ channel: 'fulano gamer', title: 'RANKED Valórant até Radiante!' }) };
  const r = matchOne(incoming, old);
  assert.equal(r.level, 'medium');
  assert.match(r.reasons[0], /mesmo canal \(fulano gamer\), título igual e duração parecida \(4:01:00 e 4:00:00\)/);
  const partial = { ...incoming, origin: origin({ channel: 'fulano gamer', title: 'Ranked Valorant até Radiante - parte final' }) };
  assert.match(matchOne(partial, old).reasons[0], /título parecido/, 'título só parecido diz "parecido"');
  assert.ok(r.score >= 500 && r.score < 1000);
});

test('MÉDIA: o canal pode estar em project.meta (digitado pelo usuário) em vez da origem', () => {
  const old = summary({ meta: { channel: 'Fulano Gamer' }, source: { duration: 3600, origin: origin({ title: base.title }) } });
  assert.equal(level({ path: 'E:\\x.mp4', duration: 3610, origin: origin(base) }, old), 'medium');
});

test('MÉDIA não vale: título com outro número, duração diferente, outro canal ou outra data', () => {
  const old = summary({ source: { duration: 14400, origin: origin({ ...base, title: 'Ranked Valorant #12', uploadDate: '2026-10-20' }) } });
  const inc = (o, dur = 14400) => ({ path: 'E:\\x.mp4', duration: dur, origin: origin({ channel: base.channel, title: 'Ranked Valorant #12', uploadDate: '2026-10-20', ...o }) });
  assert.equal(level(inc({}), old), 'medium', 'controle: tudo igual');
  assert.equal(level(inc({ title: 'Ranked Valorant #13' }), old), 'none', 'outro episódio');
  assert.equal(level(inc({}, 14400 + 900), old), 'none', 'duração 15 min diferente');
  assert.equal(level(inc({ channel: 'Outro Canal' }), old), 'none', 'outro canal');
  assert.equal(level(inc({ uploadDate: '2026-10-21' }), old), 'none', 'publicado em outro dia');
  assert.equal(level(inc({ title: 'Outro assunto completamente diferente' }), old), 'none', 'título diferente');
  assert.equal(level({ path: 'E:\\x.mp4', origin: origin({ channel: base.channel, title: 'Ranked Valorant #12' }) }, old), 'none', 'sem duração não dá para dizer');
});

// ---------- fraca ----------

test('FRACA: dois sinais do arquivo (nome + duração, nome + tamanho ou tamanho + duração)', () => {
  const old = summary({ source: { path: 'D:\\OBS\\2026-10-21 14-30-00.mkv', size: 3221225472, duration: 5421.3 } });
  const copy = (o) => ({ path: 'E:\\Backup\\2026-10-21 14-30-00.mkv', size: 3221225472, duration: 5421.3, ...o });
  const r = matchOne(copy({}), old);
  assert.equal(r.level, 'weak');
  assert.equal(r.reasons.length, 3);
  assert.ok(r.reasons.some((x) => /mesmo nome de arquivo/.test(x)));
  assert.ok(r.reasons.some((x) => /mesmo tamanho \(3,0 GB\)/.test(x)));
  assert.ok(r.reasons.some((x) => /duração parecida \(1:30:21 e 1:30:21\)/.test(x)));
  assert.equal(level(copy({ size: 999 }), old), 'weak', 'nome + duração');
  assert.equal(level(copy({ duration: 9999 }), old), 'weak', 'nome + tamanho');
  assert.equal(level(copy({ path: 'E:\\copia final.mkv' }), old), 'weak', 'tamanho + duração (renomeado)');
});

test('FRACA não vale com um sinal só: nome igual, tamanho igual ou duração igual isolados', () => {
  const old = summary({ source: { path: 'D:\\OBS\\2026-10-21 14-30-00.mkv', size: 3221225472, duration: 5421.3 } });
  assert.equal(level({ path: 'E:\\2026-10-21 14-30-00.mkv', size: 1, duration: 100 }, old), 'none', 'só o nome');
  assert.equal(level({ path: 'E:\\outro.mkv', size: 3221225472, duration: 100 }, old), 'none', 'só o tamanho');
  assert.equal(level({ path: 'E:\\outro.mkv', size: 1, duration: 5421.3 }, old), 'none', 'só a duração');
});

test('FALSOS POSITIVOS: duas gravações diferentes com a mesma duração; nomes genéricos', () => {
  const old = summary({ source: { path: 'D:\\OBS\\video.mp4', size: 900000000, duration: 1800 } });
  assert.equal(level({ path: 'E:\\video.mp4', size: 800000000, duration: 1800.2 }, old), 'none', '"video.mp4" é genérico: só a duração bate');
  for (const generic of ['gameplay.mp4', 'Gravação 1.mp4', 'output.mkv', 'live.mp4', 'obs.mkv', 'a.mp4']) {
    const g = summary({ source: { path: `D:\\${generic}`, size: 1000, duration: 500 } });
    assert.equal(level({ path: `E:\\${generic}`, size: 2000, duration: 500 }, g), 'none', generic);
  }
  // duração dentro de 0,2% mas nome e tamanho diferentes: um sinal só
  assert.equal(level({ path: 'E:\\sessao-2.mp4', size: 12345, duration: 1801 }, old), 'none');
});

test('FRACA não vale quando os canais são conhecidos e diferentes', () => {
  const old = summary({ meta: { channel: 'Fulano' }, source: { path: 'D:\\x\\2026-10-21 14-30-00.mkv', size: 1000, duration: 500 } });
  assert.equal(level({ path: 'E:\\2026-10-21 14-30-00.mkv', size: 1000, duration: 500, origin: origin({ channel: 'Beltrano' }) }, old), 'none');
  assert.equal(level({ path: 'E:\\2026-10-21 14-30-00.mkv', size: 1000, duration: 500, origin: origin({ channel: 'fulano' }) }, old), 'weak');
});

// ---------- nenhuma / filtros ----------

test('NENHUMA: projeto sem cortes não é "live já analisada"; o mesmo caminho não é duplicata', () => {
  const empty = summary({ cutCount: 0, source: { origin: yt('AAA') } });
  assert.equal(level({ path: 'E:\\x.mp4', origin: yt('AAA') }, empty), 'none');
  const same = summary({ source: { path: 'D:\\Lives\\Antiga.mp4', origin: yt('AAA') } });
  assert.equal(level({ path: 'd:\\lives\\antiga.MP4', origin: yt('AAA') }, same), process.platform === 'win32' ? 'none' : 'strong');
  assert.equal(level({ path: 'D:\\Lives\\Antiga.mp4', origin: yt('AAA') }, same), 'none');
});

test('NENHUMA: arquivo local sem origem e sem sinais não corresponde a nada', () => {
  const list = [summary({ source: { origin: yt('AAA', base), duration: 7200 } }), summary({ source: { path: 'D:\\x\\y.mp4', size: 5, duration: 99 } })];
  assert.deepEqual(findMatches({ path: 'E:\\novo.mp4', size: 777, duration: 1234.5, origin: null }, list), []);
  assert.deepEqual(findMatches({ path: 'E:\\novo.mp4' }, []), []);
  assert.deepEqual(findMatches({ path: 'E:\\novo.mp4' }, null), []);
});

test('ordenação: nível, pontuação, mais cortes, mais recente; label usa título de origem ou nome do arquivo', () => {
  const strong = summary({ id: 's', cutCount: 2, source: { path: 'D:\\a\\forte.mp4', origin: yt('AAA', { title: 'Título da Live' }) } });
  const medium = summary({ id: 'm', cutCount: 30, source: { duration: 3600, origin: origin(base) } });
  const weakFew = summary({ id: 'w1', cutCount: 3, updatedAt: '2026-10-01T00:00:00.000Z', source: { path: 'D:\\a\\2026-10-21 14-30-00.mkv', size: 1000, duration: 3600 } });
  const weakMany = summary({ id: 'w2', cutCount: 9, updatedAt: '2026-09-01T00:00:00.000Z', source: { path: 'D:\\b\\2026-10-21 14-30-00.mkv', size: 1000, duration: 3600 } });
  const incoming = { path: 'E:\\2026-10-21 14-30-00.mkv', size: 1000, duration: 3600, origin: { ...yt('AAA'), ...base } };
  const found = findMatches(incoming, [weakFew, weakMany, medium, strong]);
  assert.deepEqual(found.map((m) => `${m.project.id}:${m.level}`), ['s:strong', 'm:medium', 'w2:weak', 'w1:weak']);
  assert.equal(found[0].label, 'Título da Live');
  assert.equal(found[2].label, '2026-10-21 14-30-00', 'sem título de origem usa o nome do arquivo');
  assert.equal(found[0].cutCount, 2);
});
