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
     * 于是可以放心地把 penalties（扣分项）也带上——旧版为了兼容正则引擎没敢动。
     *
     * 【2026-09 二轮变更】每维度追加**评分锚点**（档位 + 区间 + 行为描述）。
     * 旧版只说「给 0 到 max 之间的分数」，模型只能凭手感给分，同一份报告
     * 连评几次极差可达十几分。锚点把"分数"翻译成"可观察的行为"，
     * 强制模型先选档、再在档内取值，分数因此变得可复现、可解释。 */
    const A = AG.anchors;
    const dims = rubric.map((d) => {
      const item = {
        id: d.id,
        name: d.name,
        max: Number(d.max),
        desc: d.desc,
        points: (d.signals || []).map((s) => s.label),
        deductions: (d.penalties || []).map((p) => p.label),
      };
      if (A && d.max) {
        const bands = A.anchorsFor(d);
        if (bands.length) {
          item.anchors = bands.map((b) => ({
            level: b.idx,
            range: b.lo + '-' + b.hi,
            behavior: b.text,
          }));
        }
      }
      return item;
    });

    const content = (doc.text || '').slice(0, getConfig().maxChars);
    const truncated = (doc.text || '').length > getConfig().maxChars;

    // 语气人格由 AG.voice 注入：换「学院派 / 傲娇小天才 / 火力全开」即换整套评语风格，
    // 且人格提示里已写死「对事不对人 + 毒舌必带解药」两条硬约束。
    const toneHint = AG.voice ? AG.voice.systemHint() : '';
    const hasAnchors = dims.some((d) => d.anchors && d.anchors.length);

    const system = `你是一名严谨的高校计算机专业实验报告评阅助教。
你将收到一份实验报告和一份评分量表（JSON）。请严格依据量表逐项评分。

要求：
1. 只依据报告实际内容评分，不得臆测未写出的内容。
${hasAnchors ? `2. 【评分锚点】每个维度都给出了若干档位，每档含 level（档位号）、range（分数区间）、behavior（该档的行为描述）。
   你必须**先判断报告的表现属于哪一档，再在该档位的分数区间内取值**，不得跨档给分。
   判定顺序：从最高档开始向下比对，第一个"报告确实做到了"的档位即为所选档。
