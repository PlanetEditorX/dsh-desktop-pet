/**
 * dsh-desktop-pet — host half.
 *
 * A desktop pet for DeepSeek Harness:
 *  - watches session events and keeps the "current task" + today's token usage
 *  - a satiety state machine: token consumption / trashed files feed the pet,
 *    satiety decays over time, she gets hungry and finally collapses, and
 *    recovers (stands back up) when fed again
 *  - `pet.trash` moves dropped files/folders to the OS recycle bin
 *    (Electron shell.trashItem when available, PowerShell RecycleBin otherwise)
 *  - weather polling (Open-Meteo, no key) drives the accessory shown in the UI
 *
 * All state lives in `<DSH_HOME>/desktop-pet/` (config.json + state.json).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const CHANNEL = '/desktop-pet';

// ---------------------------------------------------------------------------
// Paths & files
// ---------------------------------------------------------------------------

export function dataDir() {
  return join(os.homedir(), '.dsh', 'desktop-pet');
}

function configPath() {
  return join(dataDir(), 'config.json');
}

function statePath() {
  return join(dataDir(), 'state.json');
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  satiety: {
    max: 100,
    start: 60,
    decayPerMin: 0.2,
    hungryBelow: 25,
    collapsedBelow: 5,
    collapseDelayMin: 8,
    tokensPerPoint: 300000, // +1 饱腹 / 每 30 万 billed tokens
    filePoint: 12,          // +12 饱腹 / 每个拖入的垃圾文件
  },
  bubble: {
    enabled: true,
    ms: 10000, // 任务气泡自动隐藏时长（毫秒）
  },
  mobile: {
    hide: true, // 手机/移动端不显示宠物
  },
  weather: {
    enabled: true,
    auto: true, // IP 定位
    lat: null,
    lon: null,
    city: '',
  },
  pollMs: 15000,
};

function num(value, def) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : def;
}

/** Merge a raw config object over the defaults, sanitizing numbers. */
export function normalizeConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const s = base.satiety && typeof base.satiety === 'object' ? base.satiety : {};
  const b = base.bubble && typeof base.bubble === 'object' ? base.bubble : {};
  const w = base.weather && typeof base.weather === 'object' ? base.weather : {};
  return {
    version: 1,
    enabled: base.enabled !== false,
    satiety: {
      max: num(s.max, DEFAULT_CONFIG.satiety.max),
      start: num(s.start, DEFAULT_CONFIG.satiety.start),
      decayPerMin: num(s.decayPerMin, DEFAULT_CONFIG.satiety.decayPerMin),
      hungryBelow: num(s.hungryBelow, DEFAULT_CONFIG.satiety.hungryBelow),
      collapsedBelow: num(s.collapsedBelow, DEFAULT_CONFIG.satiety.collapsedBelow),
      collapseDelayMin: num(s.collapseDelayMin, DEFAULT_CONFIG.satiety.collapseDelayMin),
      tokensPerPoint: num(s.tokensPerPoint, DEFAULT_CONFIG.satiety.tokensPerPoint),
      filePoint: num(s.filePoint, DEFAULT_CONFIG.satiety.filePoint),
    },
    bubble: {
      enabled: b.enabled !== false,
      ms: num(b.ms, DEFAULT_CONFIG.bubble.ms),
    },
    mobile: {
      hide: base.mobile && base.mobile.hide === false ? false : true,
    },
    weather: {
      enabled: w.enabled !== false,
      auto: w.auto !== false,
      lat: typeof w.lat === 'number' && Number.isFinite(w.lat) ? w.lat : null,
      lon: typeof w.lon === 'number' && Number.isFinite(w.lon) ? w.lon : null,
      city: typeof w.city === 'string' ? w.city.slice(0, 80) : '',
    },
    pollMs: num(base.pollMs, DEFAULT_CONFIG.pollMs),
  };
}

export function loadConfig() {
  return normalizeConfig(readJson(configPath(), null));
}

export function saveConfig(config) {
  writeJson(configPath(), normalizeConfig(config));
}

// ---------------------------------------------------------------------------
// State & satiety state machine
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    version: 1,
    date: null,
    todayTokens: 0,
    todayCalls: 0,
    trashCount: 0,
    satiety: null,
    satietyUpdatedAt: null,
    hungrySince: null,
    collapsedAt: null,
    lastTask: null,
    sessionTitle: null, // 最近活跃会话标题（来自 session/title 事件）
    progress: null,     // 最近活跃会话的进度状态（内存态为主，随 state 落盘）
    weather: null,
  };
}

function loadState() {
  const raw = readJson(statePath(), null);
  if (!raw || typeof raw !== 'object') return emptyState();
  return {
    ...emptyState(),
    ...raw,
    lastTask: raw.lastTask && typeof raw.lastTask === 'object' ? raw.lastTask : null,
    weather: raw.weather && typeof raw.weather === 'object' ? raw.weather : null,
  };
}

function saveState(state) {
  writeJson(statePath(), state);
}

export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Reset the daily counters when the local date rolls over. */
export function rollDay(state, now = new Date()) {
  const key = todayKey(now);
  if (state.date !== key) {
    state.date = key;
    state.todayTokens = 0;
    state.todayCalls = 0;
  }
}

/** Lazily apply satiety decay since the last update. */
export function decaySatiety(state, config, now = Date.now()) {
  const sat = config.satiety;
  if (typeof state.satiety !== 'number' || state.satietyUpdatedAt == null) return state.satiety;
  const elapsedMin = Math.max(0, (now - state.satietyUpdatedAt) / 60000);
  if (elapsedMin <= 0) return state.satiety;
  const next = Math.max(0, state.satiety - elapsedMin * sat.decayPerMin);
  state.satiety = next;
  state.satietyUpdatedAt = now;
  return next;
}

/** Feed the pet by a number of satiety points (tokens / trashed files). */
export function gainSatiety(state, config, points, now = Date.now()) {
  const sat = config.satiety;
  if (typeof state.satiety !== 'number') state.satiety = sat.start;
  const before = state.satiety;
  state.satiety = Math.min(sat.max, state.satiety + Math.max(0, points));
  state.satietyUpdatedAt = now;
  // 回升到正常区间：解除饥饿/趴下计时。
  if (state.satiety >= sat.hungryBelow) {
    state.hungrySince = null;
    state.collapsedAt = null;
  } else if (state.satiety >= sat.collapsedBelow) {
    state.collapsedAt = null;
  }
  return before !== state.satiety;
}

