/* AutoGrader · 大模型评分引擎（LLM Engine）
 * 兼容 OpenAI 风格的 /chat/completions 接口。
 *
 * 【2026-09 变更】本地启发式评分引擎已移除，本模块成为**唯一的评分入口**。
 * 相应地，失败时不再"静默回退本地引擎"——那种兜底会让教师以为拿到了分，
 * 实际上拿到的是一个完全不同口径的分数，比直接报错更危险。现在失败就是失败，
 * 错误信息必须说明下一步该做什么（见 humanizeHttpError）。
 *
 * 【开源优先】默认配置改为 AG.providers.recommend() 给出的免费开源模型，
 * 而不是某家闭源商业 API。教师零成本即可跑通，也能一键换成本地 Ollama 离线运行。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /** 默认取「免费 + 开源 + 支持 JSON 输出」里排最前的服务商预设 */
  function defaultProvider() {
    return (AG.providers && AG.providers.recommend()) || {
      baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct',
    };
  }

  const DEFAULT_CONFIG = {
    enabled: false,
    baseUrl: defaultProvider().baseUrl,
    apiKey: '',
    model: defaultProvider().model,
    providerId: (AG.providers && AG.providers.recommend() && AG.providers.recommend().id) || 'siliconflow',
    temperature: 0.2,
    maxChars: 12000,
    // 交叉验证用的第二个模型（需求①「每次调用模型评分结果差异化」）
    reviewModel: '',
    reviewBaseUrl: '',
    reviewApiKey: '',
    reviewProviderId: '',
  };

  function getConfig() {
    return Object.assign({}, DEFAULT_CONFIG, U.store.get('llmConfig', {}));
  }
  function saveConfig(cfg) {
    U.store.set('llmConfig', cfg);
    U.bus.emit('llm:config', cfg);
  }

  function buildPrompt(doc, rubric) {
    /* 量表下发给模型时，把 signals / penalties 一并转成文字要点。
     * 这两个字段原本还要驱动本地正则打分，现在专供 Prompt 使用，
     * 于是可以放心地把 penalties（扣分项）也带上——旧版为了兼容正则引擎没敢动。 */
    const dims = rubric.map((d) => ({
      id: d.id,
      name: d.name,
      max: Number(d.max),
      desc: d.desc,
      points: (d.signals || []).map((s) => s.label),
      deductions: (d.penalties || []).map((p) => p.label),
    }));

    const content = (doc.text || '').slice(0, getConfig().maxChars);
    const truncated = (doc.text || '').length > getConfig().maxChars;

    // 语气人格由 AG.voice 注入：换「学院派 / 傲娇小天才 / 火力全开」即换整套评语风格，
    // 且人格提示里已写死「对事不对人 + 毒舌必带解药」两条硬约束。
    const toneHint = AG.voice ? AG.voice.systemHint() : '';

    const system = `你是一名严谨的高校计算机专业实验报告评阅助教。
你将收到一份实验报告和一份评分量表（JSON）。请严格依据量表逐项评分。

要求：
1. 只依据报告实际内容评分，不得臆测未写出的内容。
2. 每个维度给出 0 到 max 之间的分数（可保留 1 位小数）。
3. points 是该维度的得分要点，deductions 是该维度的扣分情形；命中扣分情形时须在 comment 中说明。
4. 评分须可复现：同一份报告重复评阅应给出接近的分数，不要因表述顺序变化而漂移。
5. evidence 必须引用报告中的**逐字原文片段**（每条不超过 40 字），
   不得改写、不得杜撰——系统会逐条回查原文，编造的证据将直接作废。没有证据时为空数组。
6. missing 列出该维度明显缺失的要点。
7. comment 用一句话给出具体、可执行的改进建议，禁止空话。
8. 整体评语 overall 控制在 120 字以内，先肯定再指出最关键的改进点。
9. 只输出 JSON，不要输出任何解释或 Markdown 代码块标记。

${toneHint ? '【语气设定】\n' + toneHint + '\n' : ''}
输出格式：
{
  "dims": [
    { "id": "维度id", "score": 12.5, "evidence": ["…"], "missing": ["…"], "comment": "…" }
  ],
  "overall": "…"
}`;

    const user = `【评分量表】\n${JSON.stringify(dims, null, 2)}\n\n` +
      `【实验报告：${doc.name}】\n${content}${truncated ? '\n\n（报告过长，以上为前 ' + getConfig().maxChars + ' 字）' : ''}`;

    return { system, user };
  }

  /**
   * @param {object} cfg    配置
   * @param {Array}  messages 对话
   * @param {object} [opts] { json: true } 时才要求结构化输出
   *
   * response_format 绝不能无条件带 —— 这是踩过的坑：
   * OpenAI 规定 json_object 模式下 messages 里必须出现 json 字样，否则直接 400。
   * 「测试连通性」（只回复 OK）和「答疑」（自然语言问答）的 prompt 里都没有这个词，
   * 于是这两条路必然 400；即便服务商不做这条校验，答疑也会被逼着吐 JSON 而不是人话。
   * 所以只有真正需要结构化结果的地方（评分、量表生成）才开。
   */
  async function callChat(cfg, messages, opts) {
    const jsonMode = !!(opts && opts.json);
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(Object.assign({
          model: cfg.model,
          temperature: Number(cfg.temperature) || 0.2,
          messages,
        }, jsonMode ? { response_format: { type: 'json_object' } } : null)),
      });
    } catch (e) {
      // fetch 直接抛错 = 请求根本没到服务商，别把 "Failed to fetch" 原样丢给用户
      throw new Error(
        `连不上 ${cfg.baseUrl}。两种可能：① 网络不通；② 该服务商未开放浏览器跨域调用（CORS）。` +
        `地址确认无误后若仍失败，属于情况 ②，需改用服务端代理或本地 Ollama。`
      );
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch (e) {}
      // 标记出「是结构化输出参数不被支持」，好让调用方退化成纯 prompt 指令再试一次，
      // 而不是直接判死刑 —— 不少国产小模型和本地 Ollama 都不支持 response_format，
      // 但它们照着「只输出 JSON」的指令照样能吐出合法 JSON。
      if (jsonMode && res.status === 400 && /json|response_format|结构化/i.test(detail || '')) {
        const err = new Error(humanizeHttpError(res.status, detail, cfg, jsonMode));
        err.code = 'JSON_MODE_UNSUPPORTED';
        throw err;
      }
      throw new Error(humanizeHttpError(res.status, detail, cfg, jsonMode));
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return text;
  }

  /**
   * 把服务端返回的 HTTP 状态码翻译成「看得懂、知道下一步做什么」的中文。
   * 直接透传英文原文（如 Insufficient Balance）会让用户不知道是 Key 错还是没钱。
   */
  function humanizeHttpError(status, detail, cfg, jsonMode) {
    // 400 的成因有好几种，只说「模型名填错了」会把人带沟里：
    // 结构化输出被拒时，用户照着提示核对一百遍模型名也没用。
    if (status === 400 && /json|response_format|结构化/i.test(detail || '')) {
      return 'HTTP 400 · 该模型不接受「结构化输出」参数（response_format）。' +
        '评分功能依赖它，请换一个支持 JSON 输出的模型（如 deepseek-chat、glm-4-flash）。' +
        (detail ? `（服务端原话：${detail}）` : '');
    }
    const HINTS = {
      400: '请求被拒绝，多半是「模型 Model」填错了，请到服务商控制台核对当前可用的模型 ID。' +
        (jsonMode ? '若模型名确认无误，则是它不支持结构化输出，换一个模型试试。' : ''),
      401: 'API Key 无效或已过期，请重新复制粘贴（注意别把首尾空格带进来）。',
      402: '账户余额不足。请到服务商控制台充值，或改用永久免费的模型（智谱 GLM-4.7-Flash、硅基流动 9B 以下模型）。',
      403: '这个 Key 没有调用该模型的权限，可能需要在控制台单独开通。',
      404: `接口地址或模型名不存在，请检查 Base URL（当前填的是 ${cfg.baseUrl}）。`,
      422: '参数不被支持，常见原因是该模型不接受 JSON 结构化输出。',
      429: '请求太频繁，或免费额度已用尽，稍等一会儿再试。',
      500: '服务商服务器出错，与你的配置无关，稍后重试即可。',
      502: '服务商网关错误，稍后重试即可。',
      503: '服务商暂时不可用，稍后重试即可。',
    };
    const hint = HINTS[status] || '未能识别的错误。';
    const tail = detail ? `（服务端原话：${detail}）` : '';
    return `HTTP ${status} · ${hint}${tail}`;
  }

  /**
   * 结构化调用：优先用 response_format；服务商不支持时自动退化成「靠 prompt 指令」再试。
   * 试出来一次就记住，同一个会话里不再反复撞同一堵墙。
   */
  let jsonModeSupported = true;
  async function chatJson(messages, cfgOverride) {
    const cfg = Object.assign(getConfig(), cfgOverride || {});
    if (!cfg.apiKey) throw new Error('未配置 API Key');
    if (jsonModeSupported) {
      try {
        return await callChat(cfg, messages, { json: true });
      } catch (e) {
        if (!e || e.code !== 'JSON_MODE_UNSUPPORTED') throw e;
        jsonModeSupported = false;
      }
    }
    return callChat(cfg, messages);
  }

  function parseJson(text) {
    // 容错：剥离可能存在的 ```json 围栏
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error('模型未返回 JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  /** 把模型返回的一个维度对象规整成统一结构 */
  function normalizeDim(dim, m, text) {
    const max = Number(dim.max) || 0;
    const score = U.clamp(Number(m ? m.score : 0) || 0, 0, max);
    const evidence = ((m && m.evidence) || []).slice(0, 4)
      .map((t) => ({ label: String(t).slice(0, 60), snippets: [] }));
    const missing = ((m && m.missing) || []).slice(0, 4)
      .map((t) => ({ label: String(t).slice(0, 60) }));

    /* 证据核验：本地引擎没了，但本地**查证**还在。
     * 模型自称引用了原文，那就回查一遍——编造的证据会让教师误信评分依据，
     * 这是自动评分最不能犯的错。核验结果挂在维度上，报告里如实展示。 */
    const verify = AG.analyzer && AG.analyzer.verifyEvidence
      ? AG.analyzer.verifyEvidence(text || '', evidence)
      : null;

    return {
      id: dim.id,
      name: dim.name,
      desc: dim.desc,
      advice: dim.advice,
      max,
      score: U.round(score, 1),
      ratio: U.round(score / (max || 1), 3),
      evidence,
      missing,
      penalties: [],
      comment: (m && m.comment) || '',
      evidenceCheck: verify,
    };
  }

  /** 单次评分的收尾：算总分、评级、组装结果对象 */
  function assemble(doc, rubric, parsed, cfg, raw) {
    const byId = {};
    (parsed.dims || []).forEach((d) => { byId[d.id] = d; });

    const dims = rubric.map((dim) => normalizeDim(dim, byId[dim.id], doc.text));

    const total = U.clamp(U.round(dims.reduce((s, d) => s + d.score, 0), 1), 0, 100);
    const g = AG.rubric.gradeOf(total);

    const hallucinated = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.hallucinated) || []).length, 0);
    const checkedTotal = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.total) || 0), 0);

    let overall = parsed.overall || '';
    if (!overall) {
      // 本地引擎已删，兜底文案不能再"算一个分出来"，只能如实说模型没给
      overall = `综合得分 ${total} 分（${g.grade} 级 · ${g.label}）。模型未返回整体评语，可参考下方各维度评语。`;
    }
    if (hallucinated > 0) {
      overall += `　【注意】该报告有 ${hallucinated} 条证据未在原文中查到，评分依据请人工复核。`;
    }

    return {
      docName: doc.name,
      engine: 'llm',
      engineLabel: '大模型引擎 · ' + cfg.model,
      model: cfg.model,
      total,
      grade: g.grade,
      gradeLabel: g.label,
      gradeColor: g.color,
      dims,
      features: doc.features || AG.parser.extractFeatures(doc.text),
      overall,
      evidenceAudit: { total: checkedTotal, hallucinated },
      gradedAt: Date.now(),
      raw,
    };
  }

  /**
   * 用大模型评分。失败时直接抛出——不再回退本地引擎（本地引擎已移除）。
   */
  async function grade(doc, rubric, cfgOverride) {
    const cfg = Object.assign(getConfig(), cfgOverride || {});
    if (!cfg.apiKey) throw new Error('未配置 API Key');

    const { system, user } = buildPrompt(doc, rubric);
    let raw = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], cfgOverride);

    let parsed;
    try {
      parsed = parseJson(raw);
    } catch (e) {
      // 重试一次
      raw = await chatJson([
        { role: 'system', content: system },
        { role: 'user', content: user },
        { role: 'assistant', content: raw.slice(0, 500) },
        { role: 'user', content: '上一次输出不是合法 JSON，请重新只输出 JSON。' },
      ], cfgOverride);
      parsed = parseJson(raw);
    }

    return assemble(doc, rubric, parsed, cfg, raw);
  }

  /**
   * 对同一份文档采样 N 次，返回每次的总分序列与维度得分矩阵。
   *
   * 存在理由：需求①点名要解决「每次调用模型评分结果差异化」。
   * 本地引擎删掉后，Bootstrap 重采样（靠反复跑本地打分）随之失效，
   * 稳定性的度量必须换成**对模型本身采样**——同一份输入、同一套量表，
   * 让它评 N 遍，看分数散到什么程度。这才是教师真正关心的"这分稳不稳"。
   *
   * 采样时把 temperature 抬到 samplingTemp（默认 0.7）：
   * 用 0.2 采样只会测出"解码器很确定"，测不出模型判断的鲁棒性。
   *
   * @returns {Promise<{ok:boolean, totals:number[], runs:Array, dims:Object, note?:string}>}
   */
  async function sampleGrade(doc, rubric, opts) {
    opts = opts || {};
    const N = Math.max(2, Math.min(20, opts.iterations || 5));
    const cfg = Object.assign(getConfig(), { temperature: opts.temperature == null ? 0.7 : opts.temperature });
    if (!cfg.apiKey) return { ok: false, note: '未配置 API Key' };

    const { system, user } = buildPrompt(doc, rubric);
    const totals = [];
    const runs = [];
    const dimScores = {};

    for (let i = 0; i < N; i++) {
      let parsed;
      try {
        const raw = await chatJson([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { temperature: cfg.temperature });
        parsed = parseJson(raw);
      } catch (e) {
        // 采样中途失败不整体判死：已有样本够 2 条就出结论，否则如实报错
        if (totals.length < 2) return { ok: false, note: '采样失败：' + e.message };
        break;
      }
      const res = assemble(doc, rubric, parsed, cfg, '');
      totals.push(res.total);
      runs.push({ index: i, total: res.total, dims: res.dims.map((d) => ({ id: d.id, score: d.score })) });
      res.dims.forEach((d) => { (dimScores[d.id] = dimScores[d.id] || []).push(d.ratio); });
    }

    return { ok: true, totals, runs, dimScores, iterations: totals.length, model: cfg.model };
  }

  /**
   * 用「校验模型」再评一遍（双模型交叉验证的第二意见）。
   * 校验模型未配置时，退化为「同一模型不同温度采样」——
   * 虽不如跨模型族严谨，但至少能暴露分数是否脆弱。
   */
  async function gradeWithReviewer(doc, rubric, opts) {
    opts = opts || {};
    const cfg = getConfig();
    const rc = {
      baseUrl: cfg.reviewBaseUrl || cfg.baseUrl,
      apiKey: cfg.reviewApiKey || cfg.apiKey,
      model: cfg.reviewModel || cfg.model,
    };
    if (!rc.model || rc.model === cfg.model) {
      // 没配校验模型：用主模型 + 高温度再评一次，作为弱化的第二意见
      const s = await sampleGrade(doc, rubric, { iterations: 2, temperature: 0.9 });
      if (!s.ok) throw new Error(s.note || '无法生成第二意见');
      const last = s.runs[s.runs.length - 1];
      const dimsById = {};
      last.dims.forEach((d) => { dimsById[d.id] = d; });
      const dims = rubric.map((d) => ({
        id: d.id, name: d.name, max: Number(d.max) || 0,
        score: (dimsById[d.id] || {}).score || 0,
        ratio: ((dimsById[d.id] || {}).score || 0) / (Number(d.max) || 1),
        evidence: [], missing: [], penalties: [],
        comment: '',
      }));
      return {
        docName: doc.name,
        engine: 'llm-sampled',
        engineLabel: `主模型高温复评 · ${cfg.model}`,
        model: cfg.model,
        total: last.total,
        grade: AG.rubric.gradeOf(last.total).grade,
        gradeLabel: AG.rubric.gradeOf(last.total).label,
        gradeColor: AG.rubric.gradeOf(last.total).color,
        dims, features: doc.features, overall: '',
        gradedAt: Date.now(),
        sameModelNote: '未配置校验模型，第二意见由主模型高温重采样给出，仅作粗略参照',
      };
    }
    return grade(doc, rubric, rc);
  }

  /**
   * 通用对话：供量表生成、答疑等「非评分」场景复用同一套鉴权与错误处理。
   * 所有配置项沿用单据（llmConfig），可用 cfgOverride 临时覆盖（如调大 temperature 生成量表）。
   * 默认不要求结构化输出 —— 需要 JSON 的调用方显式传 { json: true }，
   * 且必须保证自己的 prompt 里出现 json 字样，否则会被服务商以 400 打回。
   */
  async function chat(messages, cfgOverride, opts) {
    const cfg = Object.assign(getConfig(), cfgOverride || {});
    if (!cfg.apiKey) throw new Error('未配置 API Key');
    return callChat(cfg, messages, opts);
  }

  /**
   * 连通性自检：刻意用最小参数集发请求（不带 response_format），
   * 否则「测的是参数兼容性」而不是「测的是连通性」——明明 Key 和地址都对，
   * 却被自己的结构化输出参数挡回来，用户只会以为是自己配错了。
   */
  async function testConnection(cfg) {
    const c = Object.assign(getConfig(), cfg || {});
    if (!c.apiKey) throw new Error('请先填写 API Key');
    const text = await callChat(c, [
      { role: 'system', content: '你是一个连通性测试助手。' },
      { role: 'user', content: '请只回复 OK。' },
    ]);
    return { ok: true, reply: String(text || '').trim().slice(0, 80) };
  }

  /** 校验模型是否可用（用于 UI 决定要不要显示"双模型交叉验证"） */
  function hasReviewer() {
    const c = getConfig();
    return !!(c.reviewModel && c.reviewApiKey);
  }

  AG.llm = {
    getConfig, saveConfig, chat, chatJson, grade, testConnection,
    buildPrompt, sampleGrade, gradeWithReviewer, hasReviewer,
    DEFAULT_CONFIG,
  };
})(window);