3. level 填你选中的档位号（数字，最高档为 1）。
4. levelReason 用一句话说明为什么选这一档（不超过 30 字，须引用报告中的具体表现）。` : `2. 每个维度给出 0 到 max 之间的分数（可保留 1 位小数）。`}
${hasAnchors ? '5' : '3'}. points 是该维度的得分要点，deductions 是该维度的扣分情形；命中扣分情形时须在 comment 中说明。
${hasAnchors ? '6' : '4'}. 评分须可复现：同一份报告重复评阅应给出接近的分数，不要因表述顺序变化而漂移。
${hasAnchors ? '7' : '5'}. evidence 必须引用报告中的**逐字原文片段**（每条不超过 40 字），
   不得改写、不得杜撰——系统会逐条回查原文，编造的证据将直接作废。没有证据时为空数组。
${hasAnchors ? '8' : '6'}. citations 是本维度**扣分/给分所依据的报告原句**，格式为
   [{"quote": "报告里的逐字原句", "where": "所在章节名"}]。要求：
   · 每条 quote 必须是报告原文的**连续逐字片段**（15–60 字），不得改写、不得拼接、不得杜撰；
   · 至少给出 1 条；确实无从引用（如整章缺失）时给空数组，并在此处说明原因；
   · 系统会逐条回查原文，查不到的引用会被标红，教师据此可当场判断这次扣分是否站得住。
${hasAnchors ? '9' : '7'}. missing 列出该维度明显缺失的要点。
${hasAnchors ? '10' : '8'}. comment 用一句话给出具体、可执行的改进建议，禁止空话。
${hasAnchors ? '11' : '9'}. 整体评语 overall 控制在 120 字以内，先肯定再指出最关键的改进点。
${hasAnchors ? '12' : '10'}. 只输出 JSON，不要输出任何解释或 Markdown 代码块标记。

${toneHint ? '【语气设定】\n' + toneHint + '\n' : ''}
输出格式：
{
  "dims": [
    { "id": "维度id"${hasAnchors ? ', "level": 2, "score": 8.5, "levelReason": "…"' : ', "score": 12.5'}, "evidence": ["…"], "citations": [{"quote": "…", "where": "…"}], "missing": ["…"], "comment": "…" }
  ],
  "overall": "…"
}`;

    const user = `【评分量表】\n${JSON.stringify(dims, null, 2)}\n\n` +
      `【实验报告：${doc.name}】\n${content}${truncated ? '\n\n（报告过长，以上为前 ' + getConfig().maxChars + ' 字）' : ''}`;

    return { system, user, hasAnchors };
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

  /**
   * 解析模型返回的 JSON。
   * 现实里模型的输出经常不是干净 JSON：带围栏、末尾多一句解释、被 max_tokens 截断、
   * 键值之间留尾逗号。原先只做「截第一个 { 到最后一个 }」再 JSON.parse，
   * 遇到截断或尾逗号会直接抛错 —— 在大模型评分里这等于整份报告白评。
   * 因此这里层层降级，尽量把可用内容捞回来；实在捞不回才抛错（由上层如实报给用户）。
   */
  function parseJson(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) throw new Error('模型未返回任何内容');

    const start = raw.indexOf('{');
    if (start < 0) throw new Error('模型未返回 JSON');

    // 候选串：完整切片 → 去尾逗号 → 截断补括号（模型被 max_tokens 切断时最常见）
    const tail = raw.slice(start);
    const lastBrace = tail.lastIndexOf('}');
    const cands = [];
    if (lastBrace >= 0) cands.push(tail.slice(0, lastBrace + 1));
    cands.push(tail);
    const base = cands.slice();
    base.forEach((c) => {
      cands.push(c.replace(/```(?:json)?/gi, '').trim());
      cands.push(c.replace(/,\s*([}\]])/g, '$1'));           // 去尾逗号
      cands.push(c.replace(/```(?:json)?/gi, '').replace(/,\s*([}\]])/g, '$1'));
      // 截断修复：补上缺失的收尾括号
      cands.push(c.replace(/```(?:json)?/gi, '').replace(/,\s*([}\]])/g, '$1') + '}');
      cands.push(c.replace(/```(?:json)?/gi, '').replace(/,\s*([}\]])/g, '$1') + ']}');
      cands.push(c.replace(/```(?:json)?/gi, '').replace(/,\s*([}\]])/g, '$1') + '}]}');
    });

    for (const c of cands) {
      if (!c || c.indexOf('{') < 0) continue;
      try {
        const obj = JSON.parse(c);
        if (obj && typeof obj === 'object') return obj;
      } catch (e) { /* 换下一个候选 */ }
    }
    throw new Error('模型返回的内容不是合法 JSON（可能被截断）。可减少报告长度或调高 max_tokens 后重试。');
  }

  /** 把模型返回的一个维度对象规整成统一结构 */
  function normalizeDim(dim, m, text) {
    const max = Number(dim.max) || 0;

    /* 模型漏给这个维度时的处理。
     *
     * 这是评分系统里最危险的失败模式：原写法 `Number(m ? m.score : 0) || 0`
     * 会把"模型根本没提这一项"静默变成"这一项得 0 分"，老师端看起来
     * 就是学生这项完全没做——一个纯粹的模型输出缺陷，被伪装成了学生的失分。
     *
     * 现在分开处理：分数仍然记 0（保证总分口径完整），但打上 missingOutput 标记，
     * 由上层汇总后在结果页显著提示"该维度模型未返回，分数不可信，请人工评分"。
     * 不抛错是因为一份报告不该因为一个维度而整份丢弃，但要让人看得见。 */
    const missingOutput = !m || m.score == null || isNaN(Number(m.score));
    let score = missingOutput ? 0 : U.clamp(Number(m.score) || 0, 0, max);
    const evidence = ((m && m.evidence) || []).slice(0, 4)
      .map((t) => ({ label: String(t).slice(0, 60), snippets: [] }));
    const missing = ((m && m.missing) || []).slice(0, 4)
      .map((t) => ({ label: String(t).slice(0, 60) }));

    /* 原文引用（判定依据）：这是「评阅副驾驶」的核心承诺——老师必须能当场核对
     * "模型到底凭什么扣这几分"。所以每条引用都要回原文查，查不到就标出来。
     * 这里不做"悄悄丢掉查不到的引用"这种处理：那等于替模型掩盖编造行为。 */
    const src = String(text || '');
    const citations = ((m && m.citations) || []).slice(0, 5).map((c) => {
      const quote = String((c && c.quote) || c || '').trim().slice(0, 200);
      if (!quote) return null;
      // 逐字回查：命中即为可核对；未命中标记出来，由教师判断
      const verified = src.indexOf(quote) >= 0;
      return {
        quote,
        where: String((c && c.where) || '').slice(0, 40),
        note: (c && c.note ? String(c.note).slice(0, 60) : ''),
        verified,
      };
    }).filter(Boolean);

    /* 档位校正：模型自称的 level 可能与它给的 score 对不上（它偶尔会
     * "选 2 档却给 1 档的分"）。以 score 落点为真相，level 只作参考，
     * 但两者冲突时把分数**拉回它自选档位的区间内** —— 既然它已声明这是哪一档，
     * 档内取值才是它真实意图，越档给分多半是顺手写了个整数。 */
    const A = AG.anchors;
    let level = null, levelName = '', levelReason = '';
    let bandRange = null, crossBand = false;
    if (A && max > 0) {
      const bands = A.anchorsFor(dim);
      const declared = Number(m && m.level) || 0;
      const byScore = A.levelOf(score, max);
      const declaredHit = bands.find((b) => b.idx === declared) || null;
      if (declaredHit && byScore !== declared) {
        // 档位与分数冲突：以模型自选的档位为准，把分数拉回该档区间
        // （既然它已声明这是哪一档，档内取值才是真实意图，越档给分多半是顺手写了整数）
        const fixed = U.clamp(score, declaredHit.lo, declaredHit.hi);
        if (fixed !== score) { crossBand = true; score = fixed; }
      }
      const hit = declaredHit || bands.find((b) => b.idx === byScore) || null;
      if (hit) {
        level = hit.idx;
        levelName = hit.name;
        bandRange = [hit.lo, hit.hi];
      }
      levelReason = String((m && m.levelReason) || '').slice(0, 80);
    }

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
      level,
      levelName,
      levelReason,
      bandRange,
      crossBand,
      missingOutput,
      evidence,
      citations,
      missing,
      penalties: [],
      comment: (m && m.comment) || '',
      evidenceCheck: verify,
    };
  }

  /** 单次评分的收尾：算总分、算区间、评级、组装结果对象 */
  function assemble(doc, rubric, parsed, cfg, raw) {
    const byId = {};
    (parsed.dims || []).forEach((d) => { byId[d.id] = d; });

    const dims = rubric.map((dim) => normalizeDim(dim, byId[dim.id], doc.text));

    const total = U.clamp(U.round(dims.reduce((s, d) => s + d.score, 0), 1), 0, 100);

    /* 分数区间：各维度已选定档位，档位的下界之和 / 上界之和就是**理论**范围。
     *
     * 但直接把它当区间端点是错的：8 个维度各自贡献一个档位宽度，累加起来常有 20 分以上
     * （实测示例报告出现 50–72），这种宽度对老师毫无参考价值 —— 等于说"这报告可能很差也可能还行"。
     *
     * 因此这里做一次收窄：以模型实际取分 total 为中心，按 **各维度档内剩余空间** 取
     * 「还能往上抬多少 / 还能往下压多少」的较小者作为半径（取半，且不超过理论范围）。
     * 含义很明确：在模型已定档的前提下，这份报告最合理的浮动范围。
     * 老师看到的仍不是虚假的精确值，而是一个敢用的区间。 */
    const graded = dims.filter((d) => d.bandRange);
    const rawLo = graded.length
      ? Math.min(100, U.round(dims.reduce((s, d) => s + (d.bandRange ? d.bandRange[0] : d.score), 0), 1))
      : total;
    const rawHi = graded.length
      ? Math.min(100, U.round(dims.reduce((s, d) => s + (d.bandRange ? d.bandRange[1] : d.score), 0), 1))
      : total;
    // 自由度：向下最多压到各档下界之和，向上最多抬到各档上界之和
    const downRoom = Math.max(0, total - rawLo);
    const upRoom = Math.max(0, rawHi - total);
    // 半径取两侧较小者的一半，再夹在 2~4 分内。上限压到 4 分是有意的：
    // 实测半径 7 时区间宽达 14 分（51–65），等于同时承认「可能不及格也可能中上」，
    // 对老师没有决策价值。4 分半径给出 8 分左右的带宽，是「敢用」与「不假装精确」的平衡点。
    let radius = Math.max(downRoom, upRoom) / 2;
    radius = U.clamp(radius, 2, 4);
    radius = Math.min(radius, Math.max(downRoom, upRoom));   // 不越出理论范围
    const lo = U.clamp(U.round(total - Math.min(radius, downRoom), 1), 0, 100);
    const hi = U.clamp(U.round(total + Math.min(radius, upRoom), 1), 0, 100);
    const range = graded.length && hi > lo ? [lo, hi] : graded.length ? [lo, hi] : null;

    const g = AG.rubric.gradeOf(total);
    // 区间跨越等级边界时如实提示——这正是最该让老师亲自定分的场景
    const gradeAtLo = AG.rubric.gradeOf(lo);
    const gradeAtHi = AG.rubric.gradeOf(hi);
    const straddles = !!(range && gradeAtLo.grade !== gradeAtHi.grade);

    const hallucinated = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.hallucinated) || []).length, 0);
    const checkedTotal = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.total) || 0), 0);
    const crossBands = dims.filter((d) => d.crossBand);

    /* 引用核查汇总：教师最需要知道的三个数——总共引了多少条、多少条查得到、
     * 多少条查不到。查不到的必须显式计数，不能只展示"好看"的那部分。 */
    const citeTotal = dims.reduce((s, d) => s + ((d.citations || []).length), 0);
    const citeBad = dims.reduce(
      (s, d) => s + ((d.citations || []).filter((c) => !c.verified).length), 0);
    const citeMissingDims = dims.filter((d) => !(d.citations || []).length).map((d) => d.name);

    /* 模型漏答维度：必须显式计数并置顶提示。这些维度的 0 分不是学生的分，
     * 是模型的输出缺口——混在正常分数里会直接误导老师。 */
    const unanswered = dims.filter((d) => d.missingOutput).map((d) => d.name);

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
      range,
      straddles,
      gradeStraddle: straddles ? gradeAtLo.grade + '–' + gradeAtHi.grade : null,
      grade: g.grade,
      gradeLabel: g.label,
      gradeColor: g.color,
      dims,
      features: doc.features || AG.parser.extractFeatures(doc.text),
      overall,
      evidenceAudit: { total: checkedTotal, hallucinated },
      citationAudit: {
        total: citeTotal,
        verified: citeTotal - citeBad,
        unverified: citeBad,
        missingDims: citeMissingDims,
      },
      unanswered,
      anchorAudit: {
        graded: graded.length,
        total: dims.length,
        crossBands: crossBands.length,
        crossBandNames: crossBands.map((d) => d.name),
      },
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
    buildPrompt, sampleGrade, parseJson,
    DEFAULT_CONFIG,
  };
})(window);
