/* AutoGrader · 开源模型服务商预设（Open-Source Model Providers）
 *
 * 需求计划待确认问题②「是否参考 / 采用开源项目方案」→ 结论：采用。
 *
 * 落地方式不是"引入某个开源评分项目的代码"，而是把**开源权重模型**接成一等公民：
 *   1. 统一走 OpenAI 兼容的 /chat/completions 协议 —— 它是事实标准，
 *      Ollama、vLLM、Xinference、SiliconFlow、智谱、Groq 全都支持，
 *      于是"换模型"只是换两个字符串，不需要为每个厂商写适配层。
 *   2. 预设里优先推荐权重公开、可本地部署、可离线运行的开源模型，
 *      教师既能用云端免费额度，也能把模型搬进机房内网，不被某家商业 API 绑死。
 *   3. 预设只描述接入信息（地址 / 推荐模型 / 是否免费 / 是否本地），不掺任何评分策略 ——
 *      换模型不该顺带换掉评分口径。
 *
 * 关于「开源」的判定口径：这里标 open:true 指的是**模型权重可获取**（可自行部署），
 * 不是指提供它的云服务商本身开源。托管在云上的开源模型依然计入，
 * 否则"开源方案"会退化成"必须自建机房"，那对大多数教师并不现实。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  /**
   * 服务商预设。
   *   baseUrl   OpenAI 兼容端点
   *   model     推荐模型（优先开源权重 + 有免费额度）
   *   open      该服务商主推模型的权重是否公开可获取
   *   free      是否提供永久免费额度（教学场景零成本跑通很关键）
   *   local     是否运行在本机 / 内网（无需外网）
   *   json      是否支持 response_format: json_object
   *             不支持的会被 llm.js 自动降级为「靠 prompt 指令」再试，不是硬门槛
   */
  const PRESETS = {
    siliconflow: {
      id: 'siliconflow', label: '硅基流动 SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      open: true, free: true, local: false, json: true,
      note: '开源模型托管平台，9B 以下模型永久免费，无需信用卡',
      models: [
        'Qwen/Qwen2.5-7B-Instruct',
        'Qwen/Qwen3-8B',
        'THUDM/glm-4-9b-chat',
        'deepseek-ai/DeepSeek-V3',
        'meta-llama/Meta-Llama-3.1-8B-Instruct',
      ],
    },
    ollama: {
      id: 'ollama', label: '本地 Ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      open: true, free: true, local: true, json: false,
      note: '完全离线，数据不出本机；需先跑 ollama serve 并设置 OLLAMA_ORIGINS=*',
      models: ['qwen2.5:7b', 'qwen3:8b', 'glm4:9b', 'llama3.1:8b', 'deepseek-r1:7b'],
    },
    vllm: {
      id: 'vllm', label: '自建 vLLM / Xinference',
      baseUrl: 'http://localhost:8000/v1',
      model: 'qwen2.5-7b-instruct',
      open: true, free: true, local: true, json: true,
      note: '机房内网自建推理服务，OpenAI 兼容协议，适合批量评阅',
      models: [],
    },
    zhipu: {
      id: 'zhipu', label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7-flash',
      open: true, free: true, local: false, json: true,
      note: 'GLM 系列权重开源，Flash 版本永久免费',
      models: ['glm-4.7-flash', 'glm-4-flash', 'glm-4-plus'],
    },
    qwen: {
      id: 'qwen', label: '通义千问 Qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      open: true, free: false, local: false, json: true,
      note: 'Qwen 系列权重开源，云端版按量计费，有免费额度',
      models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    },
    deepseek: {
      id: 'deepseek', label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      open: true, free: false, local: false, json: true,
      note: 'DeepSeek-V3 / R1 权重开源，云端版按量计费',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    modelscope: {
      id: 'modelscope', label: '魔搭 ModelScope',
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      open: true, free: true, local: false, json: true,
      note: '阿里魔搭社区推理 API，开源模型为主',
      models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen3-8B'],
    },
    groq: {
      id: 'groq', label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant',
      open: true, free: true, local: false, json: true,
      note: '开源模型高速推理，Llama / Qwen 均可用，有免费额度',
      models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen-2.5-32b'],
    },
    openrouter: {
      id: 'openrouter', label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen-2.5-7b-instruct:free',
      open: true, free: true, local: false, json: true,
      note: '聚合网关，一个 Key 调数百个开源模型，含 :free 后缀的免费档',
      models: ['qwen/qwen-2.5-7b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free'],
    },
    openai: {
      id: 'openai', label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      open: false, free: false, local: false, json: true,
      note: '闭源商业模型，作为兼容性对照保留',
      models: ['gpt-4o-mini', 'gpt-4o'],
    },
    moonshot: {
      id: 'moonshot', label: 'Moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      open: false, free: false, local: false, json: true,
      note: 'Kimi 系列，部分版本开放权重',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    },
  };

  /** 排序权重：免费 + 开源 + 原生的排前面，教学场景优先零成本跑通 */
  function rank(p) {
    return (p.free ? 8 : 0) + (p.open ? 4 : 0) + (p.local ? 2 : 0) + (p.json ? 1 : 0);
  }

  function list(kind) {
    const arr = Object.keys(PRESETS).map((k) => PRESETS[k]);
    const filtered = kind === 'open'
      ? arr.filter((p) => p.open)
      : kind === 'local'
        ? arr.filter((p) => p.local)
        : kind === 'free'
          ? arr.filter((p) => p.free)
          : arr;
    return filtered.sort((a, b) => rank(b) - rank(a));
  }

  function get(id) { return PRESETS[id] || null; }

  /** 默认推荐：免费 + 开源 + 支持 JSON 输出里排最前的那个 */
  function recommend() {
    return list('open').filter((p) => p.free && p.json)[0] || PRESETS.siliconflow;
  }

  /** 判断一个模型名是否属于开源权重系列（用于 UI 标注，非精确判定） */
  const OPEN_MODEL_HINT = /qwen|glm|llama|deepseek|mistral|gemma|yi-|baichuan|internlm|chatglm|phi-|grok/i;

  function isOpenModel(model) {
    return OPEN_MODEL_HINT.test(String(model || ''));
  }

  AG.providers = {
    PRESETS, list, get, recommend, isOpenModel, rank,
    /** 旧配置迁移用：从 baseUrl 反查预设 id */
    fromBaseUrl(url) {
      const u = String(url || '').replace(/\/+$/, '').toLowerCase();
      if (!u) return null;
      const hit = Object.keys(PRESETS).find((k) => PRESETS[k].baseUrl.replace(/\/+$/, '').toLowerCase() === u);
      return hit ? PRESETS[hit] : null;
    },
  };
})(window);
