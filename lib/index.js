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
import { execFile } from 'node:child_process';
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
let sessionDebugWritten = false;
function writeSessionDebug(session) {
  if (sessionDebugWritten || !session || typeof session !== 'object') return;
  sessionDebugWritten = true;
  try {
    const sample = {};
    for (const k of Object.keys(session)) {
      const v = session[k];
      if (typeof v === 'string') sample[k] = v.slice(0, 80);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) sample[k] = v;
      else sample[k] = `<${typeof v}>`;
    }
    // 深度采样 header（会话标题最可能在这里）
    if (session.header && typeof session.header === 'object') {
      const h = {};
      for (const k of Object.keys(session.header)) {
        const v = session.header[k];
        if (typeof v === 'string') h[k] = v.slice(0, 80);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) h[k] = v;
        else h[k] = `<${typeof v}>`;
      }
      sample['header:detail'] = h;
    }
    writeJson(join(dataDir(), 'session-debug.json'), { keys: Object.keys(session), sample });
  } catch { /* ignore */ }
}

export function applyPetEvent(state, config, session, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return false;
  const type = event.type;
  const title = sessionTitleOf(session);
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
    trashCount: state.trashCount,
    weather: state.weather,
    windowOpen: petWindowOpen(),
    petPos: state.petPos && Number.isFinite(state.petPos.x) && Number.isFinite(state.petPos.y) ? state.petPos : null,
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
        default:
          return error('unknown-endpoint', `未知端点 ${endpoint}`);
      }
    } catch (err) {
      return error('internal', String(err && err.message ? err.message : err));
    }
  };
}

// ---------------------------------------------------------------------------
// Cordis plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const config = loadConfig();
  const state = loadState();
  rollDay(state);
  initSatiety(state, config);
  const holder = { config, state };

  ctx.on('session/event', (session, event) => {
    try {
      writeSessionDebug(session);
      if (applyPetEvent(state, config, session, event)) {
        saveState(state);
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

  return () => {
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
