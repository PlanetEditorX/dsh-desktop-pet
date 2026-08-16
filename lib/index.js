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
    ms: 4000,
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
export function applyPetEvent(state, config, sessionId, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return false;
  const type = event.type;
  if (type === 'request/header') {
    const cfg = configOf(event);
    if (!cfg) return false;
    state.lastTask = {
      provider: typeof cfg.provider === 'string' ? cfg.provider : null,
      model: typeof cfg.model === 'string' ? cfg.model : null,
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
    config: {
      bubble: config.bubble,
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
          saveConfig(next);
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
            saveState(state);
          }
          return ok(result);
        }
        case 'pet.weather.refresh': {
          await refreshWeather(state, config);
          saveState(state);
          return ok({ weather: state.weather });
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
      if (applyPetEvent(state, config, session && session.id, event)) saveState(state);
    } catch { /* never break the firehose consumer */ }
  });

  // 天气首次拉取（不阻塞启动）。
  refreshWeather(state, config).catch(() => {}).then(() => saveState(state)).catch(() => {});

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
