/* AutoGrader · 大模型评分引擎（LLM Engine）
 * 兼容 OpenAI 风格的 /chat/completions 接口（OpenAI、DeepSeek、通义、Moonshot、本地 Ollama 等）。
 * 通过 response_format: json_object 强制结构化输出；解析失败自动重试一次，仍失败则回退本地引擎。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const DEFAULT_CONFIG = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxChars: 12000,
  };

  function getConfig() {
    return Object.assign({}, DEFAULT_CONFIG, U.store.get('llmConfig', {}));
  }
  function saveConfig(cfg) {
    U.store.set('llmConfig', cfg);
    U.bus.emit('llm:config', cfg);
  }

  function buildPrompt(doc, rubric) {
    const dims = rubric.map((d) => ({
      id: d.id,
      name: d.name,
      max: Number(d.max),
      desc: d.desc,
      signals: (d.signals || []).map((s) => s.label),
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
3. evidence 必须引用报告中的真实片段（每条不超过 40 字），没有证据时为空数组。
4. missing 列出该维度明显缺失的要点。
5. comment 用一句话给出具体、可执行的改进建议，禁止空话。
6. 整体评语 overall 控制在 120 字以内，先肯定再指出最关键的改进点。
7. 只输出 JSON，不要输出任何解释或 Markdown 代码块标记。

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

  /**
   * 用大模型评分；失败时抛出错误，由调用方决定是否回退。
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

    const byId = {};
    (parsed.dims || []).forEach((d) => { byId[d.id] = d; });

    const dims = rubric.map((dim) => {
      const m = byId[dim.id];
      const max = Number(dim.max) || 0;
      const score = U.clamp(Number(m?.score) || 0, 0, max);
      return {
        id: dim.id,
        name: dim.name,
        desc: dim.desc,
        advice: dim.advice,
        max,
        score: U.round(score, 1),
        ratio: U.round(score / (max || 1), 3),
        raw: null,
        boost: 0,
        penalty: 0,
        evidence: (m?.evidence || []).slice(0, 4).map((t) => ({ label: String(t).slice(0, 60), snippets: [] })),
        missing: (m?.missing || []).slice(0, 4).map((t) => ({ label: String(t).slice(0, 60) })),
        penalties: [],
        comment: m?.comment || '',
      };
    });

    const total = U.clamp(U.round(dims.reduce((s, d) => s + d.score, 0), 1), 0, 100);
    const g = AG.rubric.gradeOf(total);

    return {
      docName: doc.name,
      engine: 'llm',
      engineLabel: '大模型引擎 · ' + cfg.model,
      total,
      qualityFactor: 1,
      grade: g.grade,
      gradeLabel: g.label,
      gradeColor: g.color,
      dims,
      features: doc.features || AG.parser.extractFeatures(doc.text),
      overall: parsed.overall || AG.analyzer.grade(doc, rubric).overall,
      gradedAt: Date.now(),
      raw,
    };
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

  AG.llm = {
    getConfig, saveConfig, chat, chatJson, grade, testConnection,
    buildPrompt, DEFAULT_CONFIG,
  };
})(window);
