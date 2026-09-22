/* AutoGrader · 玻璃主题壁纸
 *
 * 给玻璃主题铺一层壁纸：半透面板 + backdrop-filter 会把壁纸糊成"材质"，
 * 这正是 visionOS 那套做法 —— 背景有内容，玻璃才有东西可折射，立体感立刻出来。
 *
 * 四个设计决定：
 *   1. **只服务玻璃主题**。卡通主题是平涂描边风格，铺壁纸只会跟描边打架，所以不生效。
 *   2. **预设壁纸用纯 CSS 多层渐变，不用位图**。零体积（单文件版不能因为壁纸变大）、
 *      任意分辨率都不糊，且离线可用。想要照片感就自己上传。
 *   3. **雾化（veil）是必要的，不是装饰**。浅玻璃是深色字，压在深色照片上会看不清；
 *      深玻璃是白色字，压在浅色照片上同样糊。所以壁纸上再叠一层半透明兜底色 ——
 *      浅玻璃叠白、深玻璃叠黑，强度让用户自己调（默认 0.34）。
 *   4. **配置与图片分开存**（'wallpaper' 几字节 / 'wallpaperImage' 一个 data URL），
 *      并且**以内存为运行时真相**。教训：早先两者存在同一个 key 里，
 *      上传图片后那个 key 变成 ~1MB，之后切换预设时 `save` 要连图片一起重写 ——
 *      超出 localStorage 配额就会静默失败，而 apply() 是从存储重读的，
 *      于是表现为「点了预设不换背景、切回默认后再也换不回自己的图」。
 *      现在切换预设只写几字节；图片只在换图时写一次。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const KEY = 'wallpaper';        // { id, veil }
  const KEY_IMG = 'wallpaperImage'; // 压缩后的图片 data URL
  const GLASS = { classic: true, tech: true };
  const VEIL = { classic: [255, 255, 255], tech: [8, 10, 22] };
  const DEFAULT = { id: 'none', custom: '', veil: 0.32 };

  const MAX_W = 1600;
  const MAX_H = 1000;
  const MAX_BYTES = 6e5;   // data URL 字符上限；UTF-16 存进 localStorage 约 1.2MB

  let mem = null;          // 运行时真相：持久化失败也不能影响"这一次"

  function clampVeil(v) {
    const n = Number(v);
    return U.clamp(n === n ? n : DEFAULT.veil, 0, 0.85);
  }

  function note(text, kind) {
    U.bus.emit('wallpaper:note', { text: text, kind: kind || 'ok' });
  }

  function read() {
    if (mem) return mem;
    const raw = U.store.get(KEY, null);
    const c = raw && typeof raw === 'object' ? raw : {};
    let img = U.store.get(KEY_IMG, '');
    if (typeof img !== 'string') img = '';
    // 兼容早先把图片塞在同一个 key 里的版本：读到就顺手迁移到独立 key，
    // 并且把老 key 里的图片字段抹掉 —— 否则同一张图占两份配额，正是这次要修的病根。
    if (!img && typeof c.custom === 'string' && c.custom) {
      img = c.custom;
      U.store.set(KEY_IMG, img);
      U.store.set(KEY, { id: c.id || 'custom', veil: clampVeil(c.veil) });
    }
    mem = { id: c.id || 'none', veil: clampVeil(c.veil), custom: img };
    return mem;
  }

  /** 取当前壁纸设置（返回副本，外部改不动内部状态）。 */
  function get() {
    const w = read();
    return { id: w.id, veil: w.veil, custom: w.custom };
  }

  /** 只写配置（几字节）。写不进去时内存里仍然是新的，只是刷新后会回到旧值 —— 如实告知。 */
  function persist() {
    const w = read();
    if (U.store.set(KEY, { id: w.id, veil: w.veil })) return true;
    note('壁纸已切换，但本机存储写不进去（空间不足），刷新后会回到上一次的选择。', 'err');
    return false;
  }

  function P(id, name, css) { return { id: id, name: name, css: css }; }

  /* 四款，色相拉得很开：玫粉 / 橙紫 / 天蓝 / 青绿。
     每款都是「四五团不同色相的光斑 + 一层底色」——关键是**多色**：
     单色渐变透到玻璃后面还是同一色，整页会糊成一片（试过，很难看）；
     参考图那种液态玻璃之所以好看，是因为背景本身有色彩层次与明暗对比。
     饱和度按"照片的柔光"来给，不做高饱和色块，也不做灰调。 */
  const PRESETS = [
    P('none', '无', ''),
    P('bloom', '花影',
      'radial-gradient(46% 36% at 18% 14%, rgba(255, 252, 246, .90), rgba(255, 252, 246, 0) 58%),' +
      'radial-gradient(52% 42% at 74% 30%, rgba(228, 120, 166, .60), rgba(228, 120, 166, 0) 62%),' +
      'radial-gradient(58% 46% at 30% 82%, rgba(98, 146, 226, .56), rgba(98, 146, 226, 0) 66%),' +
      'radial-gradient(44% 34% at 88% 76%, rgba(246, 178, 120, .42), rgba(246, 178, 120, 0) 62%),' +
      'linear-gradient(164deg, #9d6a92 0%, #7b6199 48%, #5b5c92 100%)'),
    P('dusk', '黄昏',
      'radial-gradient(50% 40% at 22% 78%, rgba(246, 184, 98, .66), rgba(246, 184, 98, 0) 62%),' +
      'radial-gradient(46% 36% at 80% 24%, rgba(192, 126, 204, .46), rgba(192, 126, 204, 0) 60%),' +
      'radial-gradient(52% 40% at 62% 92%, rgba(88, 92, 168, .42), rgba(88, 92, 168, 0) 62%),' +
      'radial-gradient(40% 30% at 8% 18%, rgba(255, 232, 180, .40), rgba(255, 232, 180, 0) 58%),' +
      'linear-gradient(196deg, #4a3024 0%, #69402f 48%, #2e2350 100%)'),
    P('sky', '晴空',
      'radial-gradient(48% 36% at 24% 16%, rgba(255, 255, 255, .84), rgba(255, 255, 255, 0) 58%),' +
      'radial-gradient(54% 42% at 78% 74%, rgba(126, 172, 236, .50), rgba(126, 172, 236, 0) 64%),' +
      'radial-gradient(44% 34% at 12% 84%, rgba(206, 226, 246, .44), rgba(206, 226, 246, 0) 60%),' +
      'radial-gradient(38% 30% at 84% 22%, rgba(250, 240, 192, .32), rgba(250, 240, 192, 0) 58%),' +
      'linear-gradient(176deg, #8fb4e4 0%, #a8c4e8 48%, #7c9fd6 100%)'),
    P('forest', '森野',
      'radial-gradient(48% 38% at 26% 20%, rgba(214, 236, 168, .54), rgba(214, 236, 168, 0) 60%),' +
      'radial-gradient(54% 42% at 76% 76%, rgba(52, 130, 118, .52), rgba(52, 130, 118, 0) 64%),' +
      'radial-gradient(46% 36% at 88% 28%, rgba(158, 208, 168, .40), rgba(158, 208, 168, 0) 60%),' +
      'radial-gradient(42% 32% at 14% 88%, rgba(96, 168, 140, .42), rgba(96, 168, 140, 0) 58%),' +
      'linear-gradient(170deg, #35604f 0%, #2f7462 48%, #244c44 100%)'),
  ];

  function presetOf(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  /* 极淡的颗粒层：纯渐变放大看是"塑料"的，加一层噪点立刻有照片的质感。
     140×140 的 SVG turbulence，不到 300 字节；stitchTiles 保证平铺无接缝。
     opacity 压到 0.07 —— 只在近看时觉得"有东西"，远看仍然是干净的背景。 */
  const NOISE = 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">' +
    '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/></filter>' +
    '<rect width="140" height="140" filter="url(#n)" opacity="0.07"/></svg>'
  ) + '")';

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
    const parts = [];
    const veil = clampVeil(w.veil);
    if (veil) {
      const c = VEIL[theme] || VEIL.classic;
      const rgba = 'rgba(' + c.join(', ') + ', ' + veil + ')';
      parts.push('linear-gradient(' + rgba + ', ' + rgba + ')');
    }
    parts.push(layer);
    // 颗粒放最上层：压在雾化层之上，才不会被雾化层冲淡
    return [NOISE].concat(parts).join(', ');
  }

  /** 把壁纸写进 html 的 inline --bg-image（inline 优先于主题选择器里的定义）。
   *  由 theme.apply() 调用，保证切换主题后立刻按新主题重算雾化色。 */
  function apply(theme) {
    const t = theme || (AG.theme && AG.theme.get()) || 'classic';
    const val = build(get(), t);
    const root = document.documentElement;
    if (val) root.style.setProperty('--bg-image', val);
    else root.style.removeProperty('--bg-image');
    // 有壁纸时才给面板开真模糊（见 main.css 的 .has-wallpaper）：纯渐变底色下
    // 模糊看不出差别，不值得为它付 20 多个合成层的性能代价。
    root.classList.toggle('has-wallpaper', !!val);
    return val;
  }

  function set(id) {
    const w = read();
    const ok = (id === 'custom' && !!w.custom) || !!presetOf(id);
    w.id = ok ? id : 'none';
    persist();
    apply();
    return get();
  }

  function setVeil(v) {
    const w = read();
    w.veil = clampVeil(v);
    persist();
    apply();
    return w.veil;
  }

  /**
   * 把用户选的图片压到可用尺寸并存下来。图片单独写一个 key ——
   * 只在这一步有写大对象的开销，切预设时不再碰它。
   */
  function setCustomFromImage(img) {
    const k = Math.min(MAX_W / (img.width || 1), MAX_H / (img.height || 1), 1);
    const cw = Math.max(1, Math.round((img.width || 1) * k));
    const ch = Math.max(1, Math.round((img.height || 1) * k));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    // 先铺白底：带透明通道的 PNG 转 JPEG 后透明区会变黑，浅色主题下很突兀
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    let q = 0.82;
    let url = c.toDataURL('image/jpeg', q);
    while (url.length > MAX_BYTES && q > 0.4) {
      q -= 0.1;
      url = c.toDataURL('image/jpeg', q);
    }

    const w = read();
    const prevImg = w.custom;
    const prevId = w.id;
    w.custom = url;
    w.id = 'custom';
    if (!U.store.set(KEY_IMG, url)) {
      w.custom = prevImg;
      w.id = prevId;
      return { ok: false, note: '这张图压缩后仍然存不下（本机存储空间不足）。换一张小一点的，或先点「删掉我的图片」清出空间。' };
    }
    persist();
    apply();
    return { ok: true, bytes: url.length, width: cw, height: ch };
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
    const w = read();
    w.custom = '';
    if (w.id === 'custom') w.id = 'none';
    U.store.del(KEY_IMG);
    persist();
    apply();
    return get();
  }

  /* ---------------- 设置页 UI ---------------- */

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
    b.addEventListener('click', (e) => {
      // 这里必须拦住冒泡：壁纸选择器外面包着 <label>，
      // 冒泡上去会连带触发 label 关联的隐藏 file input（无端弹出选文件对话框）。
      e.preventDefault();
      e.stopPropagation();
      onPick(p.id);
    });
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
        else note('壁纸已换成本机图片（原图 ' + r.width + '×' + r.height + '，压缩后只存在浏览器里，不会上传）', 'ok');
        mount(container);
        U.bus.emit('wallpaper:change', get());
      });
      file.value = '';
    });
    const up = U.el('button', { type: 'button', class: 'btn sm', id: 'btnWallUpload' }, ['上传图片…']);
    up.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      file.click();
    });
    row.appendChild(up);
    row.appendChild(file);

    if (w.custom) {
      const rm = U.el('button', { type: 'button', class: 'btn sm', id: 'btnWallClear' }, ['删掉我的图片']);
      rm.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
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
    container.appendChild(U.el('label', { class: 'wall-veil' }, [
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