/**
 * Current satiety phase:
 *  - 'ok'        satiety >= hungryBelow
 *  - 'hungry'    below hungryBelow (or below collapsedBelow but the collapse
 *                delay hasn't elapsed yet)
 *  - 'collapsed' below collapsedBelow AND hungry for longer than
 *                collapseDelayMin — the pet is lying down.
 */
export function phaseOf(state, config, now = Date.now()) {
  const sat = config.satiety;
  const value = typeof state.satiety === 'number' ? state.satiety : sat.start;
  if (value >= sat.hungryBelow) return 'ok';
  if (state.hungrySince == null) state.hungrySince = now;
  if (value < sat.collapsedBelow) {
    const hungryMs = now - state.hungrySince;
    if (hungryMs >= sat.collapseDelayMin * 60000) return 'collapsed';
  }
  return 'hungry';
}

/** Reset satiety to the configured start value (used on first activation). */
export function initSatiety(state, config, now = Date.now()) {
  if (typeof state.satiety !== 'number') {
    state.satiety = config.satiety.start;
    state.satietyUpdatedAt = now;
  }
}

// ---------------------------------------------------------------------------
// Session event folding (current task + today's usage)
// ---------------------------------------------------------------------------

function usageOf(event) {
  return event && event.data && event.data.usage && typeof event.data.usage === 'object'
    ? event.data.usage
    : null;
}

function configOf(event) {
  return event && event.data && event.data.header && event.data.header.config
    ? event.data.header.config
    : null;
}

/**
 * Fold one session event into the pet state. Returns true when the state was
 * touched (new task / new usage), false when the event is irrelevant.
 */
function sessionTitleOf(session) {
  if (!session || typeof session !== 'object') return null;
  const candidates = [
    session.title,
    session.name,
    session.label,
    session.meta && session.meta.title,
    session.header && session.header.title,
    session.header && session.header.name,
    session.conversation && session.conversation.title,
    session.data && session.data.title,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 60);
  }
  return null;
}

// 首次会话事件时把 session 字段写入调试文件，便于确认标题来源
// （探测已完成：session.header 无标题字段，标题来自 session/title 事件）
function writeSessionDebug(session) { /* no-op，探测完毕移除 */ }

export function applyPetEvent(state, config, session, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return false;
  const type = event.type;
  const title = sessionTitleOf(session) || (typeof state.sessionTitle === 'string' && state.sessionTitle ? state.sessionTitle : null);
  if (type === 'request/header') {
    const cfg = configOf(event);
    if (!cfg) return false;
    state.lastTask = {
      provider: typeof cfg.provider === 'string' ? cfg.provider : null,
      model: typeof cfg.model === 'string' ? cfg.model : null,
      title,
      kind: 'request',
      at: now,
    };
    return true;
  }
  if (type === 'assistant/message') {
    const usage = usageOf(event);
    if (!usage) return false;
    const billed = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    state.lastTask = {
      provider: (state.lastTask && state.lastTask.provider) || null,
      model: (state.lastTask && state.lastTask.model) || null,
      title: title || (state.lastTask && state.lastTask.title) || null,
      kind: 'reply',
      tokens: billed,
      at: now,
    };
    state.todayTokens += billed;
    state.todayCalls += 1;
    if (billed > 0 && config.satiety.tokensPerPoint > 0) {
      gainSatiety(state, config, billed / config.satiety.tokensPerPoint, now);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 会话标题 + 回答进度（轻量借鉴 dsh-answer-pet 的事件契约）
// ---------------------------------------------------------------------------

const PROGRESS_IDLE_MS = 120000; // 2 分钟无事件视为回到待命
const PHASE_LABELS = {
  turn: '开始处理',
  think: '思考中',
  stream: '回答中',
  tool: '使用工具',
  done: '完成',
  error: '出错',
};

function emptyProgress() {
  return {
    phase: null,
    startedAt: null,
    outTokens: null,
    estTokens: 0,
    toolName: null,
    toolCount: 0,
    pct: 0,
    lastActiveAt: 0,
  };
}

// 从会话事件日志折叠标题（seed 时不派发 session/title 事件，只能读日志）
export function foldSessionTitle(events) {
  let title = null;
  if (Array.isArray(events)) {
    for (const e of events) {
      if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title.trim()) {
        title = e.data.title.trim().slice(0, 60);
      }
    }
  }
  return title;
}

// 把一条会话事件应用到进度状态（原地修改；非进度事件不改动）
export function applyProgressEvent(state, event, now = Date.now()) {
  const type = event && event.type;
  if (!type) return;
  const data = (event && event.data) || {};
  let p = state.progress;
  if (!p || (type === 'turn/start')) {
    p = emptyProgress();
    state.progress = p;
  }
  p.lastActiveAt = now;
  switch (type) {
    case 'turn/start': {
      p.phase = 'turn';
      p.startedAt = now;
      p.step = null;
      p.toolName = null;
      p.toolCount = 0;
      p.estTokens = 0;
      p.outTokens = null;
      p.pct = 0;
      break;
    }
    case 'step/start': {
      p.phase = 'think';
      p.toolName = null;
      break;
    }
    case 'assistant/chunk': {
      const chunk = (data && data.chunk) || {};
      const ct = chunk.type;
      if (ct === 'text-delta' && typeof chunk.text === 'string') {
        p.estTokens += Math.round(chunk.text.length / 4);
      }
      if (ct === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
        p.outTokens = chunk.usage.outputTokens;
      }
      if (p.phase === 'think' || p.phase === 'turn') p.phase = 'stream';
      break;
    }
    case 'tool/call': {
      p.phase = 'tool';
      if (typeof data.name === 'string') p.toolName = data.name;
      p.toolCount += 1;
      break;
    }
    case 'tool/result': {
      if (p.phase === 'tool') p.phase = 'stream';
      p.toolName = null;
      break;
    }
    case 'step/end': {
      if (p.phase !== 'tool') p.phase = 'think';
      break;
    }
    case 'turn/end': {
      p.phase = 'done';
      p.endedAt = now;
      break;
    }
    default:
      break;
  }
}

// 派生进度视图（供 snapshot 下发；不活跃返回 null）
export function progressView(state, now = Date.now()) {
  const p = state.progress;
  if (!p || !p.phase) return null;
  const age = now - p.lastActiveAt;
  if (p.phase === 'done') {
    if (age > 60000) return null; // 完成态保留 60s 展示窗口
    return { phase: 'done', label: '完成', pct: 100, toolName: null, toolCount: p.toolCount || 0, outTokens: p.outTokens != null ? p.outTokens : p.estTokens, elapsedMs: p.startedAt ? now - p.startedAt : 0 };
  }
  if (age > PROGRESS_IDLE_MS) return null;
  let target;
  switch (p.phase) {
    case 'turn': target = 2; break;
    case 'think': target = Math.min(10, 5 + Math.max(0, now - p.startedAt) / 2000); break;
    case 'stream': {
      const out = p.outTokens != null ? p.outTokens : p.estTokens;
      target = 10 + 80 * Math.min(1, 1 - Math.exp(-out / 600));
      break;
    }
    case 'tool': target = p.pct || 10; break;
    default: target = p.pct || 0;
  }
  p.pct = Math.max(p.pct || 0, target);
  return {
    phase: p.phase,
    label: PHASE_LABELS[p.phase] || p.phase,
    pct: Math.round(p.pct * 10) / 10,
    toolName: p.toolName,
    toolCount: p.toolCount || 0,
    outTokens: p.outTokens != null ? p.outTokens : p.estTokens,
    elapsedMs: p.startedAt ? now - p.startedAt : 0,
  };
}

// ---------------------------------------------------------------------------
// Snapshot for the client
// ---------------------------------------------------------------------------

export function snapshot(state, config, now = Date.now()) {
  rollDay(state, new Date(now));
  decaySatiety(state, config, now);
  const phase = phaseOf(state, config, now);
  const sat = config.satiety;
  return {
    enabled: config.enabled,
    now,
    today: {
      date: state.date,
      tokens: state.todayTokens,
      calls: state.todayCalls,
    },
    satiety: {
      value: typeof state.satiety === 'number' ? state.satiety : sat.start,
      phase,
      max: sat.max,
    },
    task: state.lastTask,
    sessionTitle: typeof state.sessionTitle === 'string' && state.sessionTitle ? state.sessionTitle : null,
    progress: progressView(state, now),
    trashCount: state.trashCount,
    weather: state.weather,
    windowOpen: petWindowOpen(),
    petPos: state.petPos && Number.isFinite(state.petPos.x) && Number.isFinite(state.petPos.y) ? state.petPos : null,
    windowRect: state.windowRect && [state.windowRect.x, state.windowRect.y, state.windowRect.width, state.windowRect.height].every(Number.isFinite) ? state.windowRect : null,
    desktop: desktopState(),
    config: {
      bubble: config.bubble,
      mobile: config.mobile,
      pollMs: config.pollMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Recycle-bin trash (Electron first, PowerShell fallback)
// ---------------------------------------------------------------------------

/** Validate incoming dropped paths; returns { valid, invalid }. */
export function prepareTrash(paths) {
  const valid = [];
  const invalid = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || p === '' || !isAbsolute(p)) {
      invalid.push({ path: String(p), reason: '非绝对路径' });
      continue;
    }
    if (!existsSync(p)) {
      invalid.push({ path: p, reason: '文件不存在' });
      continue;
    }
    valid.push(p);
  }
  return { valid, invalid };
}

function psQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

function runPowershell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || '') });
      },
    );
  });
}

