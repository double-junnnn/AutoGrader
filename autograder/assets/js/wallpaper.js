/* AutoGrader · 玻璃主题壁纸
 *
 * 给玻璃主题铺一层壁纸：半透面板 + backdrop-filter 会把壁纸糊成"材质"，
 * 这正是 visionOS 那套做法 —— 背景有内容，玻璃才有东西可折射，立体感立刻出来。
 *
 * 三个设计决定：
 *   1. **只服务玻璃主题**。卡通主题是平涂描边风格，铺壁纸只会跟描边打架，所以不生效。
 *   2. **预设壁纸用纯 CSS 多层渐变，不用位图**。零体积（单文件版不能因为壁纸变大）、
 *      任意分辨率都不糊，且离线可用。想要照片感就自己上传。
 *   3. **雾化（veil）是必要的，不是装饰**。浅玻璃是深色字，压在深色照片上会看不清；
 *      深玻璃是白色字，压在浅色照片上同样糊。所以壁纸上再叠一层半透明兜底色 ——
 *      浅玻璃叠白、深玻璃叠黑，强度让用户自己调（默认 0.34）。
 *
 * 上传的图片在本机压缩后存 localStorage：最长边 1920、JPEG 编码，
 * 再按体积自动降质量，避免撑爆 5MB 配额；存不下会回滚并如实告知。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const KEY = 'wallpaper';
  const GLASS = { classic: true, tech: true };
  const VEIL = { classic: [255, 255, 255], tech: [8, 10, 22] };
  const DEFAULT = { id: 'none', custom: '', veil: 0.34 };

  const MAX_W = 1920;
  const MAX_H = 1200;
  const MAX_BYTES = 1.1e6;   // data URL 长度上限，留足 localStorage 余量

  function P(id, name, css) { return { id: id, name: name, css: css }; }

  /* 预设：每款都是「三团径向光晕 + 一层底色线性渐变」，模拟真实壁纸的光照分布。
     前四款压暗底（配深玻璃舒服），后两款是浅底（配浅玻璃舒服），用户随意搭。 */
  const PRESETS = [
    P('none', '无', ''),
    P('aurora', '极光',
      'radial-gradient(105% 78% at 14% 6%, rgba(72, 236, 198, .55), rgba(72, 236, 198, 0) 56%),' +
      'radial-gradient(96% 72% at 86% 16%, rgba(146, 108, 255, .55), rgba(146, 108, 255, 0) 58%),' +
      'radial-gradient(120% 92% at 48% 112%, rgba(28, 118, 196, .58), rgba(28, 118, 196, 0) 62%),' +
      'linear-gradient(166deg, #06192a 0%, #0c2a3f 46%, #071a2c 100%)'),
    P('dusk', '暮色',
      'radial-gradient(100% 74% at 18% 88%, rgba(255, 148, 92, .62), rgba(255, 148, 92, 0) 58%),' +
      'radial-gradient(98% 76% at 82% 12%, rgba(178, 96, 232, .55), rgba(178, 96, 232, 0) 60%),' +
      'linear-gradient(196deg, #2b1032 0%, #47203c 48%, #150a1c 100%)'),
    P('ocean', '深海',
      'radial-gradient(108% 80% at 20% 14%, rgba(56, 208, 232, .48), rgba(56, 208, 232, 0) 56%),' +
      'radial-gradient(110% 86% at 78% 96%, rgba(24, 78, 168, .55), rgba(24, 78, 168, 0) 60%),' +
      'linear-gradient(170deg, #041b2c 0%, #0a2c46 50%, #04182a 100%)'),
    P('graphite', '石墨',
      'radial-gradient(104% 76% at 26% 10%, rgba(255, 255, 255, .16), rgba(255, 255, 255, 0) 58%),' +
      'radial-gradient(104% 80% at 82% 92%, rgba(120, 140, 170, .22), rgba(120, 140, 170, 0) 62%),' +
      'linear-gradient(172deg, #16181d 0%, #22262e 48%, #14161b 100%)'),
    P('mist', '晨雾',
      'radial-gradient(102% 78% at 16% 12%, rgba(255, 255, 255, .85), rgba(255, 255, 255, 0) 58%),' +
      'radial-gradient(104% 82% at 84% 90%, rgba(176, 206, 240, .55), rgba(176, 206, 240, 0) 62%),' +
      'linear-gradient(168deg, #eef4fc 0%, #dfe9f6 46%, #eaf1fa 100%)'),
    P('dune', '沙丘',
      'radial-gradient(104% 78% at 20% 88%, rgba(226, 178, 128, .55), rgba(226, 178, 128, 0) 60%),' +
      'radial-gradient(102% 74% at 82% 10%, rgba(255, 246, 230, .80), rgba(255, 246, 230, 0) 58%),' +
      'linear-gradient(172deg, #f7efe4 0%, #eeddc8 48%, #f5ebe0 100%)'),
  ];

  function presetOf(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  function get() {
    const raw = U.store.get(KEY, null);
    if (!raw || typeof raw !== 'object') return Object.assign({}, DEFAULT);
    return {
      id: raw.id || 'none',
      custom: typeof raw.custom === 'string' ? raw.custom : '',
      veil: U.clamp(Number(raw.veil) === Number(raw.veil) ? Number(raw.veil) : DEFAULT.veil, 0, 0.85),
    };
  }

  function save(w) {
    // store.set 在配额超限时返回 false，让调用方能回滚并如实告知，而不是静默丢图
    return U.store.set(KEY, w);
  }

  /**
   * 拼出 --bg-image 的值。
   * 返回 null 表示「这一层不该由壁纸接管」—— 此时必须把 inline 变量撤掉，
   * 让主题自带的渐变重新生效（切换主题、关掉壁纸都走这条路）。
   */
  function build(w, theme) {
    if (!w || !w.id || w.id === 'none') return null;
    if (!GLASS[theme]) return null;
    const layer = w.id === 'custom'
      ? (w.custom ? 'url("' + w.custom + '")' : null)
      : (presetOf(w.id) || {}).css;
    if (!layer) return null;
    const veil = U.clamp(Number(w.veil) || 0, 0, 0.85);
    if (!veil) return layer;
    const c = VEIL[theme] || VEIL.classic;
    const rgba = 'rgba(' + c.join(', ') + ', ' + veil + ')';
    return 'linear-gradient(' + rgba + ', ' + rgba + '), ' + layer;
  }

  /** 把壁纸写进 html 的 inline --bg-image（inline 优先于主题选择器里的定义）。
   *  由 theme.apply() 调用，保证切换主题后立刻按新主题重算雾化色。 */
  function apply(theme) {
    const t = theme || (AG.theme && AG.theme.get()) || 'classic';
    const w = get();
    const val = build(w, t);
    const root = document.documentElement;
    if (val) root.style.setProperty('--bg-image', val);
    else root.style.removeProperty('--bg-image');
    return val;
  }

  function set(id) {
    const w = get();
    const ok = (id === 'custom' && !!w.custom) || !!presetOf(id);
    w.id = ok ? id : 'none';
    save(w);
    apply();
    return w;
  }

  function setVeil(v) {
    const w = get();
    w.veil = U.clamp(Number(v) || 0, 0, 0.85);
    save(w);
    apply();
    return w.veil;
  }

  /** 把用户选的图片压到可用尺寸并保存；存不下就回滚。 */
  function setCustomFromImage(img) {
    const k = Math.min(MAX_W / (img.width || 1), MAX_H / (img.height || 1), 1);
    const w = Math.max(1, Math.round((img.width || 1) * k));
    const h = Math.max(1, Math.round((img.height || 1) * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    // 先铺白底：带透明通道的 PNG 转 JPEG 后透明区会变黑，浅色主题下很突兀
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = 0.84;
    let url = c.toDataURL('image/jpeg', q);
    while (url.length > MAX_BYTES && q > 0.45) {
      q -= 0.1;
      url = c.toDataURL('image/jpeg', q);
    }
    const cur = get();
    const prev = { id: cur.id, custom: cur.custom };
    cur.id = 'custom';
    cur.custom = url;
    if (!save(cur)) {
      const back = get();
      back.id = prev.id;
      back.custom = prev.custom;
      save(back);
      return { ok: false, note: '这张图太大了，本机存不下。换一张小一点的试试（或先删掉旧图）。' };
    }
    apply();
    return { ok: true, bytes: url.length };
  }

  /** 读文件 → 解码 → 压缩。任何一步失败都给可执行的提示，不抛到界面上。 */
  function upload(file, done) {
    const cb = done || function () {};
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      cb({ ok: false, note: '这里只吃图片文件（PNG / JPEG / WebP）。' });
      return;
    }
    if (typeof FileReader !== 'function') {
      cb({ ok: false, note: '当前环境不支持读取本地图片。' });
      return;
    }
    const fr = new FileReader();
    fr.onerror = () => cb({ ok: false, note: '读取这张图失败了，换一张试试。' });
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => cb({ ok: false, note: '这张图无法解析，换一张试试。' });
      img.onload = () => {
        try { cb(setCustomFromImage(img)); }
        catch (e) { cb({ ok: false, note: '处理这张图时出错：' + e.message }); }
      };
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  }

  function clearCustom() {
    const w = get();
    w.custom = '';
    if (w.id === 'custom') w.id = 'none';
    save(w);
    apply();
    return w;
  }

  /* ---------------- 设置页 UI ---------------- */

  /** 提示统一走事件总线：wallpaper 模块不认识 app.js 的 toast，由 app 侧订阅后展示。 */
  function note(text, kind) {
    U.bus.emit('wallpaper:note', { text: text, kind: kind || 'ok' });
  }

  function chip(p, cur, onPick) {
    const on = cur.id === p.id;
    const sw = U.el('span', {
      class: 'wall-sw' + (p.css ? '' : ' is-none'),
      style: p.css ? 'background-image:' + p.css : '',
    });
    const b = U.el('button', {
      type: 'button',
      class: 'wall-chip' + (on ? ' on' : ''),
      title: p.name,
      'aria-label': '壁纸：' + p.name,
      'aria-pressed': on ? 'true' : 'false',
    }, [sw, U.el('span', { class: 'wall-nm' }, [p.name])]);
    b.addEventListener('click', () => onPick(p.id));
    return b;
  }

  /**
   * 渲染壁纸选择器。theme.js 的换肤回调里也要再调一次 ——
   * 换主题会改变「壁纸是否生效」与雾化兜底色，提示文案跟着变。
   */
  function mount(container) {
    if (!container) return;
    const w = get();
    const theme = (AG.theme && AG.theme.get()) || 'classic';
    const isGlass = !!GLASS[theme];
    container.innerHTML = '';

    const grid = U.el('div', { class: 'wall-grid' });
    const list = PRESETS.slice();
    if (w.custom) list.push(P('custom', '我的图片', 'url("' + w.custom + '")'));
    list.forEach((p) => {
      grid.appendChild(chip(p, w, (id) => {
        set(id);
        mount(container);
        U.bus.emit('wallpaper:change', get());
      }));
    });
    container.appendChild(grid);

    const row = U.el('div', { class: 'wall-row' });

    const file = U.el('input', { type: 'file', accept: 'image/*', id: 'wallFile', style: 'display:none' });
    file.addEventListener('change', () => {
      upload(file.files && file.files[0], (r) => {
        if (!r || !r.ok) note(r && r.note ? r.note : '这张图用不了，换一张试试。', 'err');
        else note('壁纸已换成本机图片（压缩后只存在浏览器里，不会上传）', 'ok');
        mount(container);
        U.bus.emit('wallpaper:change', get());
      });
      file.value = '';
    });
    const up = U.el('button', { type: 'button', class: 'btn sm', id: 'btnWallUpload' }, ['上传图片…']);
    up.addEventListener('click', () => file.click());
    row.appendChild(up);
    row.appendChild(file);

    if (w.custom) {
      const rm = U.el('button', { type: 'button', class: 'btn sm', id: 'btnWallClear' }, ['删掉我的图片']);
      rm.addEventListener('click', () => {
        clearCustom();
        mount(container);
        U.bus.emit('wallpaper:change', get());
      });
      row.appendChild(rm);
    }
    container.appendChild(row);

    const val = U.el('b', { id: 'wallVeilVal' }, [Math.round(w.veil * 100) + '%']);
    const range = U.el('input', {
      type: 'range', id: 'wallVeil', min: '0', max: '80', step: '2',
      value: String(Math.round(w.veil * 100)),
    });
    range.addEventListener('input', () => {
      val.textContent = range.value + '%';
      setVeil(Number(range.value) / 100);
    });
    container.appendChild(U.el('label', { class: 'fld wall-veil' }, [
      U.el('span', {}, ['背景雾化 / 压暗　', val]),
      range,
    ]));

    const hint = isGlass
      ? '壁纸铺在玻璃面板下层，面板会把背景糊成材质。想让文字更清楚就调高雾化。'
      : '壁纸只在「浅玻璃 / 深玻璃」两套主题下生效——当前是卡通主题，切到玻璃主题即可看到。';
    container.appendChild(U.el('p', { class: 'hint', style: 'margin:10px 0 0' }, [hint]));
  }

  AG.wallpaper = {
    PRESETS: PRESETS,
    GLASS: GLASS,
    get: get,
    apply: apply,
    set: set,
    setVeil: setVeil,
    setCustomFromImage: setCustomFromImage,
    upload: upload,
    clearCustom: clearCustom,
    mount: mount,
    build: build,
  };
})(window);
