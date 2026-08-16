/**
 * dsh-desktop-pet — web client half.
 *
 * A desktop pet living in the bottom-right corner via `shell.overlay`:
 *  - classic deepseek whale-girl drawn in inline SVG (normal / hungry /
 *    collapsed / eating states, breathing animation)
 *  - anime speech bubble: shows the running task when it changes, fades out
 *    after a while, stays while hovering (with today's tokens, calls,
 *    satiety bar and weather)
 *  - drag files from the OS onto her → she opens her mouth and eats them
 *    (host moves them to the recycle bin); works in the desktop (Electron)
 *    window where dropped File objects carry a real path
 *  - weather accessories (umbrella / sunglasses / scarf / cloud / snow /
 *    lightning) driven by the host weather snapshot
 *  - a settings page (settings.section) for all tunable parameters
 *
 * All data comes from the host half over the package-private RPC channel
 * `/desktop-pet`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-pet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const e = React.createElement;

    // ------------------------------------------------------------------
    // Styles (one guarded tag, like every other bundle)
    // ------------------------------------------------------------------
    const CSS_ID = 'dsh-desktop-pet/styles';
    const CSS = `
.dp-root{position:fixed;right:14px;bottom:10px;z-index:50;pointer-events:none;filter:drop-shadow(0 3px 8px rgba(30,64,175,.22))}
.dp-pet{position:relative;pointer-events:auto;cursor:grab;width:132px;height:104px;transition:transform .35s ease}
.dp-pet.dragging{cursor:grabbing;transform:scale(1.1)}
.dp-whale{display:block;width:100%;height:100%;transition:transform 1.1s ease-in-out}
.dp-pet.collapsed .dp-whale{transform:rotate(90deg) translateY(18px) scale(.92)}
.dp-pet.hungry .dp-whale{animation:dp-slouch 3.4s ease-in-out infinite}
@keyframes dp-slouch{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
.dp-pet.ok:not(.dragging) .dp-whale{animation:dp-breathe 3.2s ease-in-out infinite}
@keyframes dp-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.015)}}
.dp-pet.collapsed .dp-eye-open{opacity:0}
.dp-pet.collapsed .dp-eye-closed{opacity:1}
.dp-pet.hungry .dp-eye-open{animation:dp-blink 2.4s ease-in-out infinite}
@keyframes dp-blink{0%,100%{opacity:1}46%{opacity:1}50%{opacity:.15}54%{opacity:1}}
.dp-mouth-open{opacity:0}
.dp-pet.dragging .dp-mouth-open{opacity:1}
.dp-pet.dragging .dp-mouth-smile{opacity:0}
.dp-tear{opacity:0}
.dp-pet.collapsed .dp-tear{opacity:1;animation:dp-drop 1.6s ease-in infinite}
@keyframes dp-drop{0%{transform:translateY(0);opacity:1}100%{transform:translateY(12px);opacity:0}}
.dp-bubble{position:absolute;right:-4px;bottom:calc(100% + 6px);width:230px;background:linear-gradient(180deg,#ffffff,#f4f8ff);border:1.5px solid #93c5fd;border-radius:14px;padding:9px 12px;box-shadow:0 6px 18px rgba(37,99,235,.16);transition:opacity .28s ease,transform .28s ease;transform-origin:90% 100%;pointer-events:auto}
.dp-bubble.hidden{opacity:0;transform:scale(.9);pointer-events:none}
.dp-bubble::after{content:'';position:absolute;right:26px;top:100%;border:8px solid transparent;border-top-color:#93c5fd}
.dp-bubble::before{content:'';position:absolute;right:27px;top:100%;border:7px solid transparent;border-top-color:#ffffff}
.dp-bt{font-size:12px;line-height:17px;color:#1e3a8a;font-weight:600}
.dp-bs{font-size:11px;line-height:16px;color:#64748b;margin-top:3px}
.dp-detail{display:grid;gap:4px;margin-top:6px;font-size:11px;line-height:16px;color:#334155}
.dp-detail .row{display:flex;justify-content:space-between;gap:8px}
.dp-detail .row b{color:#0f172a;font-weight:650}
.dp-satbar{height:7px;border-radius:99px;background:#e2e8f0;overflow:hidden;margin-top:2px}
.dp-satbar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#34d399,#3b82f6);transition:width .6s ease}
.dp-satbar.hungry>i{background:linear-gradient(90deg,#fbbf24,#f97316)}
.dp-satbar.collapsed>i{background:linear-gradient(90deg,#f87171,#dc2626)}
.dp-accessory{position:absolute;left:14px;top:-2px;pointer-events:none;width:54px;height:48px;animation:dp-float 2.8s ease-in-out infinite}
@keyframes dp-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.dp-settings .dp-field{display:grid;gap:4px;min-width:0}
.dp-settings .dp-field>label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#71717a)}
.dp-settings .dp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dp-settings .dp-section{border-top:1px solid var(--dsw-alias-border-l2,#e4e4e7);padding-top:10px;margin-top:10px}
.dp-settings .dp-section>h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#18181b)}
`;
    function mountCss() {
      if (document.getElementById(CSS_ID)) return;
      const tag = document.createElement('style');
      tag.id = CSS_ID;
      tag.setAttribute('data-plugin-css', '1');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function fmtTokens(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(Math.round(v));
    }

    function fmtPct(v) {
      return `${Math.round((Number(v) || 0) * 10) / 10}%`;
    }

    function phaseLabel(phase) {
      return phase === 'collapsed' ? '饿趴下了' : phase === 'hungry' ? '饥饿' : '饱饱的';
    }

    const ACC_TEXT = {
      clear: '晴',
      sun: '少云',
      cloud: '多云',
      fog: '雾',
      rain: '雨',
      snow: '雪',
      storm: '雷暴',
    };

    // ------------------------------------------------------------------
    // Weather accessory SVGs (overlaid on the pet)
    // ------------------------------------------------------------------
    function Accessory({ accessory }) {
      if (!accessory) return null;
      let inner = null;
      if (accessory === 'clear' || accessory === 'sun') {
        inner = e('g', null,
          e('circle', { cx: 27, cy: 24, r: 9, fill: '#fbbf24' }),
          [0, 45, 90, 135, 180, 225, 270, 315].map((a) =>
            e('line', { key: a, x1: 27, y1: 10, x2: 27, y2: 5, stroke: '#fbbf24', strokeWidth: 2.5, strokeLinecap: 'round', transform: `rotate(${a} 27 24)` })),
        );
      } else if (accessory === 'cloud' || accessory === 'fog') {
        inner = e('g', null,
          e('ellipse', { cx: 18, cy: 28, rx: 10, ry: 7, fill: '#cbd5e1' }),
          e('ellipse', { cx: 30, cy: 24, rx: 11, ry: 8, fill: '#e2e8f0' }),
          e('ellipse', { cx: 40, cy: 29, rx: 9, ry: 6, fill: '#cbd5e1' }),
        );
      } else if (accessory === 'rain') {
        inner = e('g', null,
          e('path', { d: 'M18 6 C18 2 22 2 22 6 L22 26 L14 26 L14 6 C14 2 18 2 18 6 Z', fill: '#60a5fa', transform: 'rotate(14 18 16)' }),
          e('path', { d: 'M13 22 C13 26 17 26 17 22 Z', fill: 'none', stroke: '#3b82f6', strokeWidth: 3, strokeLinecap: 'round' }),
          [24, 32, 40].map((x) => e('line', { key: x, x1: x, y1: 34, x2: x - 3, y2: 41, stroke: '#3b82f6', strokeWidth: 2, strokeLinecap: 'round' })),
        );
      } else if (accessory === 'snow') {
        inner = e('g', null,
          e('path', { d: 'M10 22 Q27 8 44 22 Q27 34 10 22 Z', fill: '#ef4444' }),
          e('path', { d: 'M14 24 Q27 13 40 24', fill: 'none', stroke: '#ffffff', strokeWidth: 3, strokeLinecap: 'round' }),
          e('path', { d: 'M14 22 L12 30 M40 22 L42 30', stroke: '#ef4444', strokeWidth: 2, strokeLinecap: 'round' }),
          [6, 14, 22, 30, 38, 46].map((x) => e('circle', { key: x, cx: x, cy: 44 + (x % 9), r: 2.2, fill: '#93c5fd' })),
        );
      } else if (accessory === 'storm') {
        inner = e('g', null,
          e('ellipse', { cx: 20, cy: 26, rx: 11, ry: 8, fill: '#64748b' }),
          e('ellipse', { cx: 33, cy: 22, rx: 12, ry: 9, fill: '#94a3b8' }),
          e('path', { d: 'M40 12 L34 24 L39 24 L33 36 L47 20 L41 20 L47 12 Z', fill: '#fbbf24' }),
        );
      }
      return e('svg', { className: 'dp-accessory', viewBox: '0 0 54 48', 'aria-hidden': true }, inner);
    }

    // ------------------------------------------------------------------
    // The whale-girl (inline SVG, state-driven)
    // ------------------------------------------------------------------
    function Whale({ phase, dragging }) {
      const open = dragging;
      return e('svg', { className: 'dp-whale', viewBox: '0 0 140 110', 'aria-hidden': true },
        e('defs', null,
          e('linearGradient', { id: 'dp-body', x1: 0, y1: 0, x2: 0, y2: 1 },
            e('stop', { offset: 0, stopColor: '#60a5fa' }),
            e('stop', { offset: 1, stopColor: '#2563eb' }),
          ),
          e('radialGradient', { id: 'dp-belly', cx: 0.5, cy: 0.4, r: 0.7 },
            e('stop', { offset: 0, stopColor: '#ffffff' }),
            e('stop', { offset: 1, stopColor: '#dbeafe' }),
          ),
        ),
        // 鱼尾（左侧）
        e('path', { d: 'M34 64 C14 52 8 70 30 74 L20 92 C24 94 30 88 36 78 C44 84 50 80 48 72 Z', fill: 'url(#dp-body)' }),
        // 身体
        e('ellipse', { cx: 82, cy: 66, rx: 46, ry: 34, fill: 'url(#dp-body)' }),
        // 肚皮
        e('ellipse', { cx: 90, cy: 78, rx: 32, ry: 20, fill: 'url(#dp-belly)' }),
        // 背鳍 / 腹鳍
        e('path', { d: 'M104 44 Q118 30 112 52 Z', fill: 'url(#dp-body)' }),
        e('path', { d: 'M70 94 Q62 104 74 100 Z', fill: 'url(#dp-body)' }),
        // 呆毛（头顶）
        e('path', { d: 'M76 30 Q72 12 84 16 Q80 20 84 24 Q88 18 90 28 Q86 30 82 30 Z', fill: '#2563eb' }),
        e('path', { d: 'M64 34 Q58 20 70 24 Q67 28 70 32 Z', fill: '#3b82f6' }),
        // 眼睛（睁眼组 / 闭眼组切换）
        e('g', { className: 'dp-eye-open' },
          e('ellipse', { cx: 96, cy: 58, rx: 9, ry: 11, fill: '#ffffff' }),
          e('circle', { cx: 97, cy: 59, r: 6, fill: '#0f172a' }),
          e('circle', { cx: 99, cy: 56, r: 2.2, fill: '#ffffff' }),
          e('ellipse', { cx: 66, cy: 58, rx: 9, ry: 11, fill: '#ffffff' }),
          e('circle', { cx: 65, cy: 59, r: 6, fill: '#0f172a' }),
          e('circle', { cx: 67, cy: 56, r: 2.2, fill: '#ffffff' }),
        ),
        e('g', { className: 'dp-eye-closed' },
          e('path', { d: 'M88 60 Q96 66 104 60', fill: 'none', stroke: '#0f172a', strokeWidth: 2.5, strokeLinecap: 'round' }),
          e('path', { d: 'M58 60 Q66 66 74 60', fill: 'none', stroke: '#0f172a', strokeWidth: 2.5, strokeLinecap: 'round' }),
        ),
        // 腮红
        e('ellipse', { cx: 110, cy: 66, rx: 6, ry: 4, fill: '#fda4af', opacity: 0.8 }),
        e('ellipse', { cx: 56, cy: 66, rx: 6, ry: 4, fill: '#fda4af', opacity: 0.8 }),
        // 嘴：微笑（常态/饥饿） 与 张嘴（拖拽）切换
        e('path', { className: 'dp-mouth-smile', d: open ? '' : 'M88 72 Q96 78 104 72', fill: 'none', stroke: '#1e3a8a', strokeWidth: 2.4, strokeLinecap: 'round' }),
        e('g', { className: 'dp-mouth-open' },
          e('ellipse', { cx: 96, cy: 76, rx: 9, ry: 10, fill: '#7f1d1d' }),
          e('ellipse', { cx: 96, cy: 79, rx: 6, ry: 4, fill: '#f87171' }),
          e('path', { d: 'M84 72 Q96 84 108 72', fill: 'none', stroke: '#ffffff', strokeWidth: 1.6, opacity: 0.85 }),
        ),
        // 饿趴下的眼泪
        e('path', { className: 'dp-tear', d: 'M106 70 Q108 76 106 80 Q104 76 106 70 Z', fill: '#60a5fa' }),
      );
    }

    // ------------------------------------------------------------------
    // Speech bubble
    // ------------------------------------------------------------------
    function taskText(task) {
      if (!task) return '还没有任务，正在发呆…';
      const who = [task.provider, task.model].filter(Boolean).join(' / ');
      if (task.kind === 'request') return `正在执行任务 · ${who}`;
      if (task.kind === 'reply') return `${who} 刚刚回复 · +${fmtTokens(task.tokens)} tokens`;
      return `正在执行任务 · ${who}`;
    }

    function Bubble({ snap, taskChanged, show, hovering }) {
      const phase = snap ? snap.satiety.phase : 'ok';
      const v = snap ? snap.satiety.value : 0;
      const cls = ['dp-bubble', (show || hovering) ? '' : 'hidden'].filter(Boolean).join(' ');
      const body = hovering
        ? e('div', { className: 'dp-detail' },
            e('div', { className: 'row' }, e('span', null, '当前任务'), e('b', null, snap && snap.task ? [snap.task.provider, snap.task.model].filter(Boolean).join('/') || '—' : '—')),
            e('div', { className: 'row' }, e('span', null, '本日 Tokens'), e('b', null, snap ? fmtTokens(snap.today.tokens) : '0')),
            e('div', { className: 'row' }, e('span', null, '本日调用'), e('b', null, snap ? String(snap.today.calls) : '0')),
            e('div', { className: 'row' }, e('span', null, '回收垃圾'), e('b', null, snap ? String(snap.trashCount) : '0')),
            e('div', { className: 'row' }, e('span', null, '饱腹度'), e('b', null, `${phaseLabel(phase)} ${Math.round(v)}/${snap ? snap.satiety.max : 100}`)),
            e('div', { className: `dp-satbar ${phase}` }, e('i', { style: { width: `${Math.max(0, Math.min(100, v))}%` } })),
            snap && snap.weather
              ? e('div', { className: 'row' }, e('span', null, '天气'), e('b', null, `${snap.weather.desc || ''}${snap.weather.temp != null ? ` ${snap.weather.temp.toFixed(0)}°C` : ''}${snap.weather.city ? `（${snap.weather.city}）` : ''}`))
              : null,
          )
        : e('div', null,
            e('div', { className: 'dp-bt' }, taskChanged || hovering ? '鲸鱼娘' : '鲸鱼娘'),
            e('div', { className: 'dp-bs' }, taskText(snap && snap.task)),
          );
      return e('div', { className: cls }, body);
    }

    // ------------------------------------------------------------------
    // Main overlay component
    // ------------------------------------------------------------------
    function DesktopPet({ rpc }) {
      const [snap, setSnap] = React.useState(null);
      const [cfg, setCfg] = React.useState(null);
      const [hover, setHover] = React.useState(false);
      const [dragOver, setDragOver] = React.useState(false);
      const [bubble, setBubble] = React.useState({ show: false, changed: false });
      const timerRef = React.useRef(null);
      const lastTaskAtRef = React.useRef(null);

      const load = React.useCallback(async () => {
        try {
          const r = await rpc('pet.state', {});
          if (r && r.ok === true) {
            const next = r.value;
            setSnap(next);
            if (next.config && next.config.bubble && next.config.bubble.enabled && next.task && next.task.at !== lastTaskAtRef.current) {
              lastTaskAtRef.current = next.task.at;
              setBubble({ show: true, changed: true });
              if (timerRef.current) clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setBubble((b) => ({ ...b, show: false })), next.config.bubble.ms || 4000);
            }
          }
        } catch { /* RPC 不可用时保持现状 */ }
      }, [rpc]);

      const loadCfg = React.useCallback(async () => {
        try {
          const r = await rpc('pet.config.get', {});
          if (r && r.ok === true) setCfg(r.value.config);
        } catch { /* ignore */ }
      }, [rpc]);

      React.useEffect(() => {
        mountCss();
        load();
        loadCfg();
        const pollMs = cfg && cfg.pollMs ? cfg.pollMs : 15000;
        const iv = setInterval(load, pollMs);
        return () => { clearInterval(iv); if (timerRef.current) clearTimeout(timerRef.current); };
      }, [load, loadCfg, cfg]);

      const onDrop = async (ev) => {
        ev.preventDefault();
        setDragOver(false);
        const files = Array.from(ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files : []);
        const paths = files.map((f) => (typeof f.path === 'string' && f.path ? f.path : '')).filter(Boolean);
        if (paths.length === 0) {
          setBubble({ show: true, changed: true });
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setBubble((b) => ({ ...b, show: false })), 5000);
          return;
        }
        try {
          const r = await rpc('pet.trash', { paths });
          const n = r && r.ok === true ? (r.value.trashed || []).length : 0;
          const failed = r && r.value && r.value.failed ? r.value.failed : [];
          setBubble({
            show: true,
            changed: true,
            text: n > 0
              ? `啊呜～吃掉 ${n} 个文件（已移至回收站）${failed.length ? `，${failed.length} 个失败` : ''}`
              : `没能吃到：${failed[0] ? failed[0].reason : '未知原因'}`,
          });
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setBubble((b) => ({ ...b, show: false })), 5000);
          load();
        } catch {
          setBubble({ show: true, changed: true, text: '回收失败了（RPC 不可用）' });
        }
      };

      const phase = snap ? snap.satiety.phase : 'ok';
      const petCls = ['dp-pet', phase, dragOver ? 'dragging' : ''].join(' ');
      const accessory = snap && snap.weather ? snap.weather.accessory : null;
      const showBubble = bubble.show || hover;

      return e('div', { className: 'dp-root' },
        e('div', {
          className: petCls,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onDragOver: (ev) => { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); },
          onDragLeave: () => setDragOver(false),
          onDrop,
          title: '把要清理的文件拖到鲸鱼娘身上，她会吃掉（移到回收站）',
        },
          e(Bubble, { snap, show: showBubble, hovering: hover, taskChanged: bubble.changed }),
          e(Accessory, { accessory }),
          e(Whale, { phase, dragging: dragOver }),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Settings page (settings.section)
    // ------------------------------------------------------------------
    function NumField({ label, value, onChange, step, min, hint }) {
      return e('label', { className: 'dp-field' },
        e('span', null, label, hint ? e('span', { className: 'ut-hint' }, ` ${hint}`) : null),
        e('input', { className: 'ut-input', type: 'number', step: step || 1, min: min !== undefined ? min : 0, value: value, onChange: (ev) => onChange(Number(ev.target.value)) }),
      );
    }

    function PetSettings({ rpc }) {
      const [cfg, setCfg] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [msg, setMsg] = React.useState('');
      React.useEffect(() => {
        rpc('pet.config.get', {}).then((r) => { if (r && r.ok === true) setCfg(r.value.config); }).catch(() => {});
      }, [rpc]);
      if (!cfg) return e('div', { className: 'dp-settings' }, e('p', { className: 'ut-hint' }, '加载配置中…'));
      const patch = (path, value) => {
        const next = JSON.parse(JSON.stringify(cfg));
        const keys = path.split('.');
        let cur = next;
        while (keys.length > 1) cur = cur[keys.shift()];
        cur[keys[0]] = value;
        setCfg(next);
        setMsg('');
      };
      const save = async () => {
        setSaving(true);
        try {
          const r = await rpc('pet.config.update', { ...cfg });
          setMsg(r && r.ok === true ? '已保存 ✓' : `保存失败：${r && r.error ? r.error.message : '未知'}`);
        } catch {
          setMsg('保存失败（RPC 不可用）');
        } finally {
          setSaving(false);
        }
      };
      const s = cfg.satiety;
      const b = cfg.bubble;
      const w = cfg.weather;
      return e('div', { className: 'dp-settings' },
        e('div', { className: 'ut-row', style: { marginBottom: 8 } },
          e('label', { className: 'ut-row', style: { gap: 6 } },
            e('input', { type: 'checkbox', checked: cfg.enabled, onChange: (ev) => patch('enabled', ev.target.checked) }),
            e('span', { className: 'ut-muted' }, '显示桌面宠物'),
          ),
        ),
        e('div', { className: 'dp-section' },
          e('h4', null, '饱腹状态机'),
          e('div', { className: 'dp-grid' },
            e(NumField, { label: '初始饱腹度', value: s.start, onChange: (v) => patch('satiety.start', v), min: 0 }),
            e(NumField, { label: '饱腹上限', value: s.max, onChange: (v) => patch('satiety.max', v), min: 1 }),
            e(NumField, { label: '衰减速度', value: s.decayPerMin, onChange: (v) => patch('satiety.decayPerMin', v), step: 0.05, hint: '点/分钟' }),
            e(NumField, { label: '饥饿阈值', value: s.hungryBelow, onChange: (v) => patch('satiety.hungryBelow', v), min: 0 }),
            e(NumField, { label: '趴下阈值', value: s.collapsedBelow, onChange: (v) => patch('satiety.collapsedBelow', v), min: 0 }),
            e(NumField, { label: '饿多久趴下', value: s.collapseDelayMin, onChange: (v) => patch('satiety.collapseDelayMin', v), min: 0, hint: '分钟' }),
            e(NumField, { label: 'Tokens/饱腹点', value: s.tokensPerPoint, onChange: (v) => patch('satiety.tokensPerPoint', v), step: 10000, hint: '每 1 点' }),
            e(NumField, { label: '垃圾/饱腹点', value: s.filePoint, onChange: (v) => patch('satiety.filePoint', v), min: 0, hint: '每文件 +点' }),
          ),
        ),
        e('div', { className: 'dp-section' },
          e('h4', null, '任务气泡'),
          e('div', { className: 'dp-grid' },
            e('label', { className: 'ut-row', style: { gap: 6 } },
              e('input', { type: 'checkbox', checked: b.enabled, onChange: (ev) => patch('bubble.enabled', ev.target.checked) }),
              e('span', { className: 'ut-muted' }, '任务变化时显示气泡'),
            ),
            e(NumField, { label: '气泡显示时长', value: b.ms, onChange: (v) => patch('bubble.ms', v), step: 500, hint: '毫秒（0=立即消失）' }),
          ),
        ),
        e('div', { className: 'dp-section' },
          e('h4', null, '天气配饰'),
          e('div', { className: 'dp-grid' },
            e('label', { className: 'ut-row', style: { gap: 6 } },
              e('input', { type: 'checkbox', checked: w.enabled, onChange: (ev) => patch('weather.enabled', ev.target.checked) }),
              e('span', { className: 'ut-muted' }, '启用天气'),
            ),
            e('label', { className: 'ut-row', style: { gap: 6 } },
              e('input', { type: 'checkbox', checked: w.auto, onChange: (ev) => patch('weather.auto', ev.target.checked) }),
              e('span', { className: 'ut-muted' }, '自动定位（IP）'),
            ),
            e(NumField, { label: '纬度（可选）', value: w.lat ?? 0, onChange: (v) => patch('weather.lat', v), step: 0.0001, min: -90 }),
            e(NumField, { label: '经度（可选）', value: w.lon ?? 0, onChange: (v) => patch('weather.lon', v), step: 0.0001, min: -180 }),
            e('label', { className: 'dp-field' },
              e('span', null, '城市（可选）'),
              e('input', { className: 'ut-input', type: 'text', placeholder: '如 北京', value: w.city, onChange: (ev) => patch('weather.city', ev.target.value) }),
            ),
          ),
        ),
        e('div', { className: 'ut-row', style: { marginTop: 12 } },
          e('button', { className: 'ut-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存设置'),
          msg ? e('span', { className: 'ut-muted' }, msg) : null,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Cordis client plugin
    // ------------------------------------------------------------------
    const inject = ['slots', 'connection'];

    function apply(ctx) {
      const rpc = (endpoint, payload) =>
        ctx.connection.rpc.call('/desktop-pet', endpoint, payload);

      // 右下角浮层宠物。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'desktop-pet',
          order: 1000,
          label: () => '桌面宠物',
          inject: () => ({ rpc }),
        },
        (props) => e(DesktopPet, props),
      ));

      // 设置页。
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'desktop-pet',
          order: 40,
          label: () => '桌面宠物',
          inject: () => ({ rpc }),
        },
        (props) => e(PetSettings, props),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
