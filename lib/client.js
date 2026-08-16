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
.dp-pet{position:relative;pointer-events:auto;cursor:grab;width:164px;height:252px;transition:transform .35s ease}
.dp-pet.hungry .dp-whale-img{animation:dp-slouch 3.4s ease-in-out infinite}
@keyframes dp-slouch{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
.dp-pet.ok .dp-whale-img{animation:dp-breathe 3.2s ease-in-out infinite}
@keyframes dp-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.015)}}
.dp-bubble{position:absolute;right:-4px;bottom:calc(100% + 8px);width:264px;max-width:min(300px,calc(100vw - 36px));background:linear-gradient(180deg,#ffffff,#f4f8ff);border:1.5px solid #93c5fd;border-radius:14px;padding:9px 12px;box-shadow:0 6px 18px rgba(37,99,235,.16);transition:opacity .28s ease,transform .28s ease;transform-origin:90% 100%;pointer-events:auto;word-break:break-word}
.dp-bubble.below{top:calc(100% + 10px);bottom:auto;transform-origin:90% 0}
.dp-bubble.below::after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:#93c5fd}
.dp-bubble.below::before{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:#ffffff}
.dp-bubble.hidden{opacity:0;transform:scale(.9);pointer-events:none}
.dp-bubble::after{content:'';position:absolute;right:26px;top:100%;border:8px solid transparent;border-top-color:#93c5fd}
.dp-bubble::before{content:'';position:absolute;right:27px;top:100%;border:7px solid transparent;border-top-color:#ffffff}
.dp-bt{font-size:12px;line-height:17px;color:#1e3a8a;font-weight:600}
.dp-bs{font-size:11px;line-height:16px;color:#64748b;margin-top:3px;word-break:break-word}
.dp-detail{display:grid;gap:4px;margin-top:6px;font-size:11px;line-height:16px;color:#334155}
.dp-detail .row{display:flex;justify-content:space-between;gap:8px}
.dp-detail .row b{color:#0f172a;font-weight:650;flex:1;text-align:right;word-break:break-all;min-width:0}
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
.dp-img-wrap{position:relative;width:100%;height:100%;overflow:hidden;border-radius:12px;box-sizing:border-box;padding:14px 4px 4px}
.dp-whale-img{width:100%;height:100%;object-fit:contain;transition:transform .9s ease}
.dp-img-placeholder{background:transparent}
.dp-pet.ok .dp-whale-img{animation:dp-breathe 3.2s ease-in-out infinite}
.dp-pet.hungry .dp-whale-img{animation:dp-slouch 3.4s ease-in-out infinite}
.dp-pet.collapsed .dp-img-wrap{transform:rotate(90deg) translateY(8px) scale(.85);transition:transform 1.1s ease-in-out}
.dp-pet.collapsed .dp-whale-img{animation:none}
.dp-root.hidden{opacity:0;pointer-events:none;transition:opacity .3s ease}
.dp-dock{position:fixed;right:14px;bottom:10px;width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.97);border:1.5px solid #93c5fd;box-shadow:0 4px 14px rgba(37,99,235,.3);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:19px;pointer-events:auto;z-index:2147483000}
.dp-dock:hover{background:#eff6ff}
.dp-err{margin-top:5px;font-size:10.5px;line-height:15px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:4px 6px}
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
        // 明亮蓬松白云（雾天共用同款，不再灰扑扑）
        inner = e('g', null,
          e('ellipse', { cx: 18, cy: 29, rx: 10, ry: 7, fill: '#ffffff' }),
          e('ellipse', { cx: 31, cy: 25, rx: 12, ry: 9, fill: '#e0f2fe' }),
          e('ellipse', { cx: 41, cy: 30, rx: 9, ry: 6, fill: '#ffffff' }),
        );
      } else if (accessory === 'rain') {
        // 粉色小伞 + 天蓝色雨滴：下雨也软萌不阴沉
        inner = e('g', null,
          // 伞面
          e('path', { d: 'M7 20 Q27 0 47 20 Z', fill: '#f9a8d4' }),
          e('path', { d: 'M7 20 Q27 0 47 20 Z', fill: 'none', stroke: '#ec4899', strokeWidth: 1.4, strokeLinecap: 'round' }),
          // 伞骨
          [10, 18, 27, 36, 44].map((x) => e('line', { key: x, x1: x, y1: 19.5, x2: 27, y2: 7, stroke: '#ec4899', strokeWidth: 1, strokeLinecap: 'round' })),
          // 伞尖
          e('line', { x1: 27, y1: 0.5, x2: 27, y2: 4.5, stroke: '#f472b6', strokeWidth: 2, strokeLinecap: 'round' }),
          // 伞柄
          e('path', { d: 'M27 20 Q27 34 19 36', fill: 'none', stroke: '#f472b6', strokeWidth: 2.4, strokeLinecap: 'round' }),
          // 伞下小雨滴（深浅两层，有层次感）
          [9, 19, 37, 45].map((x) => e('path', { key: x, d: `M${x} 31 q-1.7 3.2 0 4 q1.7 -0.8 0 -4 Z`, fill: '#38bdf8' })),
          [14, 28, 41].map((x) => e('path', { key: `d2${x}`, d: `M${x} 37 q-1.4 2.6 0 3.2 q1.4 -0.6 0 -3.2 Z`, fill: '#7dd3fc' })),
        );
      } else if (accessory === 'snow') {
        // 红围巾 + 亮色雪点
        inner = e('g', null,
          e('path', { d: 'M10 22 Q27 8 44 22 Q27 34 10 22 Z', fill: '#f87171' }),
          e('path', { d: 'M14 24 Q27 13 40 24', fill: 'none', stroke: '#ffffff', strokeWidth: 3, strokeLinecap: 'round' }),
          e('path', { d: 'M14 22 L12 30 M40 22 L42 30', stroke: '#f87171', strokeWidth: 2, strokeLinecap: 'round' }),
          [6, 14, 22, 30, 38, 46].map((x) => e('circle', { key: x, cx: x, cy: 44 + (x % 9), r: 2.2, fill: '#bfdbfe' })),
        );
      } else if (accessory === 'storm') {
        // 浅色云 + 金色闪电（雷暴也走明亮可爱路线）
        inner = e('g', null,
          e('ellipse', { cx: 20, cy: 27, rx: 11, ry: 8, fill: '#e2e8f0' }),
          e('ellipse', { cx: 33, cy: 23, rx: 12, ry: 9, fill: '#cbd5e1' }),
          e('path', { d: 'M40 12 L34 24 L39 24 L33 36 L47 20 L41 20 L47 12 Z', fill: '#fbbf24' }),
        );
      }
      return e('svg', { className: 'dp-accessory', viewBox: '0 0 54 48', 'aria-hidden': true }, inner);
    }

    // ------------------------------------------------------------------
    // The whale-girl: PNG artwork (no inline-SVG fallback — assets are
    // bundled, so the default whale icon would only flash while a pose
    // image loads; we show a transparent placeholder instead)
    // ------------------------------------------------------------------
    function Whale({ phase, imageSrc }) {
      if (imageSrc) {
        return e('div', { className: 'dp-img-wrap' },
          e('img', { className: 'dp-whale-img', src: imageSrc, draggable: false, alt: '鲸鱼娘' }),
        );
      }
      // 图未就绪或加载失败：透明占位（保持框尺寸，避免布局跳动），绝不回退默认 SVG 图标
      return e('div', { className: 'dp-img-wrap dp-img-placeholder' });
    }

    // ------------------------------------------------------------------
    // Speech bubble
    // ------------------------------------------------------------------
    function taskText(task, sessionTitle) {
      if (!task) return '还没有任务，正在发呆…';
      const name = task.title || sessionTitle || [task.provider, task.model].filter(Boolean).join(' / ') || '未知任务';
      if (task.kind === 'request') return `正在执行任务 · ${name}`;
      if (task.kind === 'reply') return `${name} 刚刚回复 · +${fmtTokens(task.tokens)} tokens`;
      return `正在执行任务 · ${name}`;
    }

    function Bubble({ snap, taskChanged, show, hovering, errText, below }) {
      const phase = snap ? snap.satiety.phase : 'ok';
      const v = snap ? snap.satiety.value : 0;
      const cls = ['dp-bubble', below ? 'below' : '', (show || hovering) ? '' : 'hidden'].filter(Boolean).join(' ');
      const prog = snap && snap.progress ? snap.progress : null;
      const taskName = snap ? (snap.task && snap.task.title) || snap.sessionTitle || [snap.task && snap.task.provider, snap.task && snap.task.model].filter(Boolean).join('/') || '—' : '—';
      const body = hovering
        ? e('div', { className: 'dp-detail' },
            e('div', { className: 'row' }, e('span', null, '当前任务'), e('b', null, taskName)),
            prog
              ? e('div', { className: 'row' }, e('span', null, '进度'), e('b', null, `${prog.label} ${Math.round(prog.pct)}%`))
              : null,
            prog && prog.toolName
              ? e('div', { className: 'row' }, e('span', null, '工具'), e('b', null, `${prog.toolName}${prog.toolCount > 1 ? ` ×${prog.toolCount}` : ''}`))
              : null,
            e('div', { className: 'row' }, e('span', null, '本日 Tokens'), e('b', null, snap ? fmtTokens(snap.today.tokens) : '0')),
            e('div', { className: 'row' }, e('span', null, '本日调用'), e('b', null, snap ? String(snap.today.calls) : '0')),
            e('div', { className: 'row' }, e('span', null, '饱腹度'), e('b', null, `${phaseLabel(phase)} ${Math.round(v)}/${snap ? snap.satiety.max : 100}`)),
            e('div', { className: `dp-satbar ${phase}` }, e('i', { style: { width: `${Math.max(0, Math.min(100, v))}%` } })),
            snap && snap.weather
              ? e('div', { className: 'row' }, e('span', null, '天气'), e('b', null, `${snap.weather.desc || ''}${snap.weather.temp != null ? ` ${snap.weather.temp.toFixed(0)}°C` : ''}${snap.weather.city ? `（${snap.weather.city}）` : ''}`))
              : null,
            errText ? e('div', { className: 'dp-err' }, errText) : null,
          )
        : e('div', null,
            e('div', { className: 'dp-bs' }, taskText(snap && snap.task, snap && snap.sessionTitle)),
            errText ? e('div', { className: 'dp-err' }, errText) : null,
          );
      return e('div', { className: cls }, body);
    }

    // ------------------------------------------------------------------
    // Main overlay component
    // ------------------------------------------------------------------
    // 姿态 → 资产名映射（host assets/ 目录）
    const POSE_ASSET = {
      idle: 'left',
      working: 'whale-maid-show',
      surprised: 'whale-maid-surprised',
      wave: 'whale-maid-wave',
      hungry: 'whale-maid-shy',
      collapsed: 'whale-maid-scold',
    };
    // 形象资源缓存（module 级，避免重复 RPC）
    const imgCacheMap = {};

    // 后台预取全部姿态立绘到模块缓存：首次挂载时拉取所有姿态图，
    // 之后姿态切换（惊讶/挥手/饥饿/趴下等）直接命中缓存，不会闪现占位。
    // 逐个串行拉取 + 降采样，避免 6 张 2MB 原图同时解码卡顿。
    function prefetchAllPoses(rpc) {
      const names = Object.values(POSE_ASSET);
      let i = 0;
      const step = () => {
        while (i < names.length && imgCacheMap[names[i]]) i++;
        if (i >= names.length) return;
        const name = names[i++];
        rpc('pet.asset', { name }).then((r) => {
          if (r && r.ok === true && r.value && r.value.base64) {
            const src = `data:${r.value.mime || 'image/webp'};base64,${r.value.base64}`;
            return downscaleImage(src, 492, 756).then((small) => { imgCacheMap[name] = small; });
          }
        }).catch(() => {}).then(step);
      };
      step();
    }

    // 大图降采样：姿态 PNG 原图 1024x1536（~2MB），直接喂给 <img> 持续做
    // breathe 动画会让每帧重绘整张大图 → 卡顿。用 canvas 一次性缩到显示尺寸
    // 附近（2x 供高分屏），缓存小图后动画开销可忽略。
    function downscaleImage(dataUrl, targetW, targetH) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(1, targetW / img.width, targetH / img.height);
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const cx = c.getContext('2d');
            cx.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/webp', 0.92));
          } catch { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });
    }

    function DesktopPet({ rpc }) {
      const [snap, setSnap] = React.useState(null);
      const [cfg, setCfg] = React.useState(null);
      const [hover, setHover] = React.useState(false);
      const [bubble, setBubble] = React.useState({ show: false, changed: false });
      const [imgSrc, setImgSrc] = React.useState(null);
      const [errText, setErrText] = React.useState(null);
      const timerRef = React.useRef(null);
      const lastTaskAtRef = React.useRef(null);
      const rootRef = React.useRef(null);
      const dragState = React.useRef(null);

      // 移动端（手机/平板 UA）不显示宠物（可在设置中关闭）
      const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

      // 当前姿态 → 资产名（snapshot.pose；缺省 idle）
      const pose = (snap && snap.pose) || 'idle';
      const poseAsset = POSE_ASSET[pose] || 'left';

      // 按姿态加载形象（host 以 base64 提供；未就绪时显示透明占位）。
      // 姿态变化才重新拉取；缓存命中（含后台预取）则直接切换。
      React.useEffect(() => {
        if (imgCacheMap[poseAsset]) { setImgSrc(imgCacheMap[poseAsset]); return; }
        let alive = true;
        rpc('pet.asset', { name: poseAsset }).then((r) => {
          if (alive && r && r.ok === true && r.value && r.value.base64) {
            const src = `data:${r.value.mime || 'image/webp'};base64,${r.value.base64}`;
            // 显示框 164x252（2:3，与立绘同比例，contain 全身显示）→ 目标 492x756（3x 供高分屏）
            downscaleImage(src, 492, 756).then((small) => {
              if (!alive) return;
              imgCacheMap[poseAsset] = small;
              setImgSrc(small);
            });
          }
        }).catch(() => {});
        return () => { alive = false; };
      }, [rpc, poseAsset]);

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
        // 后台预取全部姿态立绘，姿态切换零等待（不闪现占位）
        prefetchAllPoses(rpc);
        // 固定轮询间隔（cfg 变化不再重启 effect —— 否则 cfg 每次新引用会让
        // effect 无限重跑，cleanup 反复清掉气泡定时器导致气泡永不隐藏）
        const iv = setInterval(load, 15000);
        // 提升 shell.overlay 容器 z-index（原本仅 20），避免被侧边栏/详情列遮挡。
        // 只改祖先容器的 z-index，不移动任何 DOM 节点。
        const liftOverlay = () => {
          let el = document.querySelector('.dp-root') && document.querySelector('.dp-root').parentElement;
          while (el && el !== document.body) {
            const cls = String(el.className || '');
            if (cls.includes('_overlayLayer')) {
              el.style.zIndex = '2147483000';
              return;
            }
            el = el.parentElement;
          }
        };
        liftOverlay();
        // 布局/重挂载后再补一次
        const t = setTimeout(liftOverlay, 800);
        return () => { clearTimeout(t); clearInterval(iv); if (timerRef.current) clearTimeout(timerRef.current); };
      }, [load, loadCfg]);

      const showErr = (text) => {
        setErrText(text);
        setBubble({ show: true, changed: true });
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { setErrText(null); setBubble((b) => ({ ...b, show: false })); }, 10000);
      };

      // 应用持久化位置（拖动后保存到 host state.petPos）
      React.useEffect(() => {
        const root = rootRef.current;
        if (root && snap && snap.petPos) {
          root.style.left = `${snap.petPos.x}px`;
          root.style.top = `${snap.petPos.y}px`;
          root.style.right = 'auto';
          root.style.bottom = 'auto';
        }
      }, [snap]);

      // 鼠标按住宠物可拖动位置（与系统拖文件回收互不干扰）
      const onPetMouseDown = (e) => {
        if (e.button !== 0) return;
        const root = rootRef.current;
        if (!root) return;
        e.preventDefault();
        setHover(false);
        const r = root.getBoundingClientRect();
        dragState.current = { startX: e.clientX, startY: e.clientY, left: r.left, top: r.top, moved: false };
        const onMove = (ev) => {
          const ds = dragState.current;
          if (!ds) return;
          const dx = ev.clientX - ds.startX;
          const dy = ev.clientY - ds.startY;
          if (Math.abs(dx) + Math.abs(dy) > 3) ds.moved = true;
          const w = r.width;
          const h = r.height;
          const nx = Math.max(0, Math.min(window.innerWidth - w, ds.left + dx));
          const ny = Math.max(0, Math.min(window.innerHeight - h, ds.top + dy));
          root.style.left = `${nx}px`;
          root.style.top = `${ny}px`;
          root.style.right = 'auto';
          root.style.bottom = 'auto';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const ds = dragState.current;
          dragState.current = null;
          if (ds && ds.moved) {
            const rect = root.getBoundingClientRect();
            rpc('pet.pos.update', { x: Math.round(rect.left), y: Math.round(rect.top) }).catch(() => {});
            load();
          }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      const phase = snap ? snap.satiety.phase : 'ok';
      const windowOpen = !!(snap && snap.windowOpen);
      const petCls = ['dp-pet', phase].join(' ');
      const accessory = snap && snap.weather ? snap.weather.accessory : null;
      const showBubble = bubble.show || hover;
      // 宠物被拖到窗口上部时，气泡改为向下显示，避免超出视口被截断
      const bubbleBelow = !!(snap && snap.petPos && snap.petPos.y < 150);

      // 移动端隐藏（默认开启；设置页可关）
      if (isMobileUA && cfg && cfg.mobile && cfg.mobile.hide !== false) return null;

      return e('div', null,
        e('div', { className: 'dp-root', ref: rootRef },
          e('div', {
            className: petCls,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            onMouseDown: onPetMouseDown,
            title: '按住可拖动位置',
          },
            e(Bubble, { snap, show: showBubble, hovering: hover, taskChanged: bubble.changed, errText, below: bubbleBelow }),
            e(Accessory, { accessory }),
            e(Whale, { phase, imageSrc: imgSrc }),
          ),
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
      const m = cfg.mobile || {};
      return e('div', { className: 'dp-settings' },
        e('div', { className: 'ut-row', style: { marginBottom: 8 } },
          e('label', { className: 'ut-row', style: { gap: 6 } },
            e('input', { type: 'checkbox', checked: cfg.enabled, onChange: (ev) => patch('enabled', ev.target.checked) }),
            e('span', { className: 'ut-muted' }, '显示桌面宠物'),
          ),
        ),
        e('div', { className: 'dp-section' },
          e('h4', null, '显示范围'),
          e('div', { className: 'dp-grid' },
            e('label', { className: 'ut-row', style: { gap: 6 } },
              e('input', { type: 'checkbox', checked: m.hide !== false, onChange: (ev) => patch('mobile.hide', ev.target.checked) }),
              e('span', { className: 'ut-muted' }, '手机/平板（移动端）不显示宠物'),
            ),
            e('span', { className: 'ut-hint' }, '桌面窗口与网页显示，手机上不显示；按住宠物可拖动位置'),
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
            e('label', { className: 'dp-field' },
              e('span', null, '城市'),
              e('input', { className: 'ut-input', type: 'text', placeholder: '如 北京、上海、重庆', value: w.city, onChange: (ev) => patch('weather.city', ev.target.value) }),
            ),
            e(NumField, { label: '纬度（可选，二选一）', value: w.lat ?? 0, onChange: (v) => patch('weather.lat', v), step: 0.0001, min: -90 }),
            e(NumField, { label: '经度（可选，二选一）', value: w.lon ?? 0, onChange: (v) => patch('weather.lon', v), step: 0.0001, min: -180 }),
            e('span', { className: 'ut-hint' }, '手动选择城市（或填写经纬度）后保存，宠物会按当地天气佩戴配饰'),
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
