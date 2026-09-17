/* AutoGrader · 应用主逻辑 */
(function (global) {
  'use strict';
  const AG = global.AG;
  const U = AG.utils;
  const { $, $$ } = U;

  /* 内联 SVG 图标：跨平台一致，不依赖 emoji 字体 */
  const SVG = (inner, size) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:${size || 40}px;height:${size || 40}px">${inner}</svg>`;
  const ICONS = {
    target: SVG('<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
    doc: SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
    search: SVG('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>'),
    check: SVG('<polyline points="20 6 9 17 4 12"/>'),
  };

  /* 常见 OpenAI 兼容服务商：一键填好地址与模型，降低配置门槛。
   * 只填 Base URL 与 Model，API Key 需用户自备（涉及计费，不宜代填）。 */
  const PROVIDER_PRESETS = {
    zhipu: { label: '智谱 GLM（免费）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash' },
    siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama: { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5', apiKey: 'ollama', offline: true },
  };

  const state = {
    docs: U.store.get('docs', []),
    currentId: null,
    rubric: AG.rubric.deserializeRubric(U.store.get('rubric', null)),
    engine: U.store.get('engine', 'local'),
    sim: null,
    induceGroups: {},   // docId -> 'high' | 'low'
    induced: null,      // 最近一次诱导结果
    lastFused: null,    // 最近一次融合结果
    labPreview: null,   // 最近一次「一句话生成」的建议量表
    autoFitKey: '',     // 上次自动适配时的文档集合指纹，用于避免重复跑同一批
    autoFitTimer: null,
    autoFitMuted: U.store.get('autoFitMuted', false), // 用户显式关闭过自动建议
    chat: U.store.get('chat', []),                    // 答疑会话，刷新后还在
  };

  /* ---------------- 基础 UI ---------------- */
  // 批量评阅时，同一条错误会按文档逐条抛出（3 篇报告 = 3 条一模一样的红框，糊满屏幕）。
  // 这里把 3 秒内的同文案合并成一条并累加次数。
  const toastCache = new Map();

  function toast(msg, type) {
    const now = Date.now();
    const hit = toastCache.get(msg);
    if (hit && hit.el.isConnected && now - hit.last < 3000) {
      hit.count += 1;
      hit.last = now;
      hit.el.innerHTML = U.esc(msg) + ' <b style="opacity:.7">×' + hit.count + '</b>';
      clearTimeout(hit.t1); clearTimeout(hit.t2);
      hit.t1 = setTimeout(() => { hit.el.style.opacity = '0'; hit.el.style.transition = '.3s'; }, 2600);
      hit.t2 = setTimeout(() => { hit.el.remove(); toastCache.delete(msg); }, 3000);
      return;
    }
    const t = U.el('div', { class: 'toast ' + (type || ''), html: U.esc(msg) });
    $('#toastWrap').appendChild(t);
    const rec = { el: t, last: now, count: 1 };
    rec.t1 = setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; }, 2600);
    rec.t2 = setTimeout(() => { t.remove(); toastCache.delete(msg); }, 3000);
    toastCache.set(msg, rec);
  }

  function switchView(name) {
    ['work', 'batch', 'insight', 'settings'].forEach((v) => {
      $('#view-' + v).style.display = v === name ? (v === 'work' ? 'grid' : 'block') : 'none';
    });
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'batch') renderBatch();
    if (name === 'insight') renderInsight();
    if (name === 'settings') { renderRubricTable(); loadCfgForm(); renderLabChrome(); }
  }

  function activeRubric() {
    return state.rubric.filter((d) => d.enabled !== false);
  }
  function rubricTotal(r) {
    return (r || activeRubric()).reduce((s, d) => s + (Number(d.max) || 0), 0);
  }

  function persist() {
    U.store.set('docs', state.docs);
  }

  /* ---------------- 外观：主题 + 评语人格 ---------------- */
  /**
   * 只重算评语文案，不动分数——换语气不应该让分数变。
   * LLM 引擎的评语由模型直接产出（人格已写进 system prompt），本地不覆盖。
   */
  function refreshComments() {
    let n = 0;
    state.docs.forEach((d) => {
      const r = d.result;
      if (!r || r.engine === 'llm') return;
      r.dims.forEach((dim, i) => { dim.comment = AG.voice.dimComment(dim, null, i); });
      r.overall = AG.voice.overall(r.total, r.dims, { grade: r.grade, label: r.gradeLabel });
      n++;
    });
    if (n) { persist(); renderResult(); renderBatch(); }
    return n;
  }

  /**
   * 顶栏 logo。
   * 位图吉祥物是暖色调的，硬塞进「晴空蓝 / 深空霓虹」的冷色渐变里会像贴纸，
   * 所以只在「动画卡通」主题下用它，其余主题回到文字标。
   */
  function renderLogo() {
    const toon = AG.theme.get() === 'toon';
    $('#logoBox').innerHTML = toon && AG.theme.HAS_MASCOT
      ? AG.theme.MASCOT_HEAD
      : '<span class="txt">AG</span>';
    $('#logoBox').classList.toggle('is-art', !!toon && AG.theme.HAS_MASCOT);
  }

  function setupAppearance() {
    AG.theme.apply(AG.theme.get());
    renderLogo();

    const onTheme = (id) => {
      const t = AG.theme.THEMES.filter((x) => x.id === id)[0];
      // 雷达图/仪表盘/热力图的颜色都取自主题变量，换肤后必须重绘，
      // 否则会出现「界面是番茄红、图表还是默认蓝」的割裂感。
      renderLogo();
      renderResult();
      if ($('#view-batch').style.display !== 'none') renderBatch();
      toast('已切换界面主题：' + (t ? t.name : id), 'ok');
    };
    AG.theme.mountSkinBar($('#skinBarTop'), { compact: true, onChange: onTheme });
    AG.theme.mountSkinBar($('#skinBarSettings'), { onChange: onTheme });

    AG.voice.mountTonePicker($('#tonePicker'), {
      onChange: (id) => {
        const t = AG.voice.TONES.filter((x) => x.id === id)[0];
        const n = refreshComments();
        toast('评语语气已切换为「' + (t ? t.name : id) + '」' +
          (n ? `，已重算 ${n} 份报告的评语（分数不变）` : ''), 'ok');
      },
    });

    const pf = $('#optPrintFriendly');
    if (pf) {
      pf.checked = !!U.store.get('printFriendly', false);
      pf.addEventListener('change', () => {
        U.store.set('printFriendly', pf.checked);
        toast(pf.checked ? 'PDF 将固定为浅色打印版' : 'PDF 将跟随界面主题配色', 'ok');
      });
    }

    // 检测到下载可能被拦截的环境（file:// + Edge/Safari 内核）时，
    // 把「弹窗自救说明」常驻在导出按钮下方 —— 比下载失败后再 toast 更及时。
    const tip = $('#dlTip');
    if (tip && U.downloadRisky()) tip.hidden = false;
  }

  function refreshEngineBadge() {
    const on = state.engine === 'llm' && !!AG.llm.getConfig().apiKey;
    const actual = state.engine === 'llm' && !AG.llm.getConfig().apiKey ? 'local' : state.engine;
    const badge = $('#engineBadge');
    const label = actual === 'llm'
      ? '大模型引擎 · ' + AG.llm.getConfig().model
      : '本地启发式引擎';
    badge.className = 'badge ' + (actual === 'llm' ? 'blue' : 'gray');
    badge.innerHTML = '<i class="dot"></i>' + U.esc(label);
    $('#btnEngineLocal').className = 'btn sm' + (actual === 'local' ? ' primary' : '');
    $('#btnEngineLLM').className = 'btn sm' + (actual === 'llm' ? ' primary' : '');
    return on;
  }

  /* ---------------- 文档管理 ---------------- */
  function addDoc(name, text, features) {
    const doc = {
      id: U.uid('doc'),
      name: name || ('未命名报告-' + (state.docs.length + 1)),
      text,
      features: features || AG.parser.extractFeatures(text),
      result: null,
      addedAt: Date.now(),
    };
    state.docs.push(doc);
    state.currentId = doc.id;
    persist();
    renderDocList();
    renderResult();
    maybeAutoFit();
    return doc;
  }

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let ok = 0;
    for (const f of list) {
      try {
        const p = await AG.parser.parseFile(f);
        addDoc(p.name, p.text, p.features);
        ok++;
        if (p.warning) toast(p.warning, 'err');
      } catch (e) {
        toast(e.message, 'err');
      }
    }
    if (ok) toast(`成功录入 ${ok} 份报告，点击「全部重新评分」开始评阅`, 'ok');
  }

  /* ---------------- 评分 ---------------- */
  async function gradeDoc(id, opts) {
    opts = opts || {};
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    const rub = activeRubric();
    const rt = rubricTotal(rub);
    const useLLM = state.engine === 'llm' && !!AG.llm.getConfig().apiKey;

    let res;
    if (useLLM) {
      try {
        if (!opts.silent) toast('正在调用大模型评阅…');
        res = await AG.llm.grade(doc, rub);
      } catch (e) {
        toast('大模型调用失败：' + e.message + '，已回退本地引擎', 'err');
        res = AG.analyzer.grade(doc, rub, { skipGenre: !!doc.genreOverride });
      }
    } else {
      // genreOverride：教师点过「我判错了」，这份作业此后都跳过文体门禁
      res = AG.analyzer.grade(doc, rub, { skipGenre: !!doc.genreOverride });
    }

    // 量表总分非 100 时折算到百分制
    if (rt > 0 && Math.abs(rt - 100) > 0.001) {
      res.total = U.clamp(U.round(res.total * 100 / rt, 1), 0, 100);
      const g = AG.rubric.gradeOf(res.total);
      res.grade = g.grade; res.gradeLabel = g.label; res.gradeColor = g.color;
      res.scaled = true;
    }

    doc.result = res;
    persist();
    if (state.currentId === id) renderResult();
    return res;
  }

  async function gradeAll() {
    if (!state.docs.length) return toast('请先录入报告', 'err');
    const btn = $('#btnGradeAll');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 评阅中…';
    for (const d of state.docs) await gradeDoc(d.id, { silent: true });
    btn.disabled = false;
    btn.textContent = '全部重新评分';
    renderDocList();
    computeSim();
    toast(`已完成 ${state.docs.length} 份报告的评阅`, 'ok');
    if (state.currentId) renderResult();
  }

  /* ---------------- 渲染：文档列表 ---------------- */
  function renderDocList() {
    const ul = $('#docList');
    ul.innerHTML = '';
    $('#docCount').textContent = state.docs.length + ' 份';
    if (!state.docs.length) {
      ul.appendChild(U.el('li', { class: 'hint', style: 'justify-content:center;cursor:default', html: '暂无报告' }));
      return;
    }
    state.docs.forEach((d) => {
      const li = U.el('li', { class: d.id === state.currentId ? 'active' : '' });
      const nm = U.el('div', { class: 'nm' });
      nm.appendChild(U.el('b', { html: U.esc(d.name), title: d.name }));
      const r = d.result;
      nm.appendChild(U.el('small', {
        html: r ? `${r.engineLabel} · ${U.fmtTime(r.gradedAt)}` : `${d.features.words} 字 · 待评分`,
      }));
      li.appendChild(nm);
      if (r) {
        const s = U.el('div', { class: 'sc', style: 'color:' + r.gradeColor, html: String(r.total) });
        li.appendChild(s);
      }
      const del = U.el('button', { class: 'del', title: '移除', html: '×' });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.docs = state.docs.filter((x) => x.id !== d.id);
        if (state.currentId === d.id) state.currentId = state.docs[0] ? state.docs[0].id : null;
        persist(); renderDocList(); renderResult(); computeSim();
        maybeAutoFit();
      });
      li.appendChild(del);
      li.addEventListener('click', () => { state.currentId = d.id; renderDocList(); renderResult(); });
      ul.appendChild(li);
    });
  }

  /* ---------------- 渲染：评阅结果 ---------------- */
  /** 文体门禁提示卡：离题 / 空文档判 0 分时，把判定依据摊开给教师看，并留一条申诉通道。
   *  本地引擎读不懂语义，只能凭结构特征判断，误判的可能性必须让用户看得见、也改得动。 */
  function renderGate(r, doc) {
    const g = r.gate;
    if (!g) {
      if (doc && doc.genreOverride) {
        return `<div class="gate warn"><div class="gt"><b>已忽略文体校验</b></div>
          <div class="hint">这份作业曾被判定为非报告类文档，你选择了按正常评分重算，此后评阅都会跳过这道校验。</div></div>`;
      }
      return '';
    }
    if (g.verdict !== 'offtopic' && g.verdict !== 'empty' && g.verdict !== 'suspicious') return '';
    const hard = g.verdict === 'offtopic' || g.verdict === 'empty';
    const title = hard ? '未通过文体校验 · 总分记为 0 分' : '报告文体特征较弱 · 总分已按 60% 折算';
    return `<div class="gate${hard ? '' : ' warn'}">
      <div class="gt"><b>${title}</b>
        <span class="badge ${hard ? 'red' : 'amber'}">判定置信度 ${g.confidence === 'high' ? '高' : '中'}</span></div>
      <ul>${g.reasons.map((x) => `<li>${U.esc(x)}</li>`).join('')}</ul>
      ${hard ? `<div class="btn-row" style="margin-top:10px">
        <button class="btn sm" id="btnIgnoreGate">我判错了，按正常评分重算</button></div>
        <div class="hint" style="margin-top:6px">本地引擎读不懂语义，只能凭章节结构、数据密度、语域用词这类统计特征来判断。
        若这确实是一份实验报告，点上面的按钮即可跳过校验——该选择会随这份作业一起保存。</div>` : ''}
    </div>`;
  }

  function renderResult() {
    const card = $('#resultCard');
    const doc = state.docs.find((d) => d.id === state.currentId);
    const geb = $('#btnGradeEmpty');
    if (geb) geb.disabled = !doc;

    if (!doc) {
      // 空状态：卡通主题下用原创吉祥物插画，其余主题仍用通用图标
      // （位图是暖色调的，在冷色主题里降透明度会显脏，不如不给）
      const toon = AG.theme.get() === 'toon';
      const art = (toon && AG.theme.HAS_MASCOT && AG.theme.MASCOT_FULL) || ICONS.target;
      card.innerHTML = `<div class="empty">
        <div class="ic">${art}</div><b>还没有可展示的评阅结果</b>
        <p class="hint">上传或粘贴一份实验报告，点击「开始评分」<br>也可以先「加载示例」体验完整流程</p>
        <div class="btn-row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" id="btnGradeEmpty" disabled>开始评分</button>
        </div></div>`;
      bindResultButtons();
      return;
    }

    if (!doc.result) {
      card.innerHTML = `<div class="empty">
        <div class="ic">${ICONS.doc}</div><b>${U.esc(doc.name)}</b>
        <p class="hint">字数 ${doc.features.words} · 代码块 ${doc.features.codeBlockCount} 个 · 图表引用 ${doc.features.figureCount + doc.features.tableCount} 处</p>
        <div class="btn-row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" id="btnGradeOne">开始评分</button>
        </div></div>`;
      bindResultButtons();
      return;
    }

    const r = doc.result;
    const g = AG.rubric.gradeOf(r.total);
    // 溯源自检：把每个维度的分拆成「证据挣的」与「结构送的」
    const trace = AG.reliability.evidenceAudit(r);

    const dimsHtml = r.dims.map((d, i) => {
      const pct = Math.round(d.ratio * 100);
      const evChips = (d.evidence || []).map((e) => `<span class="chip ok">✓ ${U.esc(e.label)}</span>`).join('');
      const missChips = (d.missing || []).map((m) => `<span class="chip miss">✗ ${U.esc(m.label)}</span>`).join('');
      const penChips = (d.penalties || []).map((p) => `<span class="chip pen">- ${U.esc(p.label)} (${p.weight})</span>`).join('');
      // 只有「主要靠结构得分」才提示 —— 其余情况不刷屏
      const tr = trace.ok ? trace.dims[i] : null;
      const traceChip = tr && tr.layer === 'weak'
        ? `<span class="chip pen">⚠ 分主要来自结构特征，直接证据仅覆盖 ${Math.round(tr.raw * 100)}%</span>` : '';
      const snip = (d.evidence || []).filter((e) => e.snippets && e.snippets.length)
        .slice(0, 3).map((e) => `<div class="ev"><em>${U.esc(e.label)}</em>：${U.esc(e.snippets[0].snippet)}</div>`).join('');

      return `<div class="dim${i === 0 ? ' open' : ''}" data-i="${i}">
        <div class="hd">
          <span class="caret">▶</span>
          <span class="nm">${U.esc(d.name)}</span>
          <span class="bar"><i style="width:${pct}%"></i></span>
          <span class="val" style="color:${g.color}">${d.score}/${d.max}</span>
        </div>
        <div class="bd">
          <div class="desc">${U.esc(d.desc || '')}</div>
          ${evChips || missChips || penChips ? `<div class="chips">${evChips}${missChips}${penChips}</div>` : ''}
          <div class="chips" style="margin-top:8px">
            ${traceChip || (tr ? `<span class="chip">溯源：证据占得分依据 ${Math.round(tr.support * 100)}% · 命中 ${tr.evidenceCount} 项${tr.missingCount ? ' / 未命中 ' + tr.missingCount + ' 项' : ''}</span>` : '')}
          </div>
          ${snip ? `<div class="grp" style="margin-top:10px"><div class="lb">命中原文证据</div>${snip}</div>` : ''}
          <div class="cmt">${U.esc(d.comment || d.advice || '')}</div>
        </div>
      </div>`;
    }).join('');

    const f = r.features || doc.features;
    card.innerHTML = `
      <div class="result-head">
        <div class="meta">
          <h2>${U.esc(doc.name)}</h2>
          <div class="hint">
            <span class="badge ${r.engine === 'llm' ? 'blue' : 'gray'}"><i class="dot"></i>${U.esc(r.engineLabel)}</span>
            &nbsp;评阅于 ${U.fmtTime(r.gradedAt)}
            ${r.scaled ? '&nbsp;<span class="badge amber">已折算为百分制</span>' : ''}
          </div>
        </div>
        <div class="btn-row">
          <button class="btn sm" id="btnRegrade">重新评分</button>
          <button class="btn sm primary" id="btnExportOnePdf">导出 PDF</button>
          <button class="btn sm" id="btnExportOne">导出 Markdown</button>
        </div>
      </div>

      ${renderGate(r, doc)}
      ${r.langNote ? `<div class="gate warn"><div class="gt"><b>评分可能失真</b></div>
        <div class="hint" style="font-size:13px">${U.esc(r.langNote)}</div></div>` : ''}

      <div class="score-grid">
        <div class="gauge-box" id="gaugeBox"></div>
        <div id="radarBox"></div>
      </div>

      <div class="stat-row">
        <div class="stat"><b>${f.words}</b><small>字数</small></div>
        <div class="stat"><b>${f.headingCount}</b><small>标题层级</small></div>
        <div class="stat"><b>${f.codeBlockCount}</b><small>代码块</small></div>
        <div class="stat"><b>${f.figureCount + f.tableCount}</b><small>图表引用</small></div>
        <div class="stat"><b>${f.numberCount}</b><small>数据点</small></div>
        <div class="stat"><b>${f.referenceCount}</b><small>引用</small></div>
        <div class="stat"><b>${r.qualityFactor}</b><small>质量系数</small></div>
      </div>

      <div class="overall" style="margin:16px 0 14px">${U.esc(r.overall || '')}</div>

      <h3 style="font-size:14px;margin:0 0 10px">逐项核查 <span class="hint" style="font-weight:500">点击维度展开证据与改进建议</span></h3>
      ${trace.ok ? `<div class="susp" style="margin-bottom:12px">
        <span class="badge ${trace.weak.length || trace.penalized.length ? 'amber' : 'green'}">溯源自检</span>
        <span>${trace.dims.length} 个维度中，<b>${trace.solid.length}</b> 个由直接证据支撑（占得分依据 70% 以上）${trace.weak.length ? `，<b>${trace.weak.length}</b> 个主要靠结构特征得分` : ''}${trace.penalized.length ? `，<b>${trace.penalized.length}</b> 个被具体缺陷扣掉 25% 以上` : ''}。
        全卷证据支撑度 <b>${Math.round(trace.supportRate * 100)}%</b>，共命中 ${trace.evidenceTotal} 项证据、未命中 ${trace.missingTotal} 项。</span></div>` : ''}
      ${dimsHtml}
    `;

    $('#gaugeBox').appendChild(AG.charts.gauge(r.total, { size: 250 }));
    $('#radarBox').appendChild(AG.charts.radar(r.dims, { size: 400 }));

    $$('.dim .hd', card).forEach((hd) => {
      hd.addEventListener('click', () => hd.parentElement.classList.toggle('open'));
    });
    bindResultButtons();
  }

  function bindResultButtons() {
    const one = $('#btnGradeOne') || $('#btnGradeEmpty');
    if (one) one.addEventListener('click', async () => {
      if (state.currentId) { await gradeDoc(state.currentId); renderDocList(); computeSim(); }
    });
    const re = $('#btnRegrade');
    if (re) re.addEventListener('click', async () => { await gradeDoc(state.currentId); renderDocList(); });
    const ex = $('#btnExportOne');
    if (ex) ex.addEventListener('click', () => exportOneMd());
    const exPdf = $('#btnExportOnePdf');
    if (exPdf) exPdf.addEventListener('click', exportOnePdf);
    const ig = $('#btnIgnoreGate');
    if (ig) ig.addEventListener('click', async () => {
      const d = state.docs.find((x) => x.id === state.currentId);
      if (!d) return;
      d.genreOverride = true;   // 记住这个决定，之后每次重算都不再拦
      persist();
      await gradeDoc(state.currentId, { silent: true });
      renderDocList();
      toast('已忽略文体校验，按正常评分重算', 'ok');
    });
  }

  /* ---------------- 渲染：批量与查重 ---------------- */
  function computeSim() {
    const graded = state.docs.filter((d) => d.result);
    state.sim = graded.length >= 2 ? AG.analyzer.similarity(graded) : null;
  }

  function renderBatch() {
    const graded = state.docs.filter((d) => d.result);
    $('#batchCount').textContent = graded.length + ' 份已评分';
    const tbody = $('#scoreTable').querySelector('tbody');
    tbody.innerHTML = '';

    if (!graded.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="c hint" style="padding:26px">暂无已评分报告，请先到「评分工作台」完成评阅</td></tr>';
    }
    const simMap = {};
    if (state.sim) {
      graded.forEach((d, i) => {
        const others = state.sim.matrix[i].map((v, j) => ({ v, j })).filter((o) => o.j !== i);
        const top = others.sort((a, b) => b.v - a.v)[0];
        simMap[d.id] = top ? top.v : 0;
      });
    }

    graded.forEach((d) => {
      const r = d.result;
      const sv = simMap[d.id];
      const tr = U.el('tr', {});
      tr.innerHTML = `
        <td>${U.esc(d.name)}</td>
        <td class="c" style="font-weight:800;color:${r.gradeColor}">${r.total}</td>
        <td class="c"><span class="badge" style="background:${r.gradeColor}18;color:${r.gradeColor}">${r.grade} · ${r.gradeLabel}</span></td>
        <td class="c">${r.features.words}</td>
        <td class="c">${r.features.codeBlockCount}</td>
        <td class="c">${r.features.figureCount + r.features.tableCount}</td>
        <td class="c">${sv === undefined ? '—' : (sv >= 0.45 ? `<span style="color:var(--red);font-weight:700">${Math.round(sv * 100)}%</span>` : Math.round(sv * 100) + '%')}</td>
        <td class="r"><button class="btn sm" data-view-doc="${d.id}">查看</button></td>`;
      tbody.appendChild(tr);
    });
    $$('[data-view-doc]', tbody).forEach((b) => b.addEventListener('click', () => {
      state.currentId = b.dataset.viewDoc;
      switchView('work'); renderDocList(); renderResult();
    }));

    renderSim();
  }

  function renderSim() {
    const box = $('#simBox');
    const graded = state.docs.filter((d) => d.result);
    if (graded.length < 2) {
      box.innerHTML = `<div class="empty" style="padding:34px 20px"><div class="ic">${ICONS.search}</div><b>至少需要 2 份报告才能进行相似度比对</b></div>`;
      return;
    }
    computeSim();
    const names = graded.map((d) => d.name);
    let html = '';
    if (state.sim.suspicious.length) {
      html += state.sim.suspicious.map((p) => {
        const lvl = p.value >= 0.7 ? 'red' : 'amber';
        return `<div class="susp${lvl === 'amber' ? ' warn' : ''}">
          <span class="badge ${p.value >= 0.7 ? 'red' : 'amber'}">${Math.round(p.value * 100)}%</span>
          <span><b>${U.esc(names[p.a])}</b> 与 <b>${U.esc(names[p.b])}</b> 高度相似，建议人工复核是否存在抄袭。</span>
        </div>`;
      }).join('');
    } else {
      html += '<div class="susp" style="border-color:#bbf7d0;background:#f0fdf4"><span class="badge green">未发现可疑</span><span>所有报告两两相似度均低于 45% 阈值。</span></div>';
    }
    box.innerHTML = html + '<div id="hmBox" style="margin-top:14px;overflow-x:auto"></div>';
    $('#hmBox').appendChild(AG.charts.heatmap(state.sim.matrix, names));
  }

  /* ============================================================
   * 智能分析：量表自动诱导 / 评分信度自检 / 双引擎交叉验证
   * ============================================================ */

  /* ---------- 1. 量表自动诱导 ---------- */

  /** 默认的智能分组：已评分的按 80 分切档，未评分的一律不动 */
  function autoGroup() {
    const g = {};
    state.docs.forEach((d) => {
      if (d.result) g[d.id] = d.result.total >= 80 ? 'high' : 'low';
    });
    return g;
  }

  function renderInsight() {
    // 首次进入时按分数自动预分组，省得教师一份份点
    if (!Object.keys(state.induceGroups).length && state.docs.some((d) => d.result)) {
      state.induceGroups = autoGroup();
    }
    renderInduceGroups();
    renderAuditOptions();
    renderCvOptions();
  }

  function renderInduceGroups() {
    const box = $('#induceGroups');
    box.innerHTML = '';
    if (!state.docs.length) {
      box.innerHTML = '<div class="hint" style="padding:14px;text-align:center">请先在「评分工作台」录入至少 2 份报告，并标注哪些是优秀范文、哪些是对照范文</div>';
      return;
    }
    const wrap = U.el('div', { class: 'grp' });
    wrap.appendChild(U.el('div', { class: 'lb', html: '标注范文（优秀组与对照组各至少 1 份）' }));

    state.docs.forEach((d) => {
      const row = U.el('div', { class: 'gsel' });
      const nm = U.el('div', { class: 'nm' });
      nm.appendChild(U.el('b', { html: U.esc(d.name) }));
      nm.appendChild(U.el('small', {
        html: d.result ? `已评分 ${d.result.total} 分 · ${d.features.words} 字` : `未评分 · ${d.features.words} 字`,
      }));
      row.appendChild(nm);

      const seg = U.el('div', { class: 'seg' });
      [['high', '优秀组', 'ok'], ['low', '对照组', 'warn'], ['', '不参与', '']].forEach(([v, label, cls]) => {
        const b = U.el('button', {
          class: 'btn sm' + (cls ? ' ' + cls : '') + ((state.induceGroups[d.id] || '') === v ? ' primary' : ''),
          html: label,
        });
        b.addEventListener('click', () => {
          if (v === '') delete state.induceGroups[d.id];
          else state.induceGroups[d.id] = v;
          renderInduceGroups();
        });
        seg.appendChild(b);
      });
      row.appendChild(seg);
      wrap.appendChild(row);
    });

    const hi = Object.values(state.induceGroups).filter((v) => v === 'high').length;
    const lo = Object.values(state.induceGroups).filter((v) => v === 'low').length;
    wrap.appendChild(U.el('div', {
      class: 'hint',
      html: `当前：优秀组 ${hi} 份 · 对照组 ${lo} 份`,
    }));
    box.appendChild(wrap);
  }

  function runInduce() {
    const box = $('#induceResult');
    const high = state.docs.filter((d) => state.induceGroups[d.id] === 'high');
    const low = state.docs.filter((d) => state.induceGroups[d.id] === 'low');

    if (!high.length || !low.length) {
      box.innerHTML = '<div class="susp warn"><span class="badge amber">分组不足</span><span>优秀组与对照组各至少需要 1 份范文。</span></div>';
      return;
    }

    let res;
    try {
      res = AG.induce.induce(high, low, {
        minDelta: Number($('#indMinDelta').value) || 0.2,
        minSupport: Number($('#indMinSup').value) || 0.25,
        maxTerms: Number($('#indMaxTerms').value) || 60,
      });
    } catch (e) {
      box.innerHTML = `<div class="susp"><span class="badge red">失败</span><span>${U.esc(e.message)}</span></div>`;
      return;
    }

    state.induced = res;
    const baseMap = {};
    AG.rubric.DEFAULT_RUBRIC.forEach((d) => { baseMap[d.name] = d.max; });

    const rows = res.dims.map((d) => ({ name: d.name, a: baseMap[d.name] || 0, b: d.max }));

    const tbl = res.dims.map((d) => {
      const def = baseMap[d.name];
      const delta = def == null ? null : d.max - def;
      const badge = delta == null ? '<span class="badge blue">新增</span>'
        : delta === 0 ? '<span class="badge gray">持平</span>'
        : delta > 0 ? `<span class="badge green">+${delta}</span>`
        : `<span class="badge amber">${delta}</span>`;
      const basis = d.items.slice(0, 3)
        .map((i) => `<span class="chip ok">${U.esc(i.label)} <em>Δ${i.delta}</em></span>`).join('');
      return `<tr>
        <td><b>${U.esc(d.name)}</b></td>
        <td class="c" style="font-weight:800;color:var(--brand)">${d.max}</td>
        <td class="c">${def == null ? '—' : def}</td>
        <td class="c">${badge}</td>
        <td style="max-width:340px">${basis}</td>
      </tr>`;
    }).join('');

    const dropped = res.stats.droppedCount;
    box.innerHTML = `
      <div class="stat-row" style="margin-bottom:12px">
        <div class="stat"><b>${res.stats.candidateCount}</b><small>候选要素</small></div>
        <div class="stat"><b style="color:var(--green)">${res.stats.keptCount}</b><small>保留（Δ 达标）</small></div>
        <div class="stat"><b style="color:var(--amber)">${dropped}</b><small>剔除（零区分度）</small></div>
        <div class="stat"><b>${res.dims.length}</b><small>生成维度</small></div>
      </div>
      <div class="susp" style="border-color:#bbf7d0;background:#f0fdf4;margin-bottom:14px">
        <span class="badge green">已剔除 ${dropped} 项</span>
        <span>这些要素在两组范文中命中率无差异（例如「有总结」「有标题」人人都会写），
        占分却拉不开差距，已从量表中移除。</span>
      </div>
      <div id="rcBox" style="margin-bottom:14px"></div>
      <div style="overflow-x:auto">
        <table class="tb">
          <thead><tr>
            <th>维度</th><th class="c">诱导分值</th><th class="c">默认分值</th>
            <th class="c">变化</th><th>分值依据（区分度 Top3）</th>
          </tr></thead>
          <tbody>${tbl}</tbody>
        </table>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" id="btnApplyInduced">应用为当前量表</button>
        <button class="btn" id="btnInduceExport2">导出 JSON</button>
      </div>
      <p class="hint" style="margin-top:10px">
        诱导出的分值来自数据，但各维度的<b>信号词典仍沿用领域默认配置</b>——
        若直接用范文里的术语做信号，换个题目就不灵了（过拟合）。这是有意为之的取舍。
      </p>`;

    $('#rcBox').appendChild(AG.charts.rubricCompare(rows));
    $('#btnApplyInduced').addEventListener('click', applyInduced);
    $('#btnInduceExport2').addEventListener('click', exportInduced);
  }

  function applyInduced() {
    if (!state.induced) return toast('请先运行诱导', 'err');
    const rub = AG.induce.toRubric(state.induced);
    state.rubric = rub;
    U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
    renderRubricTable();
    toast('已应用诱导量表，请重新评分以生效', 'ok');
    switchView('settings');
  }

  function exportInduced() {
    if (!state.induced) return toast('请先运行诱导', 'err');
    const payload = {
      generatedAt: new Date(state.induced.generatedAt).toISOString(),
      method: 'discriminative-induction',
      formula: 'w = (pHi - pLo) * sqrt(support), keep if Δ >= minDelta',
      params: state.induced.stats,
      dims: state.induced.dims.map((d) => ({
        id: d.id, name: d.name, max: d.max, share: d.share,
        basis: d.items.map((i) => ({ label: i.label, kind: i.kind, pHi: i.pHi, pLo: i.pLo, delta: i.delta, weight: i.weight })),
      })),
    };
    U.download('诱导量表.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('已导出诱导量表 JSON', 'ok');
  }

  /* ---------- 2. 评分信度自检 ---------- */

  function gradedDocs() {
    return state.docs.filter((d) => d.result);
  }

  /**
   * 保证评分结果与当前量表同源。
   * 场景：教师改了量表（或应用了诱导量表）却没重新评分，此时 doc.result 仍是旧量表的维度结构。
   * 若不校验就直接拿去算 α 或做双引擎对比，会出现"维度对不上、缺失维度按 0 分计"的荒谬结果
   * （表现为总分差接近 0，但平均绝对误差高达 9 分）。
   * @returns {number} 被刷新的报告数
   */
  function ensureFreshResults() {
    const rub = activeRubric();
    let n = 0;
    state.docs.forEach((d) => {
      if (!d.result) return;
      const same = d.result.dims.length === rub.length
        && d.result.dims.every((x, i) => x.id === rub[i].id && x.max === rub[i].max);
      if (!same) { d.result = AG.analyzer.grade(d, rub); n++; }
    });
    if (n) { persist(); renderDocList(); }
    return n;
  }

  function renderAuditOptions() {
    const sel = $('#auditDoc');
    const cur = sel.value;
    sel.innerHTML = '';
    const gs = gradedDocs();
    if (!gs.length) {
      sel.innerHTML = '<option value="">暂无已评分报告</option>';
      return;
    }
    gs.forEach((d) => {
      sel.appendChild(U.el('option', { value: d.id, html: U.esc(d.name) + '（' + d.result.total + ' 分）' }));
    });
    if (cur) sel.value = cur;
  }

  function runAudit() {
    const box = $('#auditResult');
    const gs = gradedDocs();
    if (!gs.length) {
      box.innerHTML = '<div class="susp warn"><span class="badge amber">无数据</span><span>请先完成至少 1 份报告的评分。</span></div>';
      return;
    }
    const refreshed = ensureFreshResults();
    if (refreshed) toast(`量表已变更，已按新量表重新评分 ${refreshed} 份报告`, 'ok');

    const targetId = $('#auditDoc').value || gs[0].id;
    const target = gs.find((d) => d.id === targetId) || gs[0];
    const iterations = U.clamp(Number($('#auditIter').value) || 100, 20, 400);

    const btn = $('#btnAudit');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 自检中…';

    // 让按钮的 loading 态有机会渲染出来再跑重采样（100 次评分是同步密集计算）
    setTimeout(() => {
      let alpha, bs, jk, lb, ct;
      try {
        alpha = AG.reliability.cronbachAlpha(gs.map((d) => d.result));
        bs = AG.reliability.bootstrap(target, activeRubric(), { iterations });
        jk = AG.reliability.jackknife(target, activeRubric());
        // 篇幅偏差与共识术语都是全批次统计量，与单份报告的 Bootstrap 不同
        lb = AG.reliability.lengthBias(gs);
        ct = AG.induce.consensusTerms(gs);
      } catch (e) {
        btn.disabled = false; btn.textContent = '运行自检';
        box.innerHTML = `<div class="susp"><span class="badge red">失败</span><span>${U.esc(e.message)}</span></div>`;
        return;
      }
      btn.disabled = false; btn.textContent = '运行自检';
      box.innerHTML = renderAuditHtml(target, alpha, bs, jk, lb, ct);
      const band = $('#bsBandBox');
      if (band && bs.ok) band.appendChild(AG.charts.bootstrapBand(bs));
    }, 30);
  }

  function renderAuditHtml(target, alpha, bs, jk, lb, ct) {
    let html = '';

    /* α 卡片 */
    if (alpha.alpha != null) {
      const g = alpha.grade;
      const noisy = (alpha.noisyDims || []).slice(0, 3);
      html += `
        <div class="kpi-row">
          <div class="kpi">
            <b style="color:${g.color}">${alpha.alpha}</b>
            <small>Cronbach's α · ${g.label}</small>
            <span>${g.desc}</span>
          </div>
          <div class="kpi">
            <b>${alpha.spearmanBrown}</b>
            <small>折半信度 Spearman-Brown</small>
            <span>奇偶分半相关 r = ${alpha.splitHalfR}，校正后 ${alpha.spearmanBrown}，与 α 互为交叉验证</span>
          </div>
          <div class="kpi">
            <b>${alpha.sampleCount}</b>
            <small>样本 / 维度</small>
            <span>${alpha.sampleCount} 份报告 × ${alpha.itemCount} 个维度${alpha.sampleWarning ? ' · ⚠ ' + U.esc(alpha.sampleWarning) : ''}</span>
          </div>
        </div>`;
      if (noisy.length) {
        html += `<div class="susp warn" style="margin-bottom:12px">
          <span class="badge amber">噪声维度</span>
          <span>删除后 α 反而升高的维度：${noisy.map((n) => `<b>${U.esc(n.name)}</b>（+${n.delta}）`).join('、')}。
          说明它们与其他维度测的不是同一件事，建议改写措辞或合并。</span></div>`;
      }
    } else {
      html += `<div class="susp warn"><span class="badge amber">样本不足</span><span>${U.esc(alpha.note || '')}：α 需要至少 2 份已评分报告才能计算。</span></div>`;
    }

    /* Bootstrap */
    if (bs.ok) {
      const s = bs.stability;
      html += `
        <h4 style="font-size:13px;margin:16px 0 8px">单份报告稳定性 · ${U.esc(target.name)}</h4>
        <div class="kpi-row">
          <div class="kpi"><b>${bs.point}</b><small>实际得分</small><span>重采样均值 ${bs.mean}，标准差 ${bs.sd}</span></div>
          <div class="kpi"><b style="color:${s.color}">[${bs.ci[0]}, ${bs.ci[1]}]</b><small>95% 置信区间</small><span>区间宽度 ${bs.ciWidth} 分，变异系数 ${bs.cv}</span></div>
          <div class="kpi"><b style="color:${s.color};font-size:17px">${s.label}</b><small>稳定性判定</small><span>${s.desc}</span></div>
        </div>
        <div id="bsBandBox" style="margin:12px 0"></div>
        <p class="hint">做法：随机删减 15% 的段落（共 ${bs.paragraphs} 段）后重新评分，重复 ${bs.iterations} 次。
        结构化特征（篇幅、代码量等）在重采样中保持不变，因此该区间只反映<b>内容覆盖度的波动</b>，
        不受篇幅阈值跳变的干扰。</p>
        <div style="overflow-x:auto;margin-top:10px">
          <table class="tb"><thead><tr><th>维度</th><th class="c">平均得分率</th><th class="c">波动区间</th><th class="c">标准差</th></tr></thead><tbody>
          ${bs.dims.map((d) => `<tr>
            <td>${U.esc(d.name)}</td>
            <td class="c">${Math.round(d.mean * 100)}%</td>
            <td class="c">${Math.round(d.ci[0] * 100)}% – ${Math.round(d.ci[1] * 100)}%</td>
            <td class="c">${d.sd}</td></tr>`).join('')}
          </tbody></table>
        </div>`;
    } else {
      html += `<div class="susp warn" style="margin-top:12px"><span class="badge amber">跳过</span><span>${U.esc(bs.note || '')}</span></div>`;
    }

    /* Jackknife */
    if (jk.ok) {
      const bal = jk.balance === 'balanced' ? 'green' : jk.balance === 'tilted' ? 'amber' : 'red';
      html += `
        <h4 style="font-size:13px;margin:18px 0 8px">维度支配度（Jackknife）</h4>
        <div class="susp warn" style="border-color:${bal === 'green' ? '#bbf7d0' : ''};background:${bal === 'green' ? '#f0fdf4' : ''}">
          <span class="badge ${bal}">${U.esc(jk.balanceLabel)}</span><span>${U.esc(jk.note)}</span>
        </div>
        <div style="overflow-x:auto;margin-top:10px">
          <table class="tb"><thead><tr><th>维度</th><th class="c">分值</th><th class="c">本份得分</th><th class="c">剔除后总分漂移</th></tr></thead><tbody>
          ${jk.items.map((i) => `<tr>
            <td>${U.esc(i.name)}</td><td class="c">${i.max}</td><td class="c">${i.score}</td>
            <td class="c" style="font-weight:700;color:${Math.abs(i.impact) >= 4 ? 'var(--red)' : 'var(--green)'}">${i.impact > 0 ? '+' : ''}${i.impact}</td>
          </tr>`).join('')}
          </tbody></table>
        </div>`;
    }

    /* 篇幅偏差：全批次统计量，回答「是不是写得长就分高」 */
    if (lb && lb.ok) {
      const g = lb.grade;
      const m = lb.most;
      const l = lb.least;
      const sign = lb.per1k > 0 ? '+' : '';
      html += `
        <h4 style="font-size:13px;margin:18px 0 8px">篇幅偏差自检 · 分数有多少来自「写得长」</h4>
        <div class="kpi-row">
          <div class="kpi">
            <b style="color:${g.color}">${lb.r}</b>
            <small>字数 ↔ 总分 相关系数 · ${g.label}</small>
            <span>${g.desc}</span>
          </div>
          <div class="kpi">
            <b>${sign}${lb.per1k}</b>
            <small>每多 1000 字平均多拿的分</small>
            <span>由（字数, 总分）一元线性回归得出 · 样本 ${lb.n} 份</span>
          </div>
          <div class="kpi">
            <b>${lb.spread}</b>
            <small>被篇幅高估 / 低估的最大差值</small>
            <span>实际分与「按篇幅预期分」之差的最大跨度</span>
          </div>
        </div>
        <div class="susp">
          <span class="badge">${U.esc(m.name)}</span>
          <span>内容强于篇幅：实际 <b>${m.y}</b> 分，按篇幅只预期 ${m.pred.toFixed(1)} 分，
          高出 <b>${m.gap.toFixed(1)}</b> 分。</span></div>
        <div class="susp">
          <span class="badge">${U.esc(l.name)}</span>
          <span>篇幅超过内容：实际 <b>${l.y}</b> 分，按篇幅预期 ${l.pred.toFixed(1)} 分，
          低了 <b>${Math.abs(l.gap).toFixed(1)}</b> 分。</span></div>`;
    } else if (lb && !lb.ok) {
      html += `<div class="susp warn" style="margin-top:16px">
        <span class="badge amber">篇幅偏差</span><span>${U.esc(lb.note)}</span></div>`;
    }

    /* 批次内容覆盖：从作业本身长出来的检查清单，不靠老师预写词典 */
    if (ct && ct.ok) {
      const terms = ct.shared.slice(0, 18);
      const stuffed = stuffedDocs(ct);
      html += `
        <h4 style="font-size:13px;margin:18px 0 8px">批次内容覆盖 · 这批作业共同在写什么</h4>
        <div class="susp" style="margin-bottom:10px">
          <span class="badge blue">共识术语 ${ct.shared.length} 个</span>
          <span>${ct.total} 份报告中至少有 ${ct.need} 份提到的概念。清单由作业正文自动抽取
          （n-gram + 凝固度剪枝），<b>不是预先编写的词典</b> —— 换一批作业它会自己变。</span></div>`;
      if (terms.length) {
        html += `<div class="chips" style="margin-bottom:12px">${
          terms.map((t) => `<span class="chip">${U.esc(t.term)} <b style="opacity:.6">${t.count}/${ct.total}</b></span>`).join('')
        }${ct.shared.length > terms.length ? `<span class="chip">…另 ${ct.shared.length - terms.length} 个</span>` : ''}</div>`;
      }
      if (ct.missing.length) {
        html += `
          <div style="overflow-x:auto">
            <table class="tb"><thead><tr><th>报告</th><th>未覆盖的共识术语</th></tr></thead><tbody>
            ${ct.missing.slice(0, 8).map((m) => `<tr>
              <td>${U.esc(m.name)}</td>
              <td>${m.absent.slice(0, 8).map((t) => `<span class="chip miss">${U.esc(t)}</span>`).join(' ')}${
                m.absent.length > 8 ? ` <span class="hint">…另 ${m.absent.length - 8} 个</span>` : ''}</td>
            </tr>`).join('')}
            </tbody></table>
          </div>
          <div class="hint" style="margin-top:8px">漏掉共同概念不一定是错 —— 可能只是换了说法。
          这份清单是<b>复核线索</b>，不参与打分。</div>`;
      } else {
        html += `<div class="susp"><span class="badge green">全员覆盖</span><span>每份报告都提到了全部共识术语。</span></div>`;
      }
      if (stuffed.length) {
        html += `<div class="susp warn" style="margin-top:10px">
          <span class="badge amber">术语堆砌提示</span>
          <span>${stuffed.map((x) => `<b>${U.esc(x.name)}</b>`).join('、')}：
          术语覆盖齐全，但直接证据支撑度低于 50%，留意「名词都在、内容没跟上」。</span></div>`;
      }
    } else if (ct && !ct.ok) {
      html += `<div class="susp warn" style="margin-top:16px">
        <span class="badge amber">批次内容覆盖</span><span>${U.esc(ct.note)}</span></div>`;
    }

    return html;
  }

  /**
   * 术语覆盖齐全、但溯源显示证据支撑不足的报告 → 术语堆砌嫌疑。
   * 需要把「覆盖度」与「溯源」两件事接起来才有意义：单看任何一个都会误判。
   */
  function stuffedDocs(ct) {
    const covered = gradedDocs().filter((d) => !ct.missing.some((m) => m.name === d.name));
    const out = [];
    covered.forEach((d) => {
      const t = AG.reliability.evidenceAudit(d.result);
      if (t.ok && t.supportRate < 0.5) out.push({ name: d.name, rate: t.supportRate });
    });
    return out;
  }

  /* ---------- 3. 双引擎交叉验证 ---------- */

  function renderCvOptions() {
    const sel = $('#cvDoc');
    const cur = sel.value;
    sel.innerHTML = '';
    const gs = gradedDocs();
    if (!gs.length) {
      sel.innerHTML = '<option value="">暂无已评分报告</option>';
      return;
    }
    gs.forEach((d) => sel.appendChild(U.el('option', { value: d.id, html: U.esc(d.name) + '（' + d.result.total + ' 分）' })));
    if (cur) sel.value = cur;
  }

  async function runCV() {
    const box = $('#cvResult');
    const gs = gradedDocs();
    if (!gs.length) {
      box.innerHTML = '<div class="susp warn"><span class="badge amber">无数据</span><span>请先完成至少 1 份报告的评分。</span></div>';
      return;
    }
    const refreshed = ensureFreshResults();
    if (refreshed) toast(`量表已变更，已按新量表重新评分 ${refreshed} 份报告`, 'ok');

    const doc = gs.find((d) => d.id === ($('#cvDoc').value || gs[0].id)) || gs[0];
    const btn = $('#btnCV');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 对比中…';

    let second, srcLabel;
    const hasKey = !!AG.llm.getConfig().apiKey;
    try {
      if (hasKey) {
        second = await AG.llm.grade(doc, activeRubric());
        srcLabel = '大模型引擎';
      } else {
        second = AG.consensus.resampleBaseline(doc, activeRubric(), 60);
        srcLabel = '重采样基线';
      }
    } catch (e) {
      toast('第二意见生成失败：' + e.message + '，改用重采样基线', 'err');
      try {
        second = AG.consensus.resampleBaseline(doc, activeRubric(), 60);
        srcLabel = '重采样基线（大模型不可用）';
      } catch (e2) {
        btn.disabled = false; btn.textContent = '开始对比';
        box.innerHTML = `<div class="susp"><span class="badge red">失败</span><span>${U.esc(e2.message)}</span></div>`;
        return;
      }
    }

    const cmp = AG.consensus.compare(doc.result, second, activeRubric());
    const wA = U.clamp(Number($('#cvWeight').value), 0, 1);
    const fused = AG.consensus.fuse(doc.result, second, activeRubric(), wA);
    state.lastFused = { docId: doc.id, fused };

    btn.disabled = false; btn.textContent = '开始对比';

    const rows = cmp.dims.map((d) => `<tr>
      <td>${U.esc(d.name)}</td>
      <td class="c">${d.max}</td>
      <td class="c">${d.scoreA}</td>
      <td class="c">${d.scoreB}</td>
      <td class="c" style="font-weight:700;color:${d.color}">${d.diff > 0 ? '+' : ''}${d.diff}</td>
      <td class="c"><span class="badge" style="background:${d.color}18;color:${d.color}">${d.levelLabel}</span></td>
    </tr>`).join('');

    box.innerHTML = `
      <div class="susp warn" style="border-color:${cmp.verdictColor};background:${cmp.verdictColor}0f">
        <span class="badge" style="background:${cmp.verdictColor};color:#fff">${U.esc(cmp.verdict)}</span>
        <span>${U.esc(cmp.advice)}</span>
      </div>
      <div class="kpi-row" style="margin-top:12px">
        <div class="kpi"><b>${cmp.a.total}</b><small>A · ${U.esc(cmp.a.engineLabel)}</small><span>${cmp.a.grade} 级</span></div>
        <div class="kpi"><b>${cmp.b.total}</b><small>B · ${U.esc(cmp.b.engineLabel)}</small><span>${cmp.b.grade} 级</span></div>
        <div class="kpi"><b style="color:${Math.abs(cmp.totalDiff) > 5 ? 'var(--amber)' : 'var(--green)'}">${cmp.totalDiff > 0 ? '+' : ''}${cmp.totalDiff}</b><small>总分差</small><span>平均绝对误差 ${cmp.mae} 分</span></div>
        <div class="kpi"><b>${Math.round(cmp.agreeRate * 100)}%</b><small>维度一致率</small><span>跨维度相关 r = ${cmp.correlation}</span></div>
      </div>
      <h4 style="font-size:13px;margin:16px 0 8px">逐维度分歧（A → B，红色区间即分歧幅度）</h4>
      <div id="dvBox"></div>
      <div style="overflow-x:auto;margin-top:10px">
        <table class="tb"><thead><tr>
          <th>维度</th><th class="c">满分</th><th class="c">A 本地</th><th class="c">B ${U.esc(srcLabel)}</th>
          <th class="c">差值</th><th class="c">判定</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
      <h4 style="font-size:13px;margin:18px 0 8px">仲裁融合</h4>
      <div class="susp" style="border-color:#bbf7d0;background:#f0fdf4">
        <span class="badge green">融合分 ${fused.total}</span>
        <span>${U.esc(fused.engineLabel)} → ${fused.grade} 级 · ${U.esc(fused.gradeLabel)}
        ${cmp.reviewQueue.length ? `。另有 <b>${cmp.reviewQueue.length}</b> 个维度分歧较大，采用前建议复核：${cmp.reviewQueue.map((d) => U.esc(d.name)).join('、')}。` : '，各维度无显著分歧，可直接采用。'}</span>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" id="btnAdoptFused">采用融合分替换原评分</button>
      </div>`;

    const dv = $('#dvBox');
    if (dv) dv.appendChild(AG.charts.divergence(cmp));
    $('#btnAdoptFused').addEventListener('click', () => {
      doc.result = Object.assign({}, state.lastFused.fused);
      persist();
      renderDocList();
      renderResult();
      toast('已采用融合分', 'ok');
    });
  }

  /* ---------------- 智能量表（Rubric Lab） ----------------
   *
   * 设计原则：**自动出建议，人工做决定**。
   * 无论是「一句话生成」还是「按这批作业适配」，都不直接改写 state.rubric —— 先渲染成
   * 带对比与理由的预览卡，教师点「采纳」才落地。直接改是最省事的写法，也是最不可信的写法：
   * 一份没人看得懂为什么会变成这样的量表，教师是不敢拿来给学生打分的。
   */

  function renderLabChrome() {
    const sel = $('#tplPicker');
    if (sel && !sel.options.length) {
      sel.innerHTML = '<option value="auto">按提示词自动识别</option>'
        + AG.templates.meta().map((m) => `<option value="${m.id}">${U.esc(m.name)} · ${U.esc(m.brief || '')}</option>`).join('');
    }
    const chips = $('#exampleChips');
    if (chips && !chips.childElementCount) {
      chips.innerHTML = AG.rubriclab.EXAMPLES
        .map((s, i) => `<button type="button" class="chip" data-ex="${i}">${U.esc(s)}</button>`).join('');
      chips.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ex]');
        if (!b) return;
        $('#promptInput').value = AG.rubriclab.EXAMPLES[+b.dataset.ex];
        $('#promptInput').focus();
      });
    }
  }

  /** 把建议量表渲染成「原分值 → 建议分值」的对比表，含每一处变化的 tag */
  function rubricDiffRows(next) {
    const cur = state.rubric;
    return (next || []).map((d) => {
      const old = cur.find((x) => x.id === d.id || x.name === d.name);
      const to = d.enabled === false ? 0 : d.max;
      const from = old ? (old.enabled === false ? 0 : old.max) : null;
      let tag;
      if (!old) tag = '<span class="badge blue">新增</span>';
      else if (to === from) tag = '<span class="badge gray">持平</span>';
      else tag = `<span class="badge ${to > from ? 'green' : 'amber'}">${to > from ? '+' : ''}${to - from}</span>`;
      if (d.silent) tag = '<span class="badge amber">保底</span>';
      return `<tr>
        <td>${U.esc(d.name)}</td>
        <td class="c">${old ? from : '—'}</td>
        <td class="c"><b>${d.silent ? to + '*' : to}</b></td>
        <td class="c">${tag}</td>
        <td class="hint">${U.esc((d.desc || '').slice(0, 44))}</td>
      </tr>`;
    }).join('');
  }

  const DIFF_HEAD = `<thead><tr>
      <th>维度</th><th class="c">原分值</th><th class="c">建议分值</th><th class="c">变化</th><th>考察内容</th>
    </tr></thead>`;

  async function genFromPrompt() {
    const prompt = ($('#promptInput').value || '').trim();
    if (!prompt) return toast('先写一句评分要求，或点上面的示例', 'warn');
    const btn = $('#btnGenRubric');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 生成中…';
    try {
      const res = await AG.rubriclab.fromPrompt(prompt, {
        prefer: 'auto',
        templateId: $('#tplPicker').value || 'auto',
      });
      state.labPreview = res;
      renderLabPreview();
    } catch (e) {
      toast('生成失败：' + e.message, 'err');
    } finally { btn.disabled = false; btn.textContent = '按提示词生成'; }
  }

  function renderLabPreview() {
    const box = $('#labResult');
    const p = state.labPreview;
    if (!p) { box.innerHTML = ''; return; }
    const m = p.meta || {};
    const engineName = m.engine === 'llm' ? '大模型生成' : '本地规则引擎';
    const engineCls = m.engine === 'llm' ? 'blue' : 'gray';
    const confName = { high: '识别置信度高', medium: '识别置信度中等', low: '识别置信度偏低' }[m.confidence] || m.confidence;
    const confCls = { high: 'green', medium: 'amber', low: 'red' }[m.confidence] || 'gray';

    const notices = [];
    if (m.matchedAliases && m.matchedAliases.length) {
      notices.push(`<div class="ev">识别依据（命中关键词）：<em>${U.esc(m.matchedAliases.join('、'))}</em></div>`);
    }
    if (m.fallbackUsed) {
      notices.push(`<div class="ev">大模型生成失败，已回落到本地规则引擎：${U.esc(m.fallbackReason || '未知原因')}</div>`);
    }
    if ((m.unparsed || []).length) {
      notices.push(`<div class="ev">这几句没解析出评分意图：<em>${U.esc(m.unparsed.join(' / '))}</em>　不影响其余部分，也可以在下表中手动调。</div>`);
    }
    if ((m.missed || []).length) {
      notices.push(`<div class="ev">这几句听懂了，但「${U.esc(m.templateName || '当前')}」量表里没有对应维度：<em>${U.esc(m.missed.map((x) => x.keyword).join(' / '))}</em>　可手动新增一个维度来覆盖它。</div>`);
    }

    box.innerHTML = `
      <div class="stat-row">
        <div class="stat"><b>${(p.rubric || []).length}</b><small>维度数</small></div>
        <div class="stat"><b>${(p.rubric || []).reduce((s, d) => s + (d.enabled === false ? 0 : d.max), 0)}</b><small>合计分值</small></div>
        <div class="stat"><b>${(m.adjustments || []).length}</b><small>相对模板的调整项</small></div>
      </div>
      <div class="row" style="margin-top:10px;align-items:center;gap:8px">
        <span class="badge ${engineCls}">${U.esc(engineName)}</span>
        <span class="badge ${confCls}">${U.esc(confName)}</span>
        <span class="hint">${U.esc(m.templateName || '')}${m.templateBrief ? ' · ' + U.esc(m.templateBrief) : ''}</span>
      </div>
      <p class="hint" style="margin:8px 0 10px">${U.esc(m.summary || '')}</p>
      <div style="overflow-x:auto"><table class="tb">${DIFF_HEAD}<tbody>${rubricDiffRows(p.rubric)}</tbody></table></div>
      <p class="hint" style="margin-top:6px">带 * 号的维度在本批次中没有可区分的表现，按保底分保留（删除会形成「全班都不写就不计分」的错误激励）。</p>
      ${notices.join('')}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" id="btnAdoptLab">采纳到量表</button>
        <button class="btn" id="btnDropLab">放弃这条建议</button>
      </div>`;
    $('#btnAdoptLab').addEventListener('click', adoptLabPreview);
    $('#btnDropLab').addEventListener('click', () => { state.labPreview = null; renderLabPreview(); });
  }

  /**
   * 采纳建议时把维度顺序恢复成适配前的样子。
   * fit() 返回的是按区分度权重降序排列的结果 —— 语义上没错，但直接写进表格会让教师每次
   * 采纳后整个量表重排：上一秒还在第 2 行的维度跳到第 6 行，人眼就没法逐行比对改了什么。
   * 所以顺序一律保持不动，让「变化」tag 去说话。
   */
  function orderLike(next, ref) {
    if (!ref || !ref.length) return next;
    const pos = new Map(ref.map((d, i) => [d.id || d.name, i]));
    const overlap = next.filter((d) => pos.has(d.id || d.name)).length;
    // 换模板时两边维度八成对不上（物理 vs 编程只共用 purpose/format），强行按旧顺序排
    // 只能得到一串没有意义的先后关系，这时照搬新模板自己的顺序 —— 它本来就是按教学流程排的
    if (overlap * 2 < next.length) return next;
    const tail = 1e6;   // 新增维度排到最后；sort 稳定，它们之间的相对顺序也不变
    return next.slice().sort((a, b) => {
      const pa = pos.has(a.id || a.name) ? pos.get(a.id || a.name) : tail;
      const pb = pos.has(b.id || b.name) ? pos.get(b.id || b.name) : tail;
      return pa - pb;
    });
  }

  function adoptLabPreview() {
    const p = state.labPreview;
    if (!p) return;
    const next = AG.rubric.cloneRubric(p.rubric);
    // 用户在旧量表里锁定的维度要保住——否则换一次模板就把手动设定冲掉了，等于手动白调
    AG.rubriclab.applyLocks(next, state.rubric);
    const enabled = next.filter((d) => d.enabled !== false);
    if (Math.abs(enabled.reduce((s, d) => s + d.max, 0) - 100) > 0.5) {
      AG.templates.normalizeScores(enabled, 100);   // 锁定值回填可能打破合计 100
    }
    state.rubric = orderLike(next, state.rubric);
    U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
    state.labPreview = null;
    renderLabPreview(); renderRubricTable();
    toast('已采纳新量表，重新评分后生效', 'ok');
  }

  /* ---------------- 批次自适应建议 ---------------- */

  function batchDocs() {
    return state.docs.map((d) => ({ id: d.id, name: d.name, text: d.text, features: d.features }));
  }

  function computeBatchSuggestion() {
    const docs = batchDocs().filter((d) => String(d.text || '').trim().length >= 50);
    if (docs.length < 4) return { tooFew: true, count: docs.length };
    let mix = null, sug = null, res = null, err = null;
    try { mix = AG.rubriclab.detectMix(docs, {}); } catch (e) { mix = null; }
    try { sug = AG.rubriclab.suggestTemplate(docs, {}); } catch (e) { sug = null; }
    try { res = AG.rubriclab.fit(docs, state.rubric, {}); } catch (e) { err = e; }
    return { docs, mix, sug, res, err };
  }

  /** 建议卡片：把「为什么这么调」摆在分数旁边，而不是只丢一句「分值已更新」 */
  function renderSuggestion(container, payload, auto) {
    const { mix, sug, res, err } = payload;
    const h = [];

    if (payload.tooFew) {
      container.innerHTML = `<div class="card"><h3>暂无量表建议 <span class="sub">已录入 ${payload.count} 份</span></h3>
        <p class="hint">批次自适应至少需要 <b>4 份</b>作业：少于 4 份时区分度基本是拿一篇对另一篇算出来的，换个班就不灵了。继续录入后会自动重试。</p></div>`;
      return;
    }
    if (err) {
      container.innerHTML = `<div class="card"><h3>批次自适应未完成</h3>
        <div class="susp warn"><span>${U.esc(err.message)}</span></div></div>`;
      return;
    }
    if (mix && mix.mixed) {
      h.push(`<div class="susp"><span><b>疑似混批：</b>${U.esc(mix.reason)}
        ${mix.clusters.slice(0, 3).map((c) => `<br>· ${c.size} 份：${U.esc((c.sections || []).join(' / '))}`).join('')}
        <br><span class="hint">建议按题目分批评阅；若坚持合批，下方建议按占多数的一类作业给出。</span></span></div>`);
    }
    if (sug && sug.template && sug.coverage >= 0.7) {
      const sameAsNow = state.rubric.length === (sug.template.dims || []).length
        && (sug.template.dims || []).every((d) => state.rubric.some((x) => x.id === d.id));
      h.push(`<div class="ev">这批作业看起来是<em>${U.esc(sug.template.name)}</em>（${U.esc(sug.reason)}）${sameAsNow ? '' : '　当前量表与此不符，可在上方选同名模板作为基底后重新适配。'}</div>`);
    }
    if (res && res.blocked) {
      h.push(`<div class="susp warn"><span><b>暂不建议调整：</b>${U.esc(res.reason)}</span></div>`);
    } else if (res && !res.unchanged) {
      // 卡片里的行序也跟着量表走：差异才是主角，别让顺序抢戏
      const posOf = (n) => { const i = state.rubric.findIndex((d) => d.name === n); return i < 0 ? 1e6 : i; };
      const ordered = res.changes.slice().sort((a, b) => posOf(a.dim) - posOf(b.dim));
      const rows = ordered.map((c) => {
        const tag = c.delta > 0 ? `<span class="badge green">+${c.delta}</span>`
          : c.delta < 0 ? `<span class="badge amber">${c.delta}</span>` : '<span class="badge gray">持平</span>';
        return `<tr><td>${U.esc(c.dim)}</td><td class="c">${c.from}</td><td class="c"><b>${c.to}</b></td>
          <td class="c">${tag}</td><td class="hint">${U.esc(c.why)}</td></tr>`;
      }).join('');
      const dropped = (res.dropped || []).slice(0, 4)
        .map((d) => `<span class="chip miss">${U.esc(d.label)} Δ${d.delta}</span>`).join(' ');
      h.push(`<div style="overflow-x:auto"><table class="tb">${DIFF_HEAD.replace('<th>考察内容</th>', '<th>为什么这么调</th>')}<tbody>${rows}</tbody></table></div>`);
      if (dropped) h.push(`<div class="grp" style="margin-top:8px"><div class="lb">被判为零区分度、未被采纳的要点（写了跟没写一个样）</div><div class="chips">${dropped}</div></div>`);
      h.push(`<div class="btn-row" style="margin-top:12px">
        <button class="btn primary js-adopt">采纳这批建议</button>
        <button class="btn js-dismiss">保持原量表</button></div>`);
      if (auto) {
        h.push(`<p class="hint" style="margin-top:8px">不希望每次上传都弹这张卡？<a href="javascript:void(0)" class="js-mute" style="text-decoration:underline">关闭自动建议</a>，之后仍可在设置页点「按已上传作业适配」手动触发。</p>`);
      }
    } else if (res) {
      h.push(`<div class="ev">这批作业跑下来的权重与当前量表基本一致（各项变动 ≤ 1 分），没有需要提示的调整。</div>`);
    }
    container.innerHTML = `<div class="card"><h3>量表自适应建议 <span class="sub">基于 ${payload.docs.length} 份作业的无标注分析</span></h3>${h.join('')}</div>`;
    const adopt = container.querySelector('.js-adopt');
    if (adopt) {
      adopt.addEventListener('click', () => {
        // fit() 内部已按当前量表跑过 applyLocks，这里补的不是保护而是顺序：
        // 让表格行序保持稳定，教师才能一眼看出「哪一项涨了、哪一项跌了」
        state.rubric = orderLike(AG.rubric.cloneRubric(payload.res.rubric), state.rubric);
        U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
        renderRubricTable();
        hideSuggestCard();
        toast('已采纳量表建议，重新评分后生效', 'ok');
      });
    }
    const dismiss = container.querySelector('.js-dismiss');
    if (dismiss) dismiss.addEventListener('click', hideSuggestCard);
    const mute = container.querySelector('.js-mute');
    if (mute) {
      mute.addEventListener('click', () => {
        state.autoFitMuted = true;
        U.store.set('autoFitMuted', true);
        hideSuggestCard();
        toast('已关闭上传后的自动量表建议，可在设置页手动触发', 'ok');
      });
    }
  }

  function hideSuggestCard() {
    const el = $('#suggestCard');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  /**
   * 上传后自动分析（用户选定的触发时机）。
   * 三条节流规则：① 满 4 份才跑，② 文档集合没变不重跑，③ 防抖 0.9 秒（连续拖拽会连打多次）。
   * 更重要的第 ④ 条：**没有可说的内容就闭嘴**。分批建议只有在真的混批、或分值有实质变化时
   * 才弹卡片，否则每次上传都弹一张「一切正常」的卡，弹三次用户就永久忽略了。
   */
  function maybeAutoFit() {
    const el = $('#suggestCard');
    if (!el) return;
    if (state.autoFitMuted) return;
    if (state.docs.length < 4) { hideSuggestCard(); state.autoFitKey = ''; return; }
    const key = state.docs.map((d) => d.id).join(',');
    if (key === state.autoFitKey) return;
    state.autoFitKey = key;
    clearTimeout(state.autoFitTimer);
    state.autoFitTimer = setTimeout(() => {
      const payload = computeBatchSuggestion();
      if (!payload || payload.tooFew || payload.err) return;
      const worthTelling = (payload.mix && payload.mix.mixed)
        || (payload.res && !payload.res.blocked && !payload.res.unchanged);
      if (!worthTelling) { hideSuggestCard(); return; }
      el.style.display = '';
      renderSuggestion(el, payload, true);
    }, 900);
  }

  function runLabFitManual() {
    const payload = computeBatchSuggestion();
    renderSuggestion($('#labResult'), payload, false);
    if (payload.tooFew) toast('至少需要 4 份作业才能做批次自适应（当前 ' + payload.count + ' 份）', 'warn');
  }

  /* ---------------- 渲染：量表 ---------------- */
  function renderRubricTable() {
    const tbody = $('#rubricTable').querySelector('tbody');
    tbody.innerHTML = '';
    state.rubric.forEach((d, i) => {
      const tr = U.el('tr', {});
      const lockTip = '锁定后，批次自适应与一句话生成都不会再改这个维度的分值';
      tr.innerHTML = `
        <td class="c"><input type="checkbox" data-f="enabled" data-i="${i}" ${d.enabled !== false ? 'checked' : ''} title="是否参与评分"></td>
        <td class="c"><input type="checkbox" data-f="locked" data-i="${i}" ${d.locked ? 'checked' : ''} title="${lockTip}"></td>
        <td><input type="text" data-f="name" data-i="${i}" value="${U.esc(d.name)}"></td>
        <td class="c"><input type="number" data-f="max" data-i="${i}" value="${d.max}" min="0" max="100" step="1" style="width:70px" title="改分值会自动锁定该维度"></td>
        <td class="hint">${U.esc((d.desc || '').slice(0, 42))}${(d.desc || '').length > 42 ? '…' : ''}</td>
        <td class="c"><span class="badge gray">${(d.signals || []).length}</span></td>`;
      tbody.appendChild(tr);
    });
    const t = rubricTotal();
    const el = $('#rubricTotal');
    el.textContent = `启用维度总分 ${t}（共 ${state.rubric.length} 个维度）`;
    el.style.color = Math.abs(t - 100) < 0.001 ? 'var(--green)' : 'var(--amber)';
  }

  /**
   * 量表表格的输入绑定。这里有一条容易被忽略的产品约定：
   * **手动改过的分值必须比自动生成优先级高**。教师既然肯动手填数字，说明他有明确意图
   * （比如「这题仪器型号就是不算分」），后面任何自动适配都不该悄悄改回去 —— 否则手动调过的
   * 人会白调一次，第二次他就不信这个系统了。所以改分值即落 lock，且 lock 只在用户主动
   * 取消勾选时解除。
   */
  function bindRubricInputs() {
    const table = $('#rubricTable');
    table.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.dataset.f) return;
      const i = +t.dataset.i;
      const d = state.rubric[i];
      if (!d) return;
      const f = t.dataset.f;

      if (f === 'enabled') {
        d.enabled = t.checked;
      } else if (f === 'locked') {
        d.locked = t.checked;
      } else if (f === 'name') {
        const v = t.value.trim() || d.name;
        if (v === d.name) return;
        d.name = v;
        commitRubric();
        toast('维度名称已保存', 'ok');
        return;
      } else if (f === 'max') {
        const before = Number(d.max) || 0;
        const after = U.clamp(Number(t.value) || 0, 0, 100);
        if (after === before) return;
        d.max = after;
        d.locked = true;   // 手改即锁：这是「尊重手动意图」的实现方式
      }

      commitRubric();
      renderRubricTable();
      if (f === 'max') {
        toast(`「${d.name}」已改为 ${d.max} 分并锁定（自动适配不会再改它）`, 'ok');
      } else if (f === 'locked') {
        toast(d.locked ? `「${d.name}」已锁定，自动适配不会再改它的分值` : `「${d.name}」已解锁，允许自动调整`, 'ok');
      } else {
        toast('量表已保存，重新评分后生效', 'ok');
      }
    });
  }

  function commitRubric() {
    U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
  }

  /* ---------------- 模型配置 ---------------- */
  function loadCfgForm() {
    const c = AG.llm.getConfig();
    $('#cfgBaseUrl').value = c.baseUrl;
    $('#cfgModel').value = c.model;
    $('#cfgApiKey').value = c.apiKey;
    $('#cfgTemp').value = c.temperature;
    $('#cfgMaxChars').value = c.maxChars;
  }

  /* ---------------- 导出 ---------------- */
  function buildMd(doc) {
    const r = doc.result;
    const lines = [];
    lines.push(`# 实验报告评阅结果：${doc.name}`, '');
    lines.push(`- 综合得分：**${r.total} / 100**（${r.grade} 级 · ${r.gradeLabel}）`);
    lines.push(`- 评阅引擎：${r.engineLabel}`);
    lines.push(`- 评阅时间：${U.fmtTime(r.gradedAt)}`);
    lines.push(`- 篇幅：${r.features.words} 字 / 代码块 ${r.features.codeBlockCount} 个 / 图表引用 ${r.features.figureCount + r.features.tableCount} 处 / 数据点 ${r.features.numberCount} 个`, '');
    lines.push(`## 总体评语`, '', r.overall || '', '');
    lines.push(`## 分项得分`, '');
    lines.push(`| 维度 | 得分 | 满分 | 得分率 | 评价 |`, `| --- | --- | --- | --- | --- |`);
    r.dims.forEach((d) => {
      lines.push(`| ${d.name} | ${d.score} | ${d.max} | ${Math.round(d.ratio * 100)}% | ${(d.comment || '').replace(/\|/g, '/')} |`);
    });
    lines.push('', `## 逐项核查明细`, '');
    r.dims.forEach((d) => {
      lines.push(`### ${d.name}（${d.score}/${d.max}）`, '');
      if (d.evidence && d.evidence.length) {
        lines.push(`**命中证据**：${d.evidence.map((e) => e.label).join('、')}`, '');
        d.evidence.filter((e) => e.snippets && e.snippets.length).slice(0, 3)
          .forEach((e) => lines.push(`> ${e.label}：${e.snippets[0].snippet}`, ''));
      }
      if (d.missing && d.missing.length) lines.push(`**缺失要点**：${d.missing.map((m) => m.label).join('、')}`, '');
      if (d.penalties && d.penalties.length) lines.push(`**扣分项**：${d.penalties.map((p) => `${p.label}（-${p.weight}）`).join('、')}`, '');
      if (d.advice) lines.push(`**改进建议**：${d.advice}`, '');
    });
    lines.push('---', `由 AutoGrader 自动生成 · 粤港澳大湾区 AI Coding 创新大赛参赛作品`);
    return lines.join('\n');
  }

  function exportOneMd() {
    const doc = state.docs.find((d) => d.id === state.currentId);
    if (!doc || !doc.result) return toast('该报告尚未评分', 'err');
    U.download(`评阅报告-${doc.name.replace(/\.[^.]+$/, '')}.md`, buildMd(doc), 'text/markdown');
    toast('已导出 Markdown 评阅报告', 'ok');
  }

  /** 单篇导出 PDF（直接落盘，不弹打印对话框） */
  async function exportOnePdf() {
    const doc = state.docs.find((d) => d.id === state.currentId);
    if (!doc || !doc.result) return toast('该报告尚未评分', 'err');
    const btn = $('#btnExportOnePdf');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    try {
      await AG.pdf.exportDocs([doc], `评阅报告-${doc.name.replace(/\.[^.]+$/, '')}.pdf`);
      toast(U.downloadRisky()
        ? '已生成 PDF。若浏览器没有开始下载，请看导出按钮下方的提示'
        : '已导出 PDF 评阅报告', 'ok');
    } catch (e) {
      toast('PDF 导出失败：' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '导出 PDF'; }
    }
  }

  /** 批量导出 PDF：一份报告一个分页段落，合并为单个 PDF */
  async function exportAllPdf() {
    const graded = state.docs.filter((d) => d.result);
    if (!graded.length) return toast('暂无已评分报告', 'err');
    const btn = $('#btnExportAllPdf');
    if (btn) { btn.disabled = true; btn.textContent = `生成中… (${graded.length} 份)`; }
    try {
      await AG.pdf.exportDocs(graded, '评阅报告汇总.pdf');
      toast(U.downloadRisky()
        ? `已生成 ${graded.length} 份报告的 PDF。若浏览器没有开始下载，请看导出按钮下方的提示`
        : `已导出 ${graded.length} 份评阅报告 PDF`, 'ok');
    } catch (e) {
      toast('PDF 导出失败：' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '导出评阅报告 (PDF)'; }
    }
  }

  function exportAllMd() {
    const graded = state.docs.filter((d) => d.result);
    if (!graded.length) return toast('暂无已评分报告', 'err');
    U.download('评阅报告汇总.md', graded.map(buildMd).join('\n\n---\n\n'), 'text/markdown');
    toast('已导出全部评阅报告', 'ok');
  }

  function exportCsv() {
    const graded = state.docs.filter((d) => d.result);
    if (!graded.length) return toast('暂无已评分报告', 'err');
    const dimNames = (graded[0].result.dims || []).map((d) => d.name);
    const head = ['报告名称', ...dimNames, '总分', '等级', '字数', '代码块', '评阅引擎', '评阅时间'];
    const rows = graded.map((d) => {
      const r = d.result;
      return [
        d.name, ...r.dims.map((x) => x.score), r.total, r.grade,
        r.features.words, r.features.codeBlockCount, r.engineLabel, U.fmtTime(r.gradedAt),
      ];
    });
    const csv = '\uFEFF' + [head, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    U.download('成绩汇总.csv', csv, 'text/csv');
    toast('已导出成绩表 CSV', 'ok');
  }

  /* ---------------- 站内答疑助手 ----------------
   * 引擎在 chat.js；这里只负责把「当前站内的真实状态」交给它，并把回答渲染出来。
   * 上下文是每次提问时现算的，所以评了一份新报告、换了量表、切了人格，
   * 下一次提问立刻按新状态答——不需要用户手动刷新什么。
   */

  /** 当前这批里最相似的一对，供答疑引用具体数字 */
  function chatSimTop() {
    const s = state.sim;
    if (!s || !s.matrix || !s.matrix.length) return null;
    const graded = state.docs.filter((d) => d.result);
    let best = null;
    s.matrix.forEach((row, i) => {
      (row || []).forEach((v, j) => {
        if (j <= i || !graded[i] || !graded[j]) return;
        if (!best || v > best.value) best = { i, j, value: v };
      });
    });
    return best ? { a: graded[best.i].name, b: graded[best.j].name, value: best.value } : null;
  }

  function chatContext() {
    const doc = state.docs.find((d) => d.id === state.currentId) || null;
    const graded = state.docs.filter((d) => d.result);
    const cfg = AG.llm.getConfig();

    let cur = null;
    if (doc && doc.result) {
      const r = doc.result;
      let sim = null;
      const gi = graded.indexOf(doc);
      if (gi >= 0 && state.sim && state.sim.matrix && state.sim.matrix[gi]) {
        const top = state.sim.matrix[gi]
          .map((v, j) => ({ v, j })).filter((o) => o.j !== gi)
          .sort((a, b) => b.v - a.v)[0];
        if (top) sim = top.v;
      }
      cur = {
        name: doc.name,
        total: r.total, grade: r.grade, gradeLabel: r.gradeLabel,
        words: r.features ? r.features.words : 0,
        dims: r.dims || [],
        gate: r.gate || null,
        similarity: sim,
      };
    }

    return {
      docCount: state.docs.length,
      doc: cur,
      rubric: state.rubric.map((d) => ({ name: d.name, max: d.max, enabled: d.enabled !== false })),
      llmReady: !!(cfg && cfg.apiKey),
      llmModel: (cfg && cfg.model) || '',
      tone: AG.voice.get(),
      simTop: chatSimTop(),
      simCount: graded.length,
    };
  }

  function updateChatMode() {
    const cfg = AG.llm.getConfig();
    const el = $('#chatMode');
    if (!el) return;
    el.textContent = cfg.apiKey
      ? `本地知识库优先 · 未命中转大模型（${cfg.model || '未指定'}）`
      : '本地知识库 · 无需联网';
  }

  function renderChat() {
    const body = $('#chatBody');
    if (!body) return;
    body.innerHTML = '';
    if (!state.chat.length) {
      body.appendChild(U.el('div', { class: 'msg ai' }, [
        U.el('div', { class: 'bubble' }, [
          '本站怎么用、这个分为什么这么低、查重怎么看——都可以问我。\n' +
          '默认走本地知识库，不联网、不花 token；配了 API Key 之后，' +
          '本地答不上来的才会转给大模型，并且带上当前报告的评分上下文。',
        ]),
      ]));
    }
    state.chat.forEach((m) => {
      const wrap = U.el('div', { class: 'msg ' + (m.role === 'me' ? 'me' : 'ai') }, [
        U.el('div', { class: 'bubble' }, [m.text]),
      ]);
      if (m.role === 'ai' && m.source) {
        wrap.appendChild(U.el('div', { class: 'msg-src' }, [AG.chat.sourceLabel(m.source)]));
      }
      body.appendChild(wrap);
    });
    body.scrollTop = body.scrollHeight;
    U.store.set('chat', state.chat);
  }

  function renderChatChips() {
    const box = $('#chatChips');
    if (!box) return;
    box.innerHTML = '';
    AG.chat.quickQuestions(chatContext()).forEach((q) => {
      const b = U.el('button', { type: 'button' }, [q]);
      b.addEventListener('click', () => { $('#chatInput').value = q; sendChat(); });
      box.appendChild(b);
    });
  }

  async function sendChat() {
    const input = $('#chatInput');
    const q = (input.value || '').trim();
    if (!q) return;
    if (state.chatBusy) return;
    state.chatBusy = true;

    input.value = '';
    autoGrowChat();
    state.chat.push({ role: 'me', text: q });
    renderChat();

    const body = $('#chatBody');
    const typing = U.el('div', { class: 'msg ai typing' }, [
      U.el('div', { class: 'bubble' }, ['正在翻站内知识库']),
    ]);
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;

    let res;
    try {
      res = await AG.chat.ask(q, chatContext());
    } catch (e) {
      res = { text: '出了点岔子：' + ((e && e.message) || '未知错误'), source: 'fallback' };
    }
    typing.remove();
    state.chat.push({ role: 'ai', text: res.text, source: res.source });
    state.chatBusy = false;
    renderChat();
  }

  function autoGrowChat() {
    const t = $('#chatInput');
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 92) + 'px';
  }

  function toggleChat(open) {
    const p = $('#chatPanel'), fab = $('#chatFab');
    if (!p || !fab) return;
    const show = open === undefined ? p.style.display === 'none' : !!open;
    p.style.display = show ? 'flex' : 'none';
    fab.classList.toggle('on', show);
    if (show) { updateChatMode(); renderChatChips(); renderChat(); $('#chatInput').focus(); }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

    // 答疑助手
    $('#chatFab').addEventListener('click', () => toggleChat());
    $('#chatClose').addEventListener('click', () => toggleChat(false));
    $('#chatSend').addEventListener('click', sendChat);
    $('#chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $('#chatInput').addEventListener('input', autoGrowChat);
    $('#chatClear').addEventListener('click', () => {
      state.chat = [];
      renderChat();
      renderChatChips();
    });

    // 上传
    $('#dropzone').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => $('#dropzone').addEventListener(ev, (e) => {
      e.preventDefault(); $('#dropzone').classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => $('#dropzone').addEventListener(ev, (e) => {
      e.preventDefault(); $('#dropzone').classList.remove('over');
    }));
    $('#dropzone').addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

    // 粘贴
    $('#btnPaste').addEventListener('click', () => {
      $('#pasteName').value = '';
      $('#pasteText').value = '';
      $('#pasteMask').classList.add('on');
    });
    $('#pasteCancel').addEventListener('click', () => $('#pasteMask').classList.remove('on'));
    $('#pasteMask').addEventListener('click', (e) => { if (e.target.id === 'pasteMask') $('#pasteMask').classList.remove('on'); });
    $('#pasteOk').addEventListener('click', () => {
      const text = $('#pasteText').value.trim();
      if (!text) return toast('请输入报告正文', 'err');
      const name = $('#pasteName').value.trim() || ('粘贴报告-' + (state.docs.length + 1) + '.md');
      AG.parser.fromText(name, text);
      addDoc(name, text);
      $('#pasteMask').classList.remove('on');
      toast('已录入，点击「全部重新评分」开始评阅', 'ok');
    });

    // 示例
    $('#btnDemo').addEventListener('click', async () => {
      AG.demos.forEach((s) => addDoc(s.name, s.text));
      toast('已加载 3 份示例报告，开始评阅…', 'ok');
      await gradeAll();
    });

    // 评分
    $('#btnGradeAll').addEventListener('click', gradeAll);
    $('#btnClear').addEventListener('click', () => {
      if (!state.docs.length) return;
      if (!confirm('确认清空所有已录入的报告？')) return;
      state.docs = []; state.currentId = null; state.sim = null;
      persist(); renderDocList(); renderResult(); renderBatch();
      maybeAutoFit();
    });

    // 引擎切换
    $('#btnEngineLocal').addEventListener('click', () => {
      state.engine = 'local'; U.store.set('engine', 'local');
      refreshEngineBadge(); toast('已切换到本地启发式引擎（离线可用）', 'ok');
    });
    $('#btnEngineLLM').addEventListener('click', () => {
      state.engine = 'llm'; U.store.set('engine', 'llm');
      refreshEngineBadge();
      if (!AG.llm.getConfig().apiKey) {
        toast('尚未配置 API Key —— 已为你打开配置页，选一个服务商再填 Key 即可', 'err');
        switchView('settings');
      } else toast('已切换到大模型引擎', 'ok');
    });

    // 批量页导出
    $('#btnExportCsv').addEventListener('click', exportCsv);
    $('#btnExportAll').addEventListener('click', exportAllMd);
    $('#btnExportAllPdf').addEventListener('click', exportAllPdf);

    // 智能分析
    $('#btnInduce').addEventListener('click', runInduce);
    $('#btnInduceExport').addEventListener('click', exportInduced);
    $('#btnAudit').addEventListener('click', runAudit);
    $('#btnCV').addEventListener('click', runCV);
    $('#auditDoc').addEventListener('change', () => { /* 换对象后需重新运行自检 */ });
    $('#cvDoc').addEventListener('change', () => { $('#cvResult').innerHTML = ''; });

    // 量表
    bindRubricInputs();
    $('#btnGenRubric').addEventListener('click', genFromPrompt);
    $('#btnFitBatch').addEventListener('click', runLabFitManual);
    // 输入框里回车直接生成：一行字写完就想看结果，再去够鼠标是没必要的
    $('#promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); genFromPrompt(); }
    });
    $('#btnResetRubric').addEventListener('click', () => {
      if (!confirm('恢复为默认量表？自定义分值与锁定状态将丢失。')) return;
      state.rubric = AG.rubric.cloneRubric().map((d) => Object.assign({ enabled: true }, d));
      U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
      renderRubricTable(); toast('已恢复默认量表', 'ok');
    });
    $('#btnAddDim').addEventListener('click', () => {
      const name = prompt('新维度名称：', '自定义维度');
      if (!name) return;
      const max = Number(prompt('该维度分值：', '5')) || 5;
      state.rubric.push({
        id: 'custom_' + U.uid(''), name, max, desc: '自定义评分维度（本地引擎按通用规则评分）',
        signals: [{ label: '包含相关内容', re: /./g, w: 1 }], penalties: [], advice: '', enabled: true,
      });
      U.store.set('rubric', AG.rubric.serializeRubric(state.rubric));
      renderRubricTable(); toast('已新增维度，可在下一版中补充信号词典', 'ok');
    });

    // 模型配置
    $('#btnSaveCfg').addEventListener('click', () => {
      AG.llm.saveConfig({
        enabled: true,
        baseUrl: $('#cfgBaseUrl').value.trim(),
        model: $('#cfgModel').value.trim(),
        apiKey: $('#cfgApiKey').value.trim(),
        temperature: Number($('#cfgTemp').value),
        maxChars: Number($('#cfgMaxChars').value),
      });
      refreshEngineBadge();
      toast('配置已保存到本机', 'ok');
    });
    $('#btnTestCfg').addEventListener('click', async () => {
      const btn = $('#btnTestCfg');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 测试中…';
      try {
        const r = await AG.llm.testConnection({
          baseUrl: $('#cfgBaseUrl').value.trim(),
          model: $('#cfgModel').value.trim(),
          apiKey: $('#cfgApiKey').value.trim(),
        });
        // 把模型回复一并显示：只说「通过」用户无从判断是真通了还是走了什么捷径
        const reply = r && r.reply ? ' · 模型回复「' + r.reply.slice(0, 30) + '」' : '';
        toast('连通性测试通过' + reply, 'ok');
      } catch (e) {
        toast('测试失败：' + e.message, 'err');
      } finally { btn.disabled = false; btn.textContent = '测试连通性'; }
    });
    $('#btnClearCfg').addEventListener('click', () => {
      AG.llm.saveConfig(Object.assign({}, AG.llm.DEFAULT_CONFIG));
      loadCfgForm(); refreshEngineBadge(); toast('已清除 API Key', 'ok');
    });

    // 服务商预设：填好地址与模型，用户只需再补 Key
    $$('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = PROVIDER_PRESETS[btn.dataset.preset];
        if (!p) return;
        $('#cfgBaseUrl').value = p.baseUrl;
        $('#cfgModel').value = p.model;
        if (p.offline) {
          $('#cfgApiKey').value = p.apiKey;
          toast(`${p.label}：本地运行，不校验 Key（已自动填占位符），先在本机跑 ollama serve 再保存`, 'ok');
        } else {
          $('#cfgApiKey').focus();
          toast(`已填入 ${p.label} 的地址与模型，请粘贴你的 API Key 后保存`, 'ok');
        }
      });
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
    // 提前把吉祥物解码成 Image，供 PDF 导出的 Canvas 同步绘制用
    // （导出流程是同步的，不能在那里等图片 onload）
    if (AG.mascots && AG.mascots.load) AG.mascots.load();
    setupAppearance();
    updateChatMode();
    refreshEngineBadge();
    renderDocList();
    renderResult();
    // 恢复上次会话时，若文档已有评阅结果则直接展示
    if (state.docs.length) {
      state.currentId = state.currentId || state.docs[0].id;
      computeSim();
    }
    renderDocList();
    renderResult();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