async function trashWithElectron(paths) {
  try {
    const { shell } = await import('electron');
    for (const p of paths) {
      await shell.trashItem(p);
    }
    return true;
  } catch {
    return false;
  }
}

async function trashWithPowerShell(paths) {
  const lines = [];
  for (const p of paths) {
    const isDir = existsSync(p) && statSync(p).isDirectory();
    const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
    lines.push(
      `try { [Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${psQuote(p)}, 'OnlyErrorDialogs', 'SendToRecycleBin'); 'OK' } catch { 'ERR: ' + $_.Exception.Message }`,
    );
  }
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; ${lines.join('; ')}`;
  const { stdout } = await runPowershell(script);
  const results = stdout.split(/\r?\n/).filter(Boolean);
  return paths.map((p, i) => {
    const line = results[i] || 'ERR: no output';
    if (line === 'OK') return { ok: true, path: p };
    return { ok: false, path: p, reason: line.replace(/^ERR:\s*/, '') };
  });
}

/**
 * Move dropped files/folders to the OS recycle bin. Returns
 * { trashed, failed } where failed entries carry { path, reason }.
 */
export async function trashPaths(paths, config) {
  const { valid, invalid } = prepareTrash(paths);
  const failed = invalid.map((f) => ({ path: f.path, reason: f.reason }));
  const trashed = [];
  if (valid.length > 0) {
    if (!(await trashWithElectron(valid))) {
      const results = await trashWithPowerShell(valid);
      for (const r of results) {
        if (r.ok) trashed.push(r.path);
        else failed.push({ path: r.path, reason: r.reason });
      }
    } else {
      trashed.push(...valid);
    }
  }
  return { trashed, failed };
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, no API key)
// ---------------------------------------------------------------------------

const WMO = [
  { codes: [0], desc: '晴', accessory: 'clear' },
  { codes: [1, 2], desc: '少云', accessory: 'sun' },
  { codes: [3], desc: '多云', accessory: 'cloud' },
  { codes: [45, 48], desc: '雾', accessory: 'fog' },
  { codes: [51, 53, 55, 56, 57], desc: '毛毛雨', accessory: 'rain' },
  { codes: [61, 63, 65, 66, 67], desc: '雨', accessory: 'rain' },
  { codes: [71, 73, 75, 77], desc: '雪', accessory: 'snow' },
  { codes: [80, 81, 82], desc: '阵雨', accessory: 'rain' },
  { codes: [85, 86], desc: '阵雪', accessory: 'snow' },
  { codes: [95, 96, 99], desc: '雷暴', accessory: 'storm' },
];

export function weatherCodeInfo(code) {
  const n = Number(code);
  const row = WMO.find((r) => r.codes.includes(n));
  return row ? { desc: row.desc, accessory: row.accessory } : { desc: '未知', accessory: null };
}

async function geoByIp() {
  const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const body = await res.json();
  const lat = Number(body.latitude);
  const lon = Number(body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, city: String(body.city || '') };
}

async function geoByCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const body = await res.json();
  const hit = Array.isArray(body.results) && body.results[0];
  if (!hit) return null;
  return { lat: Number(hit.latitude), lon: Number(hit.longitude), city };
}

/** Fetch current weather (cached 30 min inside `state.weather`). */
export async function refreshWeather(state, config, now = Date.now()) {
  if (!config.weather.enabled) {
    state.weather = null;
    return null;
  }
  const cached = state.weather;
  if (cached && typeof cached.fetchedAt === 'number' && now - cached.fetchedAt < 30 * 60000) {
    return cached;
  }
  let geo = null;
  try {
    if (config.weather.lat != null && config.weather.lon != null) {
      geo = { lat: config.weather.lat, lon: config.weather.lon, city: config.weather.city };
    } else if (config.weather.auto && config.weather.city) {
      geo = await geoByCity(config.weather.city);
    } else if (config.weather.auto) {
      geo = await geoByIp();
    }
    if (!geo) {
      state.weather = { error: '无法定位（可在设置中填写城市）', fetchedAt: now };
      return state.weather;
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const current = body.current || {};
    const code = Number(current.weather_code);
    const info = weatherCodeInfo(code);
    state.weather = {
      code,
      desc: info.desc,
      accessory: info.accessory,
      temp: typeof current.temperature_2m === 'number' ? current.temperature_2m : null,
      city: geo.city || '',
      fetchedAt: now,
    };
  } catch (err) {
    state.weather = { error: String(err && err.message ? err.message : err).slice(0, 120), fetchedAt: now };
  }
  return state.weather;
}

// ---------------------------------------------------------------------------
// Pet assets (webp artwork served to the client as base64)
// ---------------------------------------------------------------------------

function webpSize(buf) {
  let p = 12;
  while (p + 8 <= buf.length) {
    const tag = buf.toString('latin1', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (tag === 'VP8X' && p + 24 <= buf.length) {
      return { width: 1 + buf.readUIntLE(p + 12, 3), height: 1 + buf.readUIntLE(p + 15, 3) };
    }
    p += 8 + sz;
  }
  return null;
}

function assetsDir() {
  return join(join(fileURLToPath(import.meta.url), '..', '..'), 'assets');
}

/** Read one artwork from the bundle's assets/ dir as base64 (for the web client). */
export function assetBase64(name) {
  const safe = /^[a-z0-9-]+$/.test(String(name || '')) ? String(name) : 'left';
  const p = join(assetsDir(), `${safe}.webp`);
  if (!existsSync(p)) return { ok: false, error: `缺少资源 ${safe}.webp` };
  const buf = readFileSync(p);
  const size = webpSize(buf) || { width: null, height: null };
  return { ok: true, name: safe, mime: 'image/webp', base64: buf.toString('base64'), width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// Floating pet window (Electron desktop only)
// ---------------------------------------------------------------------------

let petWindow = null;
let petWindowTimer = null;
let petIpcRegistered = false;
let electronCache = null;

async function getElectron() {
  if (electronCache !== null) return electronCache;
  try {
    electronCache = await import('electron');
  } catch {
    electronCache = false;
  }
  return electronCache;
}

const PRELOAD_SRC = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petBridge', {
  trash: (paths) => ipcRenderer.invoke('pet:trash', paths),
  close: () => ipcRenderer.send('pet:close'),
  onUpdate: (cb) => ipcRenderer.on('pet:update', (_e, d) => cb(d)),
});`;

function preloadPath() {
  return join(dataDir(), 'preload.cjs');
}

function ensurePreload() {
  const p = preloadPath();
  try {
    if (!existsSync(p) || readFileSync(p, 'utf8') !== PRELOAD_SRC) {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(p, PRELOAD_SRC, 'utf8');
    }
  } catch { /* 忽略写入失败，窗口仍可打开但无 IPC */ }
}

function windowHtml(holder) {
  const asset = assetBase64('left');
  const snap = snapshot(holder.state, holder.config);
  const phase = snap.satiety && snap.satiety.phase ? snap.satiety.phase : 'ok';
  const imgSrc = asset.ok ? `data:${asset.mime};base64,${asset.base64}` : '';
  const who = snap.task ? [snap.task.provider, snap.task.model].filter(Boolean).join(' / ') : '';
  const bubble = snap.task
    ? (snap.task.kind === 'reply' ? `${who} 回复 +${fmtTokens(snap.task.tokens)} tokens` : `正在执行 · ${who}`)
    : 'Hello～ 鲸鱼娘待命中';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
body{width:100vw;height:100vh;display:flex;flex-direction:column;align-items:center}
#pet{width:168px;height:auto;margin-top:26px;filter:drop-shadow(0 4px 12px rgba(30,64,175,.35));transition:transform 1s ease;animation:breathe 3.4s ease-in-out infinite}
body.hungry #pet{animation:slouch 3.4s ease-in-out infinite}
body.collapsed #pet{transform:rotate(90deg) translateY(4px) scale(.88);animation:none}
@keyframes breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes slouch{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}
#bubble{position:fixed;top:4px;left:8px;right:8px;background:rgba(255,255,255,.96);border:1.5px solid #93c5fd;border-radius:10px;padding:6px 9px;font-size:11px;line-height:16px;color:#1e3a8a;display:none;box-shadow:0 4px 14px rgba(37,99,235,.28);-webkit-app-region:no-drag}
#sat{position:fixed;top:0;left:8px;width:64px;height:5px;border-radius:99px;background:rgba(226,232,240,.92);overflow:hidden;-webkit-app-region:no-drag}
#sat>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#34d399,#3b82f6);transition:width .6s ease}
#bar{position:fixed;bottom:6px;left:6px;right:6px;height:32px;border-radius:10px;background:rgba(30,58,138,.85);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;-webkit-app-region:no-drag;transition:background .25s}
#close{position:fixed;top:5px;right:6px;width:19px;height:19px;border-radius:50%;background:rgba(239,68,68,.88);color:#fff;font-size:11px;line-height:19px;text-align:center;cursor:pointer;-webkit-app-region:no-drag;box-shadow:0 2px 6px rgba(0,0,0,.25)}
</style></head><body class="${phase}">
<img id="pet" src="${imgSrc}" draggable="false">
<div id="bubble"></div>
<div id="sat"><i id="fill"></i></div>
<div id="bar">🗑️ 拖文件到这里吃掉</div>
<div id="close" onclick="petBridge.close()">✕</div>
<script>
const bubble=document.getElementById('bubble'),bar=document.getElementById('bar'),fill=document.getElementById('fill');
let hideTimer=null;
function showBubble(t,ms){bubble.textContent=t;bubble.style.display='block';if(hideTimer)clearTimeout(hideTimer);hideTimer=setTimeout(function(){bubble.style.display='none'},ms||4000)}
function fmt(n){n=Number(n)||0;return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(Math.round(n))}
petBridge.onUpdate(function(d){if(!d)return;document.body.className=(d.satiety&&d.satiety.phase)||'ok';if(d.satiety)fill.style.width=Math.max(0,Math.min(100,d.satiety.value))+'%';if(d.task&&d.task.at){var who=[d.task.provider,d.task.model].filter(Boolean).join(' / ');var txt=d.task.kind==='reply'?(who+' 回复 +'+fmt(d.task.tokens)+' tokens'):('正在执行 · '+who);showBubble(txt)}});
let inDrag=false;
bar.addEventListener('dragover',function(e){e.preventDefault();inDrag=true;bar.textContent='啊呜——张嘴！';bar.style.background='rgba(220,38,38,.9)'});
bar.addEventListener('dragleave',function(){inDrag=false;bar.textContent='🗑️ 拖文件到这里吃掉';bar.style.background='rgba(30,58,138,.85)'});
bar.addEventListener('drop',async function(e){e.preventDefault();inDrag=false;bar.textContent='🗑️ 拖文件到这里吃掉';bar.style.background='rgba(30,58,138,.85)';const files=Array.from(e.dataTransfer.files||[]);const paths=files.map(function(f){return typeof f.path==='string'&&f.path?f.path:''}).filter(Boolean);if(!paths.length){showBubble('请从资源管理器拖动文件',3500);return}const r=await petBridge.trash(paths);const n=r&&r.ok===true?(r.value.trashed||[]).length:0;const failed=r&&r.value&&r.value.failed?r.value.failed:[];showBubble(n>0?('啊呜～吃掉 '+n+' 个（已回收）'+(failed.length?'，'+failed.length+' 个失败':'')):(failed[0]?('没能吃到：'+failed[0].reason):'回收失败'),5000)});
showBubble('${bubble.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c')}', 4000);
</script></body></html>`;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function defaultWindowPos(screen) {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - 210, y: wa.y + wa.height - 290 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function registerPetIpc(holder, ipcMain) {
  if (petIpcRegistered) return;
  petIpcRegistered = true;
  ipcMain.handle('pet:trash', async (_e, paths) => {
    try {
      return await trashPaths(paths || [], holder.config);
    } catch (err) {
      return { trashed: [], failed: [{ path: '', reason: String(err && err.message ? err.message : err) }] };
    }
  });
  ipcMain.on('pet:close', () => closePetWindow());
}

export function petWindowOpen() {
  return !!(petWindow && !petWindow.isDestroyed());
}

function closePetWindow() {
  try {
    if (petWindow && !petWindow.isDestroyed()) petWindow.close();
  } catch { /* ignore */ }
}

function broadcastPetState(holder) {
  try {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:update', snapshot(holder.state, holder.config));
    }
  } catch { /* ignore */ }
}

async function openPetWindow(holder) {
  const electron = await getElectron();
  if (!electron || !electron.BrowserWindow) {
    return { ok: false, error: 'Electron 不可用：独立窗口仅桌面版 DeepSeek Harness 支持' };
  }
  if (petWindow && !petWindow.isDestroyed()) return { ok: true, already: true };
  ensurePreload();
  const { BrowserWindow, screen, ipcMain } = electron;
  registerPetIpc(holder, ipcMain);
  const pos = holder.state.windowPos && Number.isFinite(holder.state.windowPos.x)
    ? holder.state.windowPos
    : defaultWindowPos(screen);
  const win = new BrowserWindow({
    width: 190,
    height: 262,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(windowHtml(holder))}`);
  win.on('moved', () => {
    try {
      const b = win.getBounds();
      holder.state.windowPos = { x: b.x, y: b.y };
      saveState(holder.state);
    } catch { /* ignore */ }
  });
  win.on('closed', () => {
    if (petWindowTimer) { clearInterval(petWindowTimer); petWindowTimer = null; }
    petWindow = null;
  });
  petWindow = win;
  petWindowTimer = setInterval(() => broadcastPetState(holder), 15000);
  return { ok: true, already: false };
}

