const axios = require('axios');

/**
 * litellm（OpenAI 兼容 /chat/completions）客户端封装
 *
 * 行为基线 = 离线批量回算脚本 analyze.py 实测验证过的 call_llm/回退链，逐分支移植：
 *  - 每次调用最多 3 次 HTTP 尝试，线性退避 2s/4s/6s；
 *  - 模型拒收 temperature（响应体含 "temperature"）时弹出该字段立即重试（kimi-k3 类）；
 *  - JSON 解析失败不再重试 HTTP，交外层 strict 二试；
 *  - 回退链每模型「普通 + strict」两试，全链失败返回错误集合不抛异常（报告照出）。
 *
 * api_key 只走环境变量（config.AI_ANALYSIS_API_KEY），绝不落库/落日志。
 */

const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_FALLBACK_MODELS = ['glm-5.3-flash', 'qwen3.7-flash'];
// 推理型模型实测 reasoning≈2200 tokens、正文≈550，1500 会被推理吃光、正文 0 字
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TIMEOUT_MS = 300000;
const HTTP_ATTEMPTS = 3;

const SYSTEM_PROMPT =
  '你是直播弹幕分析助手。输入是一场直播的统计概览与若干高光时间区间的弹幕样本。' +
  '请输出严格的 JSON（不要 markdown 代码块、不要多余文字），结构：' +
  '{"session_summary": "整场 2~4 句中文总结", ' +
  '"highlights": [{"index": 1, "label": "8 字内短标题", "reason": "一句话说明这段为什么是高光"}]}。' +
  '要求：highlights 的 index 必须与输入的高光区间序号一一对应；只依据给定样本，不要编造未出现的内容；' +
  '不得声称分析过礼物名称（礼物名是平台混淆串）。';

const STRICT_SUFFIX =
  '\n注意：上一次你的输出不是合法 JSON。这次只输出一行紧凑 JSON，' +
  '字符串内不要使用英文双引号（改用中文引号），不要任何解释文字。';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 剥离 markdown 围栏后取第一个 { 到最后一个 } 解析为对象（照抄 analyze.py _parse_json_block 贪婪口径）
 *
 * @param {string} text
 * @returns {Object|null} 解析失败返回 null，不抛
 */
function parseJsonBlock(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(?:```(?:json)?|```)$/gm, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (_) {
    return null;
  }
}

/**
 * 单次逻辑调用：最多 3 次 HTTP 尝试（含 temperature 自愈的即地重试）
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl - 形如 https://xxx/v1（不含 /chat/completions）
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.payload - 用户消息内容
 * @param {number|null} [opts.temperature=0.3]
 * @param {number} [opts.maxTokens=8000]
 * @param {boolean} [opts.strict=false]
 * @param {number} [opts.timeoutMs=300000]
 * @returns {Promise<{data: Object|null, err: string}>} data 为 null 时 err 给原因
 */
async function callOnce({ baseUrl, apiKey, model, payload, temperature, maxTokens, strict = false, timeoutMs }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + (strict ? STRICT_SUFFIX : '') },
    { role: 'user', content: payload },
  ];
  const body = {
    model,
    messages,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
  };
  let temp = temperature === undefined ? DEFAULT_TEMPERATURE : temperature;
  if (temp !== null && temp !== undefined) {
    body.temperature = temp;
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  let lastErr = '';
  for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await axios.post(url, body, { headers, timeout: timeoutMs || DEFAULT_TIMEOUT_MS });
      const content = resp.data?.choices?.[0]?.message?.content;
      const parsed = parseJsonBlock(content);
      if (parsed === null) {
        // 解析失败即出循环，重试交给外层 strict（照 analyze.py 口径，不做无谓 HTTP 重放）
        return {
          data: null,
          err: `JSON 解析失败，原始输出前 200 字：${JSON.stringify(String(content || '').slice(0, 200))}`,
        };
      }
      return { data: parsed, err: '' };
    } catch (exc) {
      if (exc.response) {
        const raw = typeof exc.response.data === 'string' ? exc.response.data : JSON.stringify(exc.response.data);
        const detail = String(raw || '').slice(0, 200);
        lastErr = `HTTP ${exc.response.status}: ${detail}`;
        if (detail.includes('temperature') && temp !== null && temp !== undefined) {
          // 兼容拒收 temperature 的模型：弹字段后立即重试，不退避
          temp = null;
          delete body.temperature;
          continue;
        }
      } else {
        lastErr = `${exc.name || 'Error'}: ${exc.message}`;
      }
      await module.exports.sleep(2000 * (attempt + 1));
    }
  }
  return { data: null, err: lastErr };
}

/**
 * 回退链调用：主模型失败依次尝试 fallbackModels，每模型「普通 + strict」两试
 *
 * @param {Object} opts - 同 callOnce，另加 model/fallbackModels
 * @param {string[]} [opts.fallbackModels]
 * @returns {Promise<{data: Object|null, model: string, errors: string[]}>}
 */
async function completeWithFallback({ model, fallbackModels, ...rest }) {
  const chain = [model, ...(fallbackModels || DEFAULT_FALLBACK_MODELS).filter((m) => m && m !== model)];
  const errors = [];
  for (const m of chain) {
    let data = null;
    for (const strict of [false, true]) {
      const res = await callOnce({ ...rest, model: m, strict });
      if (res.data) {
        data = res.data;
        break;
      }
      errors.push(`${m}${strict ? '(严格重试)' : ''}: ${res.err.slice(0, 160)}`);
    }
    if (data) {
      return { data, model: m, errors };
    }
  }
  return { data: null, model: '', errors };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  SYSTEM_PROMPT,
  parseJsonBlock,
  callOnce,
  completeWithFallback,
  // 退避定时器：单独导出供单测替换，避免真实等待 2s/4s/6s
  sleep,
};
