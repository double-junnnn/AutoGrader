/* AutoGrader · 站内答疑引擎（Chat Engine）
 *
 * 定位：答疑助手，不是通用聊天机器人。它答的是「本站怎么用、这个分为什么这么低、
 * 查重怎么看」这类问题，并且优先用本地知识库答——因为这些问题的答案取决于
 * 用户当前的量表配置和评分结果，大模型看不到，反而会编。
 *
 * 三级路由：
 *   1. 本地知识库命中   → 本地答（带真实数据，无需联网、不花 token）
 *   2. 未命中 + 有 Key  → 大模型答（注入人格 + 当前评分上下文）
 *   3. 未命中 + 无 Key  → 如实说明匹配不到，并列出能答的话题
 *
 * 人格由 AG.voice 统一供给（与评语同源同味），切换档位时答疑语气跟着变。
 *
 * 上下文契约（由调用方组装，本模块只做防御性读取）：
 *   ctx = {
 *     docCount, doc: { name, total, grade, gradeLabel, dims:[{name,score,max,missing,advice}],
 *                      gate, similarity, words },
 *     rubric: [{ name, max, enabled }], llmReady, llmModel, tone, simTop:{a,b,value}, simCount
 *   }
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ================================================================
   * 一、人格润色：开场与收尾
   * 大多数槽位刻意留空——每一句都端着架子会很累，也让人不想追问第二次。
   * ================================================================ */
  const FLAVOR = {
    strict: { open: [''], close: [''] },
    kid: {
      open: ['', '', '', '恕我直言：', '容我说一句——', '哦？'],
      close: ['照做便是。', '以上。', '（不用谢。）', ''],
    },
    savage: {
      open: ['', '', '听着：', '好问题，可惜答案有点伤人。'],
      close: ['', '照做。', '去吧。'],
    },
  };
  function flavor(tone, seed) {
    const F = FLAVOR[tone] || FLAVOR.strict;
    const pick = AG.voice && AG.voice.pick ? AG.voice.pick : (a, s) => a[0];
    return {
      open: pick(F.open, seed + '|open'),
      close: pick(F.close, seed + '|close'),
    };
  }
  function dress(text, tone, seed) {
    const f = flavor(tone, seed);
    return (f.open ? f.open : '') + text + (f.close ? ' ' + f.close : '');
  }

  /* ================================================================
   * 二、小工具：把上下文整理成人话
   * ================================================================ */
  function dimsByLoss(doc) {
    if (!doc || !doc.dims) return [];
    return doc.dims
      .filter((d) => d.enabled !== false)
      .map((d) => Object.assign({}, d, { loss: U.round((d.max || 0) - (d.score || 0), 1) }))
      .filter((d) => d.loss > 0)
      .sort((a, b) => b.loss - a.loss);
  }
  function missList(d, n) {
    return (d.missing || []).slice(0, n || 2).map((m) => '「' + (m.label || '') + '」').join('、');
  }
  function pct(v) { return Math.round((v || 0) * 100) + '%'; }

  /* ================================================================
   * 三、本地知识库
   * keys 越长的词信息量越大，命中时给的分数也越高（"智能量表" 比 "分" 有用得多）。
   * ================================================================ */
  const KB = [
    {
      id: 'whyScore',
      keys: ['为什么', '这么低', '只有', '才这么', '低分', '分数低', '扣分', '怎么算', '凭什么', '分是怎么', '怎么来的', '为何'],
      answer(ctx) {
        const d = ctx.doc;
        if (!d) return '还没有已评分的报告，这个问题我暂时答不了。先到「评分工作台」选一份报告，点「开始评分」，我就能把每一分的来龙去脉摊给你看。';
        const lost = dimsByLoss(d);
        const head = `${d.total} 分（${d.grade} 级 · ${d.gradeLabel}）。扣分不是凭感觉扣的，明细如下：\n`;
        if (!lost.length) return head + '各维度都拿满了，没有可扣的地方——这让我很没有成就感。';
        const lines = lost.slice(0, 3).map((x) => `· ${x.name}　${x.score} / ${x.max}　还差 ${x.loss} 分${missList(x) ? '，缺' + missList(x) : ''}`);
        const back = U.round(lost.slice(0, 3).reduce((s, x) => s + x.loss, 0), 1);
        const tail = `\n这三块补齐，理论上能拿回 ${back} 分。先补「${lost[0].name}」——它是单次扣分最重的一块。`;
        return head + lines.join('\n') + tail;
      },
    },
    {
      id: 'improve',
      keys: ['提高', '提升', '改进', '怎么改', '提分', '补救', '重写', '怎么拿高', '如何改', '怎么补救', '涨分'],
      answer(ctx) {
        const d = ctx.doc;
        if (!d) return '先评一份报告，我才能告诉你该改哪儿——空口说「要写详细点」等于没说。';
        const lost = dimsByLoss(d);
        if (!lost.length) return '各维度都拿满了，没什么要改的。这句话我说得相当不甘心。';
        const top = lost[0];
        const out = [`要提分，先动「${top.name}」——它还差 ${top.loss} 分，是全篇最容易拿回来的一块。`];
        if (missList(top, 3)) out.push('具体缺的是：' + missList(top, 3) + '。');
        if (top.advice) out.push('量表给的建议是：' + top.advice);
        const second = lost[1];
        if (second) out.push(`\n第二优先是「${second.name}」（还差 ${second.loss} 分）${missList(second) ? '，缺' + missList(second) : ''}。`);
        out.push('\n改完回到工作台点「重新评分」，分变了会立刻反映出来。');
        return out.join('');
      },
    },
    {
      id: 'gate',
      keys: ['0分', '零分', '离题', '不是报告', '误判', '申诉', '门禁', '判错', '文体', '小说', '为什么是零'],
      answer(ctx) {
        const d = ctx.doc;
        const why = '本地引擎看不懂语义，但文体是结构性的，统计抓得住。判分离题走的是「文体门禁」：\n' +
          '· 报告性证据：章节或编号标题、报告语域词（目的/原理/步骤/数据/误差…）、数据密度、图表编号、参考文献\n' +
          '· 叙述性证据：对话引号密度、「第 N 章」章节体、叙事性用词\n' +
          '报告性 ≤1.5 且叙述性 ≥2.5，或报告性 ≤1 分，判 0。\n';
        if (d && d.gate && d.gate.reasons && d.gate.reasons.length) {
          return `这份报告被判离题，依据是：\n${d.gate.reasons.map((r) => '· ' + r).join('\n')}\n\n${why}` +
            '觉得判错了：结果页有「我判错了，按正常评分重算」，点过之后这份作业就不再校验。';
        }
        return why + '被判 0 分的报告，结果页会列出逐条依据供你复核，并给一个「我判错了」的按钮——判得对不由引擎说了算。';
      },
    },
    {
      id: 'sim',
      keys: ['查重', '相似度', '抄袭', '雷同', '重复', '抄的', '45%', '百分之', '撞车'],
      answer(ctx) {
        const head = '相似度用的是字符 5-gram Jaccard：先归一化（去空白、去标点、去代码块），再比对 n-gram 集合的交并比。认得出换词改序式的改写。\n' +
          '判定区间：\n· 低于 45%　正常\n· 45% 以上　批量表里标红，需人工复核\n· 70% 以上　高度可疑，建议单独约谈\n';
        if (ctx.simTop) {
          return head + `\n当前这批里最相似的一对是《${ctx.simTop.a}》与《${ctx.simTop.b}》，相似度 ${pct(ctx.simTop.value)}。\n` +
            '提醒一句：它认不出「两人照着同一份模板写」——那种情况要看数据是否雷同，别只看百分比。';
        }
        return head + '它认不出「两人照着同一份模板写」——那种要看数据是否雷同，不能只看百分比。';
      },
    },
    {
      id: 'rubric',
      keys: ['量表', '分值', '权重', '比重', '评分标准', '改分', '调整分', '多少分'],
      answer(ctx) {
        const r = ctx.rubric || [];
        const on = r.filter((d) => d.enabled !== false);
        const sum = on.reduce((s, d) => s + (d.max || 0), 0);
        const head = '量表在「量表与模型」页，可改名称、分值、启用状态。两条要注意：\n' +
          '· 手动改动分值会自动锁定该维度，之后的自动适配都不许动它\n' +
          '· 合计不等于 100 也没关系，评分时会折算成百分制\n';
        if (on.length) {
          return head + `\n当前量表（${on.length} 项，合计 ${sum} 分）：\n` +
            on.map((d) => `· ${d.name}　${d.max} 分`).join('\n');
        }
        return head;
      },
    },
    {
      id: 'lab',
      keys: ['智能量表', '自动适配', '提示词', '一句话', 'rubric lab', '模板', '自动调', '按作业', '学科'],
      answer() {
        return '「量表与模型」页的「智能量表」有两种用法：\n' +
          '1. 一句话描述评分偏好，比如「数据处理最重要，格式可以弱化」——它会挑一套学科模板当基底再调分值\n' +
          '2. 「按已上传作业适配」——上传满 4 份后自动分析这批作业，出一张建议卡说明为什么这么调\n' +
          '两条路都只出建议，点「采纳」才写进量表；手动改过的分值永远优先。\n\n' +
          '一个诚实的边界：自动适配只能在现有维度之间重新分配权重，不会凭空造维度。' +
          '所以换学科（比如从编程切到化学）要先在下拉框选对模板，否则它只能在编程维度里腾挪。';
      },
    },
    {
      id: 'import',
      keys: ['导入', '上传', '怎么加', '添加报告', '格式', '支持什么', 'docx', 'pdf', '批量录', '拖'],
      answer() {
        return '「评分工作台」左侧：把文件拖进虚线框，或者点它选择文件。\n' +
          '· 支持 TXT / MD / DOCX / PDF，可以一次选多份批量录入\n' +
          '· 也可以点「粘贴文本」直接贴内容，或点「加载示例」先看效果\n' +
          '· DOCX 与 PDF 在浏览器本地解析，不会上传到任何服务器\n\n' +
          '解析不出来通常是扫描版 PDF（本质是图片）——那种需要 OCR，本站做不到。';
      },
    },
    {
      id: 'export',
      keys: ['导出', '下载', '保存', 'csv', 'markdown', '成绩表', '打印'],
      answer() {
        return '导出入口有三处：\n' +
          '· 单份：结果页的「导出 PDF」「导出 Markdown」\n' +
          '· 全部：「批量与查重」页的「导出评阅报告 (PDF)」「导出成绩表 (CSV)」「导出评阅报告 (Markdown)」\n' +
          '· 量表：「智能分析」页的「导出量表 JSON」\n\n' +
          'PDF 是本地 Canvas 手绘的，不依赖任何在线服务；导出 PDF 会跟随当前主题配色，' +
          '也可以固定成浅色打印版省墨。\n' +
          '若点了导出没反应，多半是浏览器把 blob 链接拦了——页面上有应对说明。';
      },
    },
    {
      id: 'llm',
      keys: ['大模型', 'api', 'key', '余额', '402', '401', '配置模型', '模型名', 'deepseek', '通义', 'ollama', '联网吗'],
      answer(ctx) {
        const head = '在「量表与模型」页填 Base URL / API Key / 模型名，兼容 OpenAI 风格的 /chat/completions' +
          '（OpenAI、DeepSeek、通义、Moonshot、本地 Ollama 都能用）。\n' +
          '常见报错：\n· 401　Key 无效或过期\n· 402　账户余额不足，可换用免费额度模型\n· 404　接口地址或模型名不对\n· 连不上　多半是该服务商没开放浏览器跨域调用（CORS）\n\n';
        return head + (ctx.llmReady
          ? `当前已配置${ctx.llmModel ? '（模型 ' + ctx.llmModel + '）' : ''}，切到「大模型引擎」即可生效。`
          : '当前没配 Key——不影响使用，本地引擎完全离线，只是读不懂语义。');
      },
    },
    {
      id: 'principle',
      keys: ['原理', '依据', '怎么评', '算法', '信号', '证据', '可信', '准确', '准不准', '怎么打分', '评分机制'],
      answer() {
        return '本地引擎是四步，每一步都可解释：\n' +
          '1. 信号覆盖度：每个维度配一组要点，按权重算覆盖率\n' +
          '2. 证据强度：命中 1 次算 85%，2 次 92.5%，3 次以上 100%\n' +
          '3. 结构加成与动态上限：篇幅、数据量、代码量决定这一项最高能拿到多少\n' +
          '4. 文体门禁：不是报告的文档直接判 0\n\n' +
          '覆盖率到达成率是凹映射（开方）：覆盖 60% 的要点约等于 77% 达成度。' +
          '核心要点写到了就该拿大部分分，这符合教学评分的常识。\n\n' +
          '每一条评语都能点开看命中了哪些证据、缺了哪些要点——分数不是黑箱。';
      },
    },
    {
      id: 'offline',
      keys: ['离线', '隐私', '安全', '上传服务器', '数据在哪', '会不会', '本地吗', '断网'],
      answer(ctx) {
        return '纯前端、零依赖，双击 index.html 就能跑。\n' +
          '· 文件解析、评分、查重、导出全部在浏览器里完成，报告正文不会上传到任何服务器\n' +
          '· 唯一会外发数据的地方是「大模型引擎」——只有你配了 Key 且切到它时，' +
          '正文才会发给你自己填的那个服务商' +
          (ctx.llmReady ? '（当前已配置，注意切换引擎会触发外发）' : '（当前没配 Key，所以现在是完全不外发的）') + '\n' +
          '· 数据存在浏览器 localStorage，换浏览器或清缓存会丢，重要结果记得及时导出';
      },
    },
    {
      id: 'batch',
      keys: ['批量', '统计', '分布', '信度', '一致性', '交叉验证', '融合', '多引擎', '平均分'],
      answer() {
        return '两个页面分管这些：\n' +
          '· 「批量与查重」：成绩总表、分数分布、两两相似度矩阵\n' +
          '· 「智能分析」：量表自动诱导（挑优秀组与对照组反推量表）、Bootstrap 信度检验、多引擎交叉验证与分数融合\n\n' +
          '多引擎分歧会直接摆出来让你裁决，不会偷偷取个平均值糊弄过去。';
      },
    },
    {
      id: 'theme',
      keys: ['主题', '皮肤', '人格', '语气', '风格', '毒舌', '配色', '换风格'],
      answer() {
        return '「量表与模型」页可以切界面主题和评语人格。两条硬边界：\n' +
          '· 主题只改观感，不动分数\n' +
          '· 人格只改措辞，也不动分数\n\n' +
          '换人格不会让同一份报告的得分发生变化——分数和措辞是两条独立的管道。' +
          '当前这一档人格同时作用于评分评语和这里的答疑，所以你换档时我会跟着变。';
      },
    },
    {
      id: 'induce',
      keys: ['诱导', '范文', '优秀组', '对照组', '反推', '挑样本'],
      answer() {
        return '「智能分析」页的量表自动诱导：挑 2~3 份最好的当优秀组、2~3 份最差的当对照组，' +
          '引擎反推「哪些要点能把两组区分开」，按区分度 × √支持度排序生成量表。\n\n' +
          '不想手挑范文的话，用「量表与模型」页的「按已上传作业适配」——它自己排高低组，' +
          '还能处理混批（一批里夹杂不同题目的作业）。';
      },
    },
  ];

  const TOPICS = '为什么这份分数低 / 怎么提分 / 查重怎么看 / 量表怎么调 / 智能量表怎么用 / 导入与导出 / 大模型配置 / 评分原理 / 离线与隐私';

  /* ================================================================
   * 四、匹配
   * ================================================================ */
  function match(q) {
    // 归一化后再比：用户写「0 分」还是「0分」、「API Key」还是「apikey」不该影响判断
    const s = U.normalize(q);
    let best = null;
    KB.forEach((e) => {
      let score = 0;
      (e.keys || []).forEach((k) => { if (s.indexOf(k) >= 0) score += 2 * k.length; });
      (OWN[e.id] || []).forEach((k) => { if (s.indexOf(k) >= 0) score += OWN_WEIGHT; });
      if (!best || score > best.score) best = { entry: e, score };
    });
    return best;
  }

  /* 专属强特征词：命中任一个即近乎锁定该条目（权重远高于普通词）。
   *
   * 存在的理由：光靠「关键词越长分越高」会打错架。
   * 「为什么是 0 分」里 whyScore 的「为什么」比 gate 的「0分」长，按长度加权会赢，
   * 但语义上「0 分」才指明问的是什么。同理「相似度是怎么算的」——
   * 「怎么算」属于 whyScore，「相似度」属于 sim，后者才是问的主体。
   * 凡是「提到它就基本确定问的是这件事」的词，进这张表。
   *
   * 注意 pdf 不在此表：它既可能是「导入 pdf」也可能是「导出 pdf」，
   * 放进来会抢走 export 的单子，只能留在普通关键词里靠组合取胜。
   */
  const OWN = {
    gate: ['0分', '零分', '离题', '误判', '不是报告', '申诉', '判错', '文体'],
    sim: ['查重', '相似度', '抄袭', '雷同', '重复率'],
    lab: ['智能量表', '一句话', '自动适配', '按作业', 'rubric lab'],
    principle: ['评分原理', '评分机制', '怎么打分'],
    offline: ['离线', '隐私'],
    import: ['导入', 'docx'],
    export: ['导出', 'csv', 'markdown', '成绩表'],
    llm: ['api', 'key', '大模型', '402'],
    theme: ['主题', '皮肤', '人格'],
    induce: ['诱导', '范文', '优秀组', '对照组'],
    whyScore: ['扣分', '凭什么', '分是怎么'],
    improve: ['提分', '怎么改', '提高', '补救'],
    rubric: ['量表', '分值', '权重', '比重'],
    batch: ['批量', '信度', '交叉验证', '融合'],
  };
  const OWN_WEIGHT = 20;

  const HIT_MIN = 4;   // 低于这个分说明问的不是本站的事，别硬答

  function fallbackAnswer(ctx) {
    const base = '这个问题没能从站内知识库里匹配到，我不打算编一个像模像样的答案糊弄你。\n\n' +
      '我能答的：' + TOPICS + '\n';
    return base + (ctx && ctx.llmReady
      ? '\n你已配置 API Key，但这次调用没成功，所以先给本地兜底。'
      : '\n想要更自由的问答，去「量表与模型」页配一个 API Key——配好之后，匹配不到的问题会转给大模型，并带上当前报告的评分上下文。');
  }

  /* ================================================================
   * 五、大模型增强
   * ================================================================ */
  function contextBrief(ctx) {
    const out = [];
    out.push(`【站内状态】已录入 ${ctx.docCount || 0} 份报告。`);
    if (ctx.rubric && ctx.rubric.length) {
      const on = ctx.rubric.filter((d) => d.enabled !== false);
      out.push(`【当前量表（合计 ${on.reduce((s, d) => s + (d.max || 0), 0)} 分）】` +
        on.map((d) => `${d.name} ${d.max}`).join('；'));
    }
    const d = ctx.doc;
    if (d) {
      out.push(`【当前报告】${d.name}｜总分 ${d.total}（${d.grade} 级 ${d.gradeLabel}）｜字数 ${d.words || '—'}`);
      if (d.dims && d.dims.length) {
        out.push('【各维度】' + d.dims.map((x) => `${x.name} ${x.score}/${x.max}`).join('；'));
        const lost = dimsByLoss(d).slice(0, 3);
        if (lost.length) {
          out.push('【主要失分点】' + lost.map((x) => `${x.name} 缺 ${missList(x, 3) || '实质内容'}`).join('；'));
        }
      }
      if (d.gate && d.gate.verdict) out.push('【文体判定】' + d.gate.verdict);
      if (d.similarity != null) out.push(`【最高相似度】${pct(d.similarity)}`);
    }
    return out.join('\n');
  }

  async function askLLM(q, ctx) {
    const tone = ctx.tone || (AG.voice ? AG.voice.get() : 'strict');
    const hint = AG.voice ? AG.voice.chatHint(tone) : '';
    const system = '你是 AutoGrader（一个实验报告智能评阅工具）内置的答疑助手，' +
      '只回答与该软件使用、评分结果解读、量表配置相关的问题。\n\n' +
      (hint ? hint + '\n\n' : '') +
      '下面是当前站内的真实状态，回答时优先依据它；它里面没有的功能就直说「本站做不到」。\n\n' +
      contextBrief(ctx);

    const text = await AG.llm.chat(
      [{ role: 'system', content: system }, { role: 'user', content: q }],
      { temperature: 0.5 }
    );
    return String(text || '').trim() || '（大模型返回了空内容，我也不知道该说什么。）';
  }

  /* ================================================================
   * 六、对外主入口
   * ================================================================ */
  async function ask(question, ctx) {
    ctx = ctx || {};
    const q = String(question || '').trim();
    if (!q) return { text: '问点什么吧，我听着呢。', source: 'empty' };

    const m = match(q);
    if (m && m.score >= HIT_MIN) {
      const tone = ctx.tone || (AG.voice ? AG.voice.get() : 'strict');
      let text = m.entry.answer(ctx);
      // 人格润色只在「有话可说」时附加，纯清单式回答不硬塞开场白
      if (tone !== 'strict' && m.entry.id !== 'rubric') text = dress(text, tone, q);
      return { text, source: 'local', entry: m.entry.id, score: m.score };
    }

    if (ctx.llmReady && AG.llm) {
      try {
        const text = await askLLM(q, ctx);
        return { text, source: 'llm' };
      } catch (e) {
        return {
          text: fallbackAnswer(ctx) + '\n\n（大模型调用失败：' + (e && e.message ? e.message : '未知错误') + '）',
          source: 'fallback', error: e && e.message,
        };
      }
    }
    return { text: fallbackAnswer(ctx), source: 'fallback' };
  }

  /** 快捷问题：按当前状态给，没评分时不问「为什么这么低分」 */
  function quickQuestions(ctx) {
    ctx = ctx || {};
    const list = [];
    if (ctx.doc) {
      // 高分报告不该被问成「为什么只有 88 分」
      const t = ctx.doc.total;
      list.push((t >= 75 ? '为什么这份是 ' : '为什么这份只有 ') + t + ' 分？');
      list.push('怎么提分？');
    }
    // 用这批里真实存在的最高相似度，别拿一个写死的 45% 去问——
    // 教师看到「查重 45% 要不要紧」，而自己这批最高是 67%，会觉得这助手在说胡话。
    if (ctx.simTop) list.push(`查重 ${pct(ctx.simTop.value)} 要不要紧？`);
    else if (ctx.simCount) list.push('查重怎么看？');
    if (!ctx.llmReady) list.push('没配 API Key 能用吗？');
    list.push('智能量表怎么用？');
    list.push('评分原理是什么？');
    return list.slice(0, 4);
  }

  function sourceLabel(source) {
    return ({
      local: '本地知识库 · 无需联网',
      llm: '大模型回答 · 已带当前评分上下文',
      fallback: '未匹配 · 本地兜底',
      empty: '',
    })[source] || '';
  }

  AG.chat = { ask, match, quickQuestions, sourceLabel, contextBrief, KB, TOPICS };
})(window);
