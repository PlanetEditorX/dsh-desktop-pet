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
    tokensPerPoint: 20000, // +1 饱腹 / 每 2 万 billed tokens（30 万太苛刻：一次回复 20 万 token 只加 0.7 点，进度条无感知）
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
    auto: false, // 不再自动定位（IP），城市必须手动选择
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
      auto: false, // 去除自动定位：城市只能手动选择
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
    lastUserText: null, // 最新用户消息文本（气泡以用户消息为内容，而非会话名）
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

/** 从用户消息的 ContentBlock 列表提取纯文本（同 dsh-message-rail 的 userTextOf）。 */
function userTextOf(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.trim();
}

export function applyPetEvent(state, config, session, event, now = Date.now()) {
  if (!event || typeof event !== 'object') return false;
  const type = event.type;
  const title = sessionTitleOf(session) || (typeof state.sessionTitle === 'string' && state.sessionTitle ? state.sessionTitle : null);
  if (type === 'user/message') {
    // 只索引用户真正输入的消息（source.kind === 'user'）；跳过系统注入
    // （time-context / agent-instructions / MNEMON 等 plugin 消息），
    // 否则气泡内容会被注入前缀占据而非用户的话。
    const msg = event.data && typeof event.data === 'object' ? event.data : null;
    const source = msg && msg.source && typeof msg.source === 'object' ? msg.source : null;
    if (!source || source.kind !== 'user') return false;
    const text = userTextOf(msg.content);
    if (!text) return false;
    state.lastUserText = text.slice(0, 80);
    state.lastTask = {
      provider: null,
      model: null,
      title: state.lastUserText,
      kind: 'request',
      at: now,
    };
    return true;
  }
  if (type === 'request/header') {
    const cfg = configOf(event);
    if (!cfg) return false;
    state.lastTask = {
      provider: typeof cfg.provider === 'string' ? cfg.provider : null,
      model: typeof cfg.model === 'string' ? cfg.model : null,
      title: state.lastUserText || title,
      kind: 'request',
      at: now,
    };
    return true;
  }
  if (type === 'assistant/message') {
    const usage = usageOf(event);
    if (!usage) return false;
    const billed = (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    state.lastTask = {
      provider: (state.lastTask && state.lastTask.provider) || null,
      model: (state.lastTask && state.lastTask.model) || null,
      title: state.lastUserText || title || (state.lastTask && state.lastTask.title) || null,
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
      // 新任务开始 → 惊讶姿态（6s）
      state.poseEvent = { pose: 'surprised', at: now };
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
      // 任务完成 → 挥手姿态（6s）
      state.poseEvent = { pose: 'wave', at: now };
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
// 多姿态：事件触发的临时姿态（惊讶/挥手）叠加在状态姿态之上
// ---------------------------------------------------------------------------

const POSE_EVENT_MS = 6000; // 临时姿态（惊讶/挥手）展示时长

export function poseView(state, config, now = Date.now()) {
  // 优先级：趴下 > 饥饿 > 临时事件（惊讶/挥手 6s）> 工作中 > 待命
  const phase = phaseOf(state, config, now);
  if (phase === 'collapsed') return 'collapsed';
  if (phase === 'hungry') return 'hungry';
  const ev = state.poseEvent;
  if (ev && typeof ev.at === 'number' && now - ev.at < POSE_EVENT_MS) {
    return ev.pose === 'wave' ? 'wave' : 'surprised';
  }
  const prog = progressView(state, now);
  if (prog && prog.phase !== 'done') return 'working';
  return 'idle';
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
    lastUserText: typeof state.lastUserText === 'string' && state.lastUserText ? state.lastUserText : null,
    sessionTitle: typeof state.sessionTitle === 'string' && state.sessionTitle ? state.sessionTitle : null,
    progress: progressView(state, now),
    pose: poseView(state, config, now),
    trashCount: state.trashCount,
    weather: state.weather,
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
    } else if (config.weather.city) {
      geo = await geoByCity(config.weather.city);
    }
    if (!geo) {
      state.weather = { error: '未选择城市（请在设置中填写城市后保存）', fetchedAt: now };
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
  const candidates = [`${safe}.webp`, `${safe}.png`, `${safe}.jpg`, `${safe}.jpeg`];
  const p = candidates.map((c) => join(assetsDir(), c)).find((c) => existsSync(c));
  if (!p) return { ok: false, error: `缺少资源 ${safe}` };
  const mime = p.endsWith('.png') ? 'image/png' : p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp';
  const buf = readFileSync(p);
  const size = webpSize(buf) || { width: null, height: null };
  return { ok: true, name: safe, mime, base64: buf.toString('base64'), width: size.width, height: size.height };
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
          // 天气相关配置变化 → 立即失效缓存并刷新（否则 30 分钟缓存内仍显示旧城市天气）
          const wOld = config.weather;
          const wNew = next.weather;
          if (wOld.enabled !== wNew.enabled || wOld.city !== wNew.city || wOld.lat !== wNew.lat || wOld.lon !== wNew.lon) {
            state.weather = null;
            await refreshWeather(state, next).catch(() => {});
            persistState(state);
          }
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
      } else if (state.progress && state.progress.lastActiveAt && now - lastBroadcastAt > 2000) {
        // 进度高频事件（chunk/tool）节流持久化，避免频繁写盘
        lastBroadcastAt = now;
        saveState(state);
      }
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