// ---------------------------------------------------------------------------
// RPC handler
// ---------------------------------------------------------------------------

function ok(value) {
  return { ok: true, value };
}

function error(code, message) {
  return { ok: false, error: { code, message } };
}

export function createHandler(deps = {}) {
  const holder = deps.holder; // { config, state } live object
  // 持久化可注入（测试传 no-op，避免污染真实数据目录）
  const persistConfig = deps.saveConfig || saveConfig;
  const persistState = deps.saveState || saveState;
  return async (endpoint, payload) => {
    try {
      const config = holder.config;
      const state = holder.state;
      switch (endpoint) {
        case 'pet.state': {
          if (state.weather && state.weather.fetchedAt && Date.now() - state.weather.fetchedAt > 30 * 60000) {
            await refreshWeather(state, config).catch(() => {});
          }
          return ok(snapshot(state, config));
        }
        case 'pet.config.get':
          return ok({ config: normalizeConfig(config) });
        case 'pet.config.update': {
          const next = normalizeConfig({ ...config, ...(payload && typeof payload === 'object' ? payload : {}) });
          persistConfig(next);
          holder.config = next;
          return ok({ config: normalizeConfig(next) });
        }
        case 'pet.trash': {
          const paths = payload && Array.isArray(payload.paths) ? payload.paths : [];
          if (paths.length === 0) return error('bad-request', '没有可回收的文件');
          const result = await trashPaths(paths, config);
          const count = result.trashed.length;
          if (count > 0) {
            state.trashCount += count;
            if (config.satiety.filePoint > 0) gainSatiety(state, config, count * config.satiety.filePoint);
            persistState(state);
          }
          return ok(result);
        }
        case 'pet.weather.refresh': {
          await refreshWeather(state, config);
          persistState(state);
          return ok({ weather: state.weather });
        }
        case 'pet.asset': {
          const name = payload && payload.name ? payload.name : 'left';
          const a = assetBase64(name);
          // RPC 框架会把 handler 返回值包进 value，与其它端点一致用 ok() 包装
          return a.ok ? ok(a) : a;
        }
        case 'pet.window.open': {
          const r = await openPetWindow(holder);
          return r.ok ? ok({ already: r.already }) : r;
        }
        case 'pet.window.close': {
          closePetWindow();
          return ok({ closed: true });
        }
        case 'pet.window.state':
          return ok({ open: petWindowOpen() });
        case 'pet.window.debug': {
          const electron = await getElectron();
          return ok({
            electronAvailable: !!electron,
            hasBrowserWindow: !!(electron && electron.BrowserWindow),
            processType: process && process.type ? process.type : 'node',
            platform: process && process.platform ? process.platform : null,
            versions: process && process.versions ? { node: process.versions.node, electron: process.versions.electron || null } : null,
          });
        }
        case 'pet.pos.update': {
          const x = payload && payload.x;
          const y = payload && payload.y;
          if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
            return error('bad-request', '位置必须是数字');
          }
          state.petPos = { x: Math.round(x), y: Math.round(y) };
          persistState(state);
          return ok({ x: state.petPos.x, y: state.petPos.y });
        }
        case 'pet.desktop.start': {
          const r = startDesktopPet({ port: payload && payload.port });
          return r.ok ? ok({ pid: r.pid, already: !!r.already }) : error('desktop-unavailable', r.reason);
        }
        case 'pet.desktop.stop':
          return ok(stopDesktopPet());
        case 'pet.desktop.state':
          return ok(desktopState());
        case 'pet.window.rect': {
          // client 上报主窗口屏幕矩形（供 PowerShell 窗口「拖回自动收回」判定）
          const p = payload || {};
          const x = Number(p.x);
          const y = Number(p.y);
          const w = Number(p.width);
          const h = Number(p.height);
          if (![x, y, w, h].every((v) => Number.isFinite(v) && v >= 0)) {
            return error('bad-request', '矩形参数必须是有限数字');
          }
          state.windowRect = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
          persistState(state);
          return ok(state.windowRect);
        }
        default:
          return error('unknown-endpoint', `未知端点 ${endpoint}`);
      }
    } catch (err) {
      return error('internal', String(err && err.message ? err.message : err));
    }
  };
}

