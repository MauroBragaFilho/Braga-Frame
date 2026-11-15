'use strict';

/** Ajudantes dos testes do recurso prefs (preferências, aprendizado, correspondência e comparação). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const { newProject } = require('../src/core/projects/projectStore');
const model = require('../src/core/projects/model');

const real = locateTools();
const skipMedia = !real.ffmpeg || !real.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;
const silent = { log() {}, info() {}, warn() {}, error() {} };

function mkTmp(name = 'prefs') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

let seq = 0;

/** Estado de corte como o renderer envia em prefs:observe. */
function cutState(overrides = {}) {
  return { status: 'approved', duration: 30, category: '', relevance: null, origin: 'manual', profileId: null, ...overrides };
}

/** [{ id, state }] com um corte por duração informada (todos aprovados por padrão). */
function cutsOf(durations, overrides = {}) {
  return durations.map((duration) => ({ id: `t${++seq}`, state: cutState({ duration, ...overrides }) }));
}

/** Relógio controlável: devolve datas ISO crescentes (um segundo por chamada). */
function clock(start = '2026-10-21T12:00:00.000Z') {
  let t = Date.parse(start);
  return () => { t += 1000; return new Date(t).toISOString(); };
}

/** Resumo no formato de projectStore.list(). */
function summary(overrides = {}) {
  const { source, meta, ...rest } = overrides;
  return {
    id: `p${++seq}`,
    source: { path: 'D:\\Lives\\antiga.mp4', size: 1000000, duration: 3600, origin: null, ...(source || {}) },
    meta: { game: '', channel: '', ...(meta || {}) },
    cutCount: 5,
    counts: { pending: 5, approved: 0, rejected: 0 },
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...rest
  };
}

/** ctx de verdade (createContext + Electron falso) com todos os handlers carregados; `call(canal, payload)` chama o handler. */
function setupMain(opts = {}) {
  const dir = mkTmp('prefs-main');
  if (opts.beforeCreate) opts.beforeCreate(dir);
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => dir, getVersion: () => '9.9.9' },
    dialog: {}, shell: {}, getWindow: () => win, logger: silent,
    resolveTools: () => ({ ffmpeg: real.ffmpeg, ffprobe: real.ffprobe, ...opts.tools })
  };
  const ctx = createContext(deps);
  const loaded = loadHandlers(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { dir, ctx, loaded, call, handlers, sent };
}

/** Vídeo real de teste (testsrc2 + tom) com o ffmpeg do sistema. */
function makeVideo(file, seconds, size = '160x90') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=5:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
}

/** Cria e grava, no projectStore do ctx, um projeto com cortes para `file`. */
function saveProject(ctx, file, { cuts = [], origin = null, meta, chat, ext } = {}) {
  const format = JSON.parse(execFileSync(real.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', file], { encoding: 'utf8' })).format;
  const project = newProject(file, { size: Number(format.size), duration: Number(format.duration), width: 160, height: 90 }, origin);
  project.cuts = cuts.map((c, i) => model.newCut({ title: `Corte ${i + 1}`, ...c }, { index: i }));
  if (meta) project.meta = { ...project.meta, ...meta };
  if (chat) project.chat = chat;
  if (ext) project.ext = ext;
  return ctx.projectStore.save(project);
}

module.exports = { mkTmp, rm, cutState, cutsOf, clock, summary, setupMain, makeVideo, saveProject, real, skipMedia };
