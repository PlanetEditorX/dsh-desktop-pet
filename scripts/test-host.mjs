/**
 * dsh-desktop-pet — host half tests.
 * Exercises the satiety state machine, session-event folding, snapshot
 * shape, trash path validation, and the WMO weather mapping.
 */

import {
  DEFAULT_CONFIG,
  applyPetEvent,
  snapshot,
  phaseOf,
  gainSatiety,
  decaySatiety,
  rollDay,
  initSatiety,
  todayKey,
  prepareTrash,
  weatherCodeInfo,
  createHandler,
  emptyState,
  assetBase64,
  foldSessionTitle,
  applyProgressEvent,
  progressView,
} from '../lib/index.js';

let failures = 0;
const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function run() {
  for (const { name, fn } of checks) {
    try {
      fn();
      console.log(`  ✔ ${name}`);
    } catch (err) {
      failures += 1;
      console.log(`  ✘ ${name}`);
      console.log(`    ${err.message}`);
    }
  }
}

{
  check('satiety: init uses configured start', () => {
    const state = emptyState();
    initSatiety(state, DEFAULT_CONFIG);
    if (state.satiety !== 60) throw new Error(`expected 60, got ${state.satiety}`);
  });

  check('satiety: decay applies elapsed minutes', () => {
    const state = emptyState();
    state.satiety = 60;
    state.satietyUpdatedAt = 1_000_000;
    const v = decaySatiety(state, DEFAULT_CONFIG, 1_000_000 + 10 * 60000); // 10 min
    if (Math.abs(v - (60 - 10 * 0.2)) > 1e-9) throw new Error(`expected 58, got ${v}`);
  });

  check('satiety: gain caps at max and clears hungry timers', () => {
    const state = emptyState();
    state.satiety = 5;
    state.hungrySince = 123;
    state.collapsedAt = 456;
    gainSatiety(state, DEFAULT_CONFIG, 12); // → 17，仍在饥饿区间（<25）
    if (state.satiety !== 17) throw new Error(`expected 17, got ${state.satiety}`);
    if (state.hungrySince !== 123) throw new Error('饥饿区间内 hungrySince 应保留');
    if (state.collapsedAt !== null) throw new Error('17 ≥ collapsedBelow(5)，collapsedAt 应清除');
    gainSatiety(state, DEFAULT_CONFIG, 10); // → 27 ≥ 25，回升
    if (state.satiety !== 27) throw new Error(`expected 27, got ${state.satiety}`);
    if (state.hungrySince !== null || state.collapsedAt !== null) throw new Error('回升后应清除计时器');
    gainSatiety(state, DEFAULT_CONFIG, 1000);
    if (state.satiety !== 100) throw new Error(`expected cap 100, got ${state.satiety}`);
  });

  check('satiety: phases ok / hungry / collapsed with delay', () => {
    const state = emptyState();
    state.satiety = 80;
    if (phaseOf(state, DEFAULT_CONFIG) !== 'ok') throw new Error('80 should be ok');
    state.satiety = 10; // below hungryBelow(25), above collapsedBelow(5)
    const p1 = phaseOf(state, DEFAULT_CONFIG, 1000);
    if (p1 !== 'hungry') throw new Error(`expected hungry, got ${p1}`);
    // 进入趴下：低于 collapsedBelow 且饥饿时长超过延迟
    state.satiety = 2;
    const now = 1000 + DEFAULT_CONFIG.satiety.collapseDelayMin * 60000 + 1;
    if (phaseOf(state, DEFAULT_CONFIG, now) !== 'collapsed') throw new Error('should be collapsed after delay');
  });

  check('satiety: collapse needs the delay, not instant', () => {
    const state = emptyState();
    state.satiety = 2;
    const p = phaseOf(state, DEFAULT_CONFIG, 1000); // delay not elapsed yet
    if (p !== 'hungry') throw new Error(`expected hungry (not yet collapsed), got ${p}`);
  });

  check('today: rollDay resets counters on date change', () => {
    const state = emptyState();
    state.date = '2026-07-01';
    state.todayTokens = 999;
    state.todayCalls = 3;
    rollDay(state, new Date('2026-08-16T10:00:00'));
    if (state.date !== '2026-08-16') throw new Error(`date ${state.date}`);
    if (state.todayTokens !== 0 || state.todayCalls !== 0) throw new Error('counters not reset');
    rollDay(state, new Date('2026-08-16T11:00:00'));
    if (state.date !== '2026-08-16') throw new Error('same day must keep counters');
  });

  check('today: todayKey is local YYYY-MM-DD', () => {
    const key = todayKey(new Date(2026, 7, 16, 23, 59));
    if (key !== '2026-08-16') throw new Error(`got ${key}`);
  });

  check('events: request/header records the running task', () => {
    const state = emptyState();
    state.satiety = 60;
    state.satietyUpdatedAt = 0;
    const hit = applyPetEvent(state, DEFAULT_CONFIG, 's1', {
      type: 'request/header',
      data: { header: { config: { provider: 'opencode', model: 'deepseek-v4-flash' } } },
    }, 5000);
    if (!hit) throw new Error('should touch state');
    if (state.lastTask.provider !== 'opencode' || state.lastTask.model !== 'deepseek-v4-flash') {
      throw new Error(`task ${JSON.stringify(state.lastTask)}`);
    }
    if (state.lastTask.kind !== 'request') throw new Error('kind');
  });

  check('events: assistant/message folds usage into today + satiety', () => {
    const state = emptyState();
    state.satiety = 60;
    state.satietyUpdatedAt = 0;
    state.lastTask = { provider: 'opencode', model: 'deepseek-v4-flash', kind: 'request', at: 1 };
    applyPetEvent(state, DEFAULT_CONFIG, 's1', {
      type: 'assistant/message',
      data: { usage: { inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 300000, cacheWriteTokens: 0 } },
    }, 6000);
    // billed = 100000 + 300000 + 0 = 400000
    if (state.todayTokens !== 400000) throw new Error(`todayTokens ${state.todayTokens}`);
    if (state.todayCalls !== 1) throw new Error('calls');
    if (state.lastTask.kind !== 'reply' || state.lastTask.tokens !== 400000) throw new Error('lastTask');
    // satiety = 60 + 400000/300000 ≈ 61.33
    if (Math.abs(state.satiety - (60 + 4 / 3)) > 1e-9) throw new Error(`satiety ${state.satiety}`);
  });

  check('events: irrelevant events are ignored', () => {
    const state = emptyState();
    if (applyPetEvent(state, DEFAULT_CONFIG, 's1', { type: 'user/message' })) throw new Error('user/message should be ignored');
    if (applyPetEvent(state, DEFAULT_CONFIG, 's1', { type: 'assistant/message', data: {} })) throw new Error('no usage should be ignored');
  });

  check('snapshot: shape carries today / satiety / task / config knobs', () => {
    const state = emptyState();
    const now = new Date('2026-08-16T10:00:00').getTime();
    state.date = '2026-08-16';
    state.satiety = 42;
    state.satietyUpdatedAt = now; // 不衰减
    state.todayTokens = 123;
    state.todayCalls = 2;
    state.trashCount = 5;
    state.lastTask = { provider: 'p', model: 'm', kind: 'request', at: 1 };
    const snap = snapshot(state, DEFAULT_CONFIG, now);
    if (snap.today.tokens !== 123 || snap.today.calls !== 2) throw new Error(`today ${JSON.stringify(snap.today)}`);
    if (snap.satiety.value !== 42) throw new Error(`satiety ${snap.satiety.value}`);
    if (snap.trashCount !== 5) throw new Error('trashCount');
    if (snap.config.bubble.ms !== 10000) throw new Error(`bubble config ${snap.config.bubble.ms}`);
    if (snap.task.model !== 'm') throw new Error('task');
  });

  check('trash: prepareTrash validates paths', () => {
    const { valid, invalid } = prepareTrash(['C:\\Windows\\notepad.exe', 'relative/path', 42, '']);
    if (valid.length !== 1 || valid[0] !== 'C:\\Windows\\notepad.exe') throw new Error(`valid ${JSON.stringify(valid)}`);
    if (invalid.length !== 3) throw new Error(`invalid ${invalid.length}`);
    const { valid: v2 } = prepareTrash('C:\\Windows\\notepad.exe'); // not an array
    if (v2.length !== 0) throw new Error('non-array should yield empty valid');
  });

  check('weather: WMO codes map to accessories', () => {
    if (weatherCodeInfo(0).accessory !== 'clear') throw new Error('0 → clear');
    if (weatherCodeInfo(61).accessory !== 'rain') throw new Error('61 → rain');
    if (weatherCodeInfo(71).accessory !== 'snow') throw new Error('71 → snow');
    if (weatherCodeInfo(95).accessory !== 'storm') throw new Error('95 → storm');
    if (weatherCodeInfo(999).accessory !== null) throw new Error('unknown → null');
  });

  check('handler: pet.config.update merges and sanitizes', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.config.update', { satiety: { decayPerMin: 9.9, max: 120 }, bubble: { ms: 1234 } });
    if (!r.ok) throw new Error('update failed');
    if (r.value.config.satiety.decayPerMin !== 9.9) throw new Error('decayPerMin');
    if (r.value.config.satiety.max !== 120) throw new Error('max');
    if (r.value.config.satiety.tokensPerPoint !== 300000) throw new Error('unchanged field lost');
    if (r.value.config.bubble.ms !== 1234) throw new Error('bubble');
    // 非法数字回退
    const r2 = await handler('pet.config.update', { satiety: { decayPerMin: -5 } });
    if (r2.value.config.satiety.decayPerMin !== 9.9) throw new Error('negative should be ignored');
  });

  check('assets: assetBase64 reads the bundled left.webp', () => {
    const a = assetBase64('left');
    if (!a.ok) throw new Error(`asset load failed: ${a.error}`);
    if (a.mime !== 'image/webp') throw new Error('mime');
    if (a.width !== 1122 || a.height !== 2019) throw new Error(`size ${a.width}x${a.height}`);
    const buf = Buffer.from(a.base64, 'base64');
    if (buf[0] !== 0x52 || buf[1] !== 0x49) throw new Error('not RIFF');
  });

  check('assets: unknown names fall back safely', () => {
    // 非法名（路径穿越）回退到默认 left，绝不拼接路径
    const a = assetBase64('../evil');
    if (!a.ok || a.name !== 'left') throw new Error('path traversal must fall back to left');
    const b = assetBase64('nonexistent');
    if (b.ok) throw new Error('missing asset must fail');
  });

  check('handler: pet.asset wraps result in value', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.asset', { name: 'left' });
    if (!r.ok || !r.value || !r.value.base64) throw new Error('pet.asset 应返回 {ok, value:{base64,...}}');
    if (r.value.mime !== 'image/webp') throw new Error(`mime ${r.value.mime}`);
    if (r.value.width !== 1122) throw new Error('width');
  });

  check('handler: pet.window.state reports closed when no window', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.window.state', {});
    if (!r.ok || r.value.open !== false) throw new Error('无窗口时应 open=false');
  });

  check('handler: pet.pos.update saves position', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.pos.update', { x: 123.7, y: 45.2 });
    if (!r.ok || r.value.x !== 124 || r.value.y !== 45) throw new Error('pos rounding');
    if (holder.state.petPos.x !== 124) throw new Error('state not saved');
    const bad = await handler('pet.pos.update', { x: 'abc' });
    if (bad.ok) throw new Error('bad pos should fail');
  });

  check('handler: pet.window.debug reports environment', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.window.debug', {});
    if (!r.ok || typeof r.value.electronAvailable !== 'boolean') throw new Error('debug shape');
  });

  check('events: session title captured as task name', () => {
    const state = emptyState();
    state.satiety = 60;
    state.satietyUpdatedAt = 0;
    applyPetEvent(state, DEFAULT_CONFIG, { id: 's1', title: '用量统计插件开发' }, {
      type: 'request/header',
      data: { header: { config: { provider: 'opencode', model: 'deepseek-v4-flash' } } },
    }, 1000);
    if (state.lastTask.title !== '用量统计插件开发') throw new Error(`title ${state.lastTask.title}`);
  });

  check('events: string session keeps working (no title)', () => {
    const state = emptyState();
    state.satiety = 60;
    state.satietyUpdatedAt = 0;
    applyPetEvent(state, DEFAULT_CONFIG, 's1', {
      type: 'request/header',
      data: { header: { config: { provider: 'opencode', model: 'm' } } },
    }, 1000);
    if (state.lastTask.title !== null) throw new Error('string session → no title');
  });

  check('session: foldSessionTitle from session/title events', () => {
    const t = foldSessionTitle([
      { type: 'user/message' },
      { type: 'session/title', data: { title: '桌面宠物开发' } },
    ]);
    if (t !== '桌面宠物开发') throw new Error(`fold ${t}`);
    if (foldSessionTitle(null) !== null) throw new Error('null events');
    if (foldSessionTitle([{ type: 'x' }]) !== null) throw new Error('no title event');
  });

  check('progress: phase machine turn→think→stream→tool→done', () => {
    const state = emptyState();
    applyProgressEvent(state, { type: 'turn/start' }, 1000);
    if (state.progress.phase !== 'turn') throw new Error('turn');
    applyProgressEvent(state, { type: 'step/start' }, 1100);
    if (state.progress.phase !== 'think') throw new Error('think');
    applyProgressEvent(state, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hello world' } } }, 1200);
    if (state.progress.phase !== 'stream') throw new Error('stream');
    applyProgressEvent(state, { type: 'tool/call', data: { name: 'grep' } }, 1300);
    if (state.progress.phase !== 'tool' || state.progress.toolName !== 'grep') throw new Error('tool');
    applyProgressEvent(state, { type: 'tool/result' }, 1350);
    if (state.progress.phase !== 'stream') throw new Error('back to stream');
    applyProgressEvent(state, { type: 'turn/end' }, 1400);
    const v = progressView(state, 1500);
    if (!v || v.phase !== 'done' || v.pct !== 100) throw new Error('done view');
    if (progressView(state, 1500 + 90000) !== null) throw new Error('done should expire');
    if (progressView(emptyState(), 1000) !== null) throw new Error('idle no view');
  });

  check('handler: pet.trash rejects empty paths', async () => {
    const holder = { config: DEFAULT_CONFIG, state: emptyState() };
    const handler = createHandler({ holder, saveConfig: () => {}, saveState: () => {} });
    const r = await handler('pet.trash', { paths: [] });
    if (r.ok) throw new Error('should fail');
  });
}

run();

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