// ---------------------------------------------------------------------------
// 独立桌面窗口（PowerShell WPF 原型）
// 背景：bundle host 运行在 ELECTRON_RUN_AS_NODE=1 的纯 Node 子进程，无
// Electron API（BrowserWindow 不可用），宠物只能活在 Web 页面内。作为替代，
// 桌面版（DSH_DESKTOP=1）下 spawn 一个 PowerShell WPF 透明置顶窗口显示宠物，
// 通过 GET /desktop-pet/state 轮询宿主状态。
// ---------------------------------------------------------------------------

const PET_WINDOW_PS1 = [
  "param([int]$Port = 2881, [string]$ImagePath = '')",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName PresentationFramework",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "",
  "$logPath = Join-Path $env:USERPROFILE '.dsh\\desktop-pet\\pet-window.log'",
  "try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' start port=' + $Port) } catch { }",
  "",
  "$stateUrl = 'http://127.0.0.1:' + $Port + '/desktop-pet/state'",
  "",
  "$win = New-Object System.Windows.Window",
  "$win.WindowStyle = 'None'",
  "$win.AllowsTransparency = $true",
  "$win.Background = [System.Windows.Media.Brushes]::Transparent",
  "$win.Topmost = $true",
  "$win.ShowInTaskbar = $false",
  "$win.ResizeMode = 'NoResize'",
  "$win.Width = 152",
  "$win.Height = 194",
  "$sw = [System.Windows.SystemParameters]::PrimaryScreenWidth",
  "$sh = [System.Windows.SystemParameters]::PrimaryScreenHeight",
  "$win.Left = $sw - 174",
  "$win.Top = $sh - 214",
  "",
  "$grid = New-Object System.Windows.Controls.Grid",
  "$grid.Background = [System.Windows.Media.Brushes]::Transparent",
  "",
  "# 图片卡片（半透明白底圆角，保证窗口轮廓可见）",
  "$card = New-Object System.Windows.Controls.Border",
  "$card.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(235,255,255,255))",
  "$card.CornerRadius = New-Object System.Windows.CornerRadius(12)",
  "$card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(120,147,197,253))",
  "$card.BorderThickness = New-Object System.Windows.Thickness(1)",
  "$card.Width = 140",
  "$card.Height = 108",
  "$card.HorizontalAlignment = 'Center'",
  "$card.VerticalAlignment = 'Top'",
  "$card.Margin = '4,4,4,0'",
  "",
  "$img = New-Object System.Windows.Controls.Image",
  "$img.Width = 130",
  "$img.Height = 100",
  "$img.HorizontalAlignment = 'Center'",
  "$img.VerticalAlignment = 'Center'",
  "$img.Stretch = 'UniformToFill'",
  "",
  "$emoji = New-Object System.Windows.Controls.TextBlock",
  "$emoji.Text = '🐋'",
  "$emoji.FontSize = 64",
  "$emoji.HorizontalAlignment = 'Center'",
  "$emoji.VerticalAlignment = 'Center'",
  "$emoji.Visibility = 'Collapsed'",
  "",
  "if ($ImagePath -ne '' -and (Test-Path $ImagePath)) {",
  "  try {",
  "    $bi = New-Object System.Windows.Media.Imaging.BitmapImage",
  "    $bi.BeginInit()",
  "    $bi.UriSource = New-Object System.Uri($ImagePath)",
  "    $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad",
  "    $bi.EndInit()",
  "    $w = $bi.PixelWidth",
  "    $h = $bi.PixelHeight",
  "    # 全身竖图裁顶部约 36%（脸部特写），否则 Uniform 缩放成细长条看不清",
  "    $cropH = [Math]::Round($h * 0.36)",
  "    $crop = New-Object System.Windows.Media.Imaging.CroppedBitmap($bi, [System.Windows.Int32Rect]::new(0, 0, $w, $cropH))",
  "    $img.Source = $crop",
  "    try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' image ok ' + $w + 'x' + $h) } catch { }",
  "  } catch {",
  "    try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' image fail: ' + $_.Exception.Message) } catch { }",
  "    $img.Visibility = 'Collapsed'",
  "    $emoji.Visibility = 'Visible'",
  "  }",
  "} else {",
  "  $img.Visibility = 'Collapsed'",
  "  $emoji.Visibility = 'Visible'",
  "}",
  "",
  "$card.Child = $grid2 = New-Object System.Windows.Controls.Grid",
  "$grid2.Children.Add($img) | Out-Null",
  "$grid2.Children.Add($emoji) | Out-Null",
  "",
  "$txt = New-Object System.Windows.Controls.TextBlock",
  "$txt.Text = '连接中…'",
  "$txt.FontSize = 11",
  "$txt.Foreground = [System.Windows.Media.Brushes]::RoyalBlue",
  "$txt.TextWrapping = 'Wrap'",
  "$txt.HorizontalAlignment = 'Center'",
  "$txt.VerticalAlignment = 'Top'",
  "$txt.Margin = '8,116,8,0'",
  "$txt.MaxWidth = 136",
  "",
  "$close = New-Object System.Windows.Controls.Button",
  "$close.Content = '×'",
  "$close.Width = 18",
  "$close.Height = 18",
  "$close.FontSize = 10",
  "$close.HorizontalAlignment = 'Right'",
  "$close.VerticalAlignment = 'Top'",
  "$close.Margin = '0,2,2,0'",
  "$close.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(210,255,255,255))",
  "$close.BorderThickness = New-Object System.Windows.Thickness(0)",
  "$close.Cursor = [System.Windows.Input.Cursors]::Hand",
  "",
  "$grid.Children.Add($card) | Out-Null",
  "$grid.Children.Add($txt) | Out-Null",
  "$grid.Children.Add($close) | Out-Null",
  "$win.Content = $grid",
  "",
  "$close.Add_Click({",
  "  $win.Close()",
  "})",
  "",
  "$win.Add_MouseLeftButtonDown({",
  "  $win.DragMove()",
  "})",
  "",
  "# 拖回检测：主窗口屏幕矩形（client 经 RPC 上报，host 存 state.windowRect）",
  "$script:windowRect = $null",
  "",
  "# 拖动结束（DragMove 返回）后检查：窗口是否落在主窗口区域（容差 60px）内",
  "$win.Add_MouseLeftButtonUp({",
  "  $wr = $script:windowRect",
  "  if ($wr) {",
  "    $cx = $win.Left + $win.Width / 2",
  "    $cy = $win.Top + $win.Height / 2",
  "    if (($cx -ge ($wr.x - 60)) -and ($cx -le ($wr.x + $wr.width + 60)) -and ($cy -ge ($wr.y - 60)) -and ($cy -le ($wr.y + $wr.height + 60))) {",
  "      try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' fly back to window') } catch { }",
  "      $win.Close()",
  "    }",
  "  }",
  "})",
  "",
  "$wc = New-Object System.Net.WebClient",
  "$timer = New-Object System.Windows.Threading.DispatcherTimer",
  "$timer.Interval = [TimeSpan]::FromSeconds(2)",
  "",
  "$timer.Add_Tick({",
  "  try {",
  "    $r = $wc.DownloadString($stateUrl)",
  "    $j = $r | ConvertFrom-Json",
  "    if ($j.windowRect) { $script:windowRect = $j.windowRect }",
  "    $taskName = ''",
  "    if ($j.sessionTitle) { $taskName = $j.sessionTitle }",
  "    elseif ($j.task -and $j.task.model) { $taskName = $j.task.provider + '/' + $j.task.model }",
  "    else { $taskName = '待命' }",
  "    $prog = ''",
  "    if ($j.progress) { $prog = ' · ' + $j.progress.label + ' ' + [Math]::Round($j.progress.pct) + '%' }",
  "    $tokens = [Math]::Round($j.today.tokens / 1000000, 1)",
  "    $sat = [Math]::Round($j.satiety.value)",
  "    $txt.Text = $taskName + $prog + [Environment]::NewLine + '本日 ' + $tokens + 'M · ' + $j.today.calls + ' 次' + [Environment]::NewLine + '饱腹 ' + $sat + '/' + $j.satiety.max",
  "  } catch {",
  "    $txt.Text = '离线'",
  "  }",
  "})",
  "$timer.Start()",
  "",
  "$win.Add_Closed({",
  "  $timer.Stop()",
  "  try { Add-Content -Path $logPath -Value ((Get-Date -Format 'HH:mm:ss') + ' closed') } catch { }",
  "  [Environment]::Exit(0)",
  "})",
  "",
  "$win.ShowDialog() | Out-Null",
  "",
].join('\r\n');

export function isDesktopMode() {
  return !!(process && process.env && process.env.DSH_DESKTOP === '1');
}

let desktopPetProc = null; // 当前 PowerShell 子进程句柄

/** 把 bundle 的 left.webp 落到 dataDir，供 PowerShell 本地加载。 */
export function ensurePetImage() {
  const dst = join(dataDir(), 'left.webp');
  if (existsSync(dst)) return dst;
  try {
    const a = assetBase64('left');
    if (a.ok && a.base64) {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(dst, Buffer.from(a.base64, 'base64'));
      return dst;
    }
  } catch { /* ignore */ }
  return null;
}

export function ensurePetScript() {
  const dst = join(dataDir(), 'pet-window.ps1');
  try {
    mkdirSync(dataDir(), { recursive: true });
    // UTF-8 BOM：Windows PowerShell 5.1 只有识别 BOM 才按 UTF-8 解析脚本
    writeFileSync(dst, '\uFEFF' + PET_WINDOW_PS1);
  } catch { /* ignore */ }
  return dst;
}

export function desktopState() {
  const s = {
    available: isDesktopMode(),
    running: !!(desktopPetProc && desktopPetProc.exitCode === null),
    pid: desktopPetProc && desktopPetProc.exitCode === null ? desktopPetProc.pid : null,
  };
  // 诊断：记录 desktopState 读取到的 env（排查 available/running 与 spawn 不一致）
  try {
    petSpawnLog('desktopState env.DSH_DESKTOP=' + (process && process.env ? String(process.env.DSH_DESKTOP) : '(no process)') + ' -> ' + JSON.stringify(s));
  } catch { /* ignore */ }
  return s;
}

// 调试日志：spawn 全链路（排查「显示到桌面」无窗口）
function petSpawnLog(msg) {
  try {
    writeFileSync(join(dataDir(), 'pet-spawn.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch { /* ignore */ }
}

export function startDesktopPet({ port }) {
  if (!isDesktopMode()) {
    petSpawnLog('refused: not desktop mode');
    return { ok: false, reason: '独立桌面窗口仅在桌面版（DeepSeek Harness.exe）可用' };
  }
  if (desktopPetProc && desktopPetProc.exitCode === null) {
    petSpawnLog('already running pid=' + desktopPetProc.pid);
    return { ok: true, already: true };
  }
  const script = ensurePetScript();
  const image = ensurePetImage();
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', script, '-Port', String(Number.isFinite(port) && port > 0 ? port : 2881), '-ImagePath', image || '',
  ];
  petSpawnLog('spawning powershell ' + JSON.stringify(args));
  let p;
  try {
    // 注意：不能用 detached:true —— Windows 上 node detached spawn 的
    // powershell.exe 会静默立即退出（exit code=0，脚本不执行，实测复现）。
    // unref() 足以让窗口在 host 退出后继续存活（Windows 子进程独立）。
    p = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (err) {
    petSpawnLog('spawn threw: ' + String(err && err.message ? err.message : err));
    return { ok: false, reason: '无法启动 PowerShell：' + String(err && err.message ? err.message : err) };
  }
  p.on('error', (err) => petSpawnLog('spawn error event: ' + String(err && err.message ? err.message : err)));
  p.on('exit', (code, signal) => petSpawnLog('exit code=' + code + ' signal=' + signal));
  p.unref();
  desktopPetProc = p;
  petSpawnLog('spawned pid=' + p.pid);
  return { ok: true, pid: p.pid };
}

export function stopDesktopPet() {
  const p = desktopPetProc;
  desktopPetProc = null;
  if (p && p.exitCode === null) {
    try { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => {}); } catch { /* ignore */ }
    return { stopped: true };
  }
  return { stopped: false };
}

/** GET /desktop-pet/state —— PowerShell 窗口的轮询数据源。 */
export function desktopStateHandler(holder) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const body = JSON.stringify(snapshot(holder.state, holder.config));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.message ? err.message : err));
    }
  };
}


// Cordis 注入声明：webServer 的 register 受注入保护（"cannot get property register
// without inject"），必须插件级声明才能访问。webServer 缺席时插件等待其出现
// （web profile / 桌面版均有 webServer，可接受）。
export const inject = ['webServer'];

export function apply(ctx) {
  const config = loadConfig();
  const state = loadState();
  rollDay(state);
  initSatiety(state, config);
  const holder = { config, state };
  // 会话 id → 标题（内存缓存，最近 20 个，防无界增长）
  const sessionTitles = new Map();
  let lastBroadcastAt = 0;

  ctx.on('session/event', (session, event) => {
    try {
      writeSessionDebug(session);
      const sid = session && typeof session.id === 'string' ? session.id : null;
      if (sid && !sessionTitles.has(sid)) {
        const t = foldSessionTitle(session && Array.isArray(session.events) ? session.events : undefined);
        if (t) sessionTitles.set(sid, t);
      }
      // session/title 事件 → 更新标题（last-wins）
      if (sid && event && event.type === 'session/title' && event.data && typeof event.data.title === 'string' && event.data.title.trim()) {
        sessionTitles.set(sid, event.data.title.trim().slice(0, 60));
        if (sessionTitles.size > 20) sessionTitles.delete(sessionTitles.keys().next().value);
      }
      const title = sid ? sessionTitles.get(sid) : null;
      if (title) state.sessionTitle = title;
      // 进度状态机（轻量借鉴 dsh-answer-pet 的阶段边沿）
      applyProgressEvent(state, event);
      const changed = applyPetEvent(state, config, session, event);
      const now = Date.now();
      if (changed) {
        saveState(state);
        broadcastPetState(holder);
      } else if (state.progress && state.progress.lastActiveAt && now - lastBroadcastAt > 2000) {
        // 进度高频事件（chunk/tool）节流广播，避免打爆 RPC
        lastBroadcastAt = now;
        broadcastPetState(holder);
      }
    } catch { /* never break the firehose consumer */ }
  });

  // 天气首次拉取（不阻塞启动）。
  refreshWeather(state, config).catch(() => {}).then(() => saveState(state)).catch(() => {});

  // 探测 Electron 能力（独立窗口仅桌面版支持），输出到 Harness 日志便于排查。
  getElectron().then((electron) => {
    try {
      console.log(`[desktop-pet] electron=${!!electron} BrowserWindow=${!!(electron && electron.BrowserWindow)} processType=${process && process.type ? process.type : 'node'} pid=${process.pid}`);
    } catch { /* ignore */ }
  }).catch(() => {});

  ctx.inject(['connection'], (webContext) => {
    const disposer = webContext.connection.rpc.handle(
      CHANNEL,
      createHandler({ holder }),
      { authority: 'loopback' },
    );
    return () => {
      disposer().catch(() => {});
    };
  });

  // 独立桌面窗口的数据源路由（PowerShell WPF 轮询 GET /desktop-pet/state）。
  // inject 声明保证 apply 时 webServer 已就绪（ctx.get 有注入权限）。
  let webRouteDispose = () => {};
  try {
    const webServer = ctx.get('webServer');
    if (webServer && typeof webServer.register === 'function') {
      const disposer = webServer.register({
        kind: 'exact',
        path: '/desktop-pet/state',
        handler: desktopStateHandler(holder),
      });
      writeJson(join(dataDir(), 'route-debug.json'), { registered: true, port: (webServer && webServer.port) || null });
      if (typeof disposer === 'function') {
        webRouteDispose = () => { try { disposer(); } catch { /* ignore */ } };
      }
    } else {
      writeJson(join(dataDir(), 'route-debug.json'), { registered: false, error: 'webServer missing or no register' });
    }
  } catch (err) {
    writeJson(join(dataDir(), 'route-debug.json'), { registered: false, error: String(err && err.message ? err.message : err) });
  }

  return () => {
    try { webRouteDispose(); } catch { /* ignore */ }
    saveState(state);
  };
}

// ---------------------------------------------------------------------------
// Reusable surface (exercised by scripts/test-host.mjs)
// ---------------------------------------------------------------------------
export {
  CHANNEL,
  emptyState,
  loadState,
  saveState,
  randomUUID,
};
