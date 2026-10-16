/**
 * litellm 客户端单测 — 行为基线 = analyze.py call_llm（批量实测验证）
 *
 * 覆盖：JSON 解析失败不重放 HTTP、线性退避、temperature 400 自愈（弹字段立即重试不退避）、
 * 回退链每模型「普通+strict」两试、全链失败返回错误集合不抛异常。
 * 退避定时器通过替换 client.sleep 消除（callOnce 走 module.exports.sleep）。
 */

jest.mock('axios');
const axios = require('axios');
const client = require('../server/lib/core/llm/litellm-client');

const ok = (content) => ({ data: { choices: [{ message: { content } }] } });
const httpErr = (status, detail) => {
  const e = new Error(`Request failed with status ${status}`);
  e.response = { status, data: detail };
  return e;
};
const netErr = (message) => Object.assign(new Error(message), { name: 'ECONNABORTED' });

const BASE = { baseUrl: 'https://lite.example/v1', apiKey: 'sk-test', payload: 'P' };

describe('parseJsonBlock', () => {
  test('剥围栏、取首 { 到末 } 的贪婪口径；数组与非 JSON 返回 null', () => {
    expect(client.parseJsonBlock('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(client.parseJsonBlock('前缀 {"a": {"b": 2}} 后缀')).toEqual({ a: { b: 2 } });
    expect(client.parseJsonBlock('[1,2]')).toBeNull();
    expect(client.parseJsonBlock('没有大括号')).toBeNull();
    expect(client.parseJsonBlock('{"broken": ')).toBeNull();
    expect(client.parseJsonBlock('')).toBeNull();
  });
});

describe('callOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(client, 'sleep').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('一次成功：URL 拼接、鉴权头、max_tokens 默认 8000、temperature 默认 0.3', async () => {
    axios.post.mockResolvedValueOnce(ok('{"session_summary":"s"}'));
    const res = await client.callOnce({ ...BASE, model: 'm1' });
    expect(res.data).toEqual({ session_summary: 's' });
    expect(res.err).toBe('');
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://lite.example/v1/chat/completions');
    expect(body.max_tokens).toBe(8000);
    expect(body.temperature).toBe(0.3);
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
    expect(opts.timeout).toBe(300000);
  });

  test('baseUrl 带尾斜杠也不双写；strict 追加系统提示后缀', async () => {
    axios.post.mockResolvedValueOnce(ok('{}'));
    await client.callOnce({ ...BASE, baseUrl: 'https://lite.example/v1///', model: 'm1', strict: true });
    const [, body] = axios.post.mock.calls[0];
    expect(axios.post.mock.calls[0][0]).toBe('https://lite.example/v1/chat/completions');
    expect(body.messages[0].content).toContain('只输出一行紧凑 JSON');
  });

  test('JSON 解析失败即出循环，不做无谓 HTTP 重放', async () => {
    axios.post.mockResolvedValue(ok('模型瞎聊，没有 JSON'));
    const res = await client.callOnce({ ...BASE, model: 'm1' });
    expect(res.data).toBeNull();
    expect(res.err).toContain('JSON 解析失败');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(client.sleep).not.toHaveBeenCalled();
  });

  test('网络错误：最多 3 次尝试，线性退避 2s/4s/6s（末次等待在 analyze.py 口径里保留）', async () => {
    axios.post.mockRejectedValue(netErr('timeout of 300000ms exceeded'));
    const res = await client.callOnce({ ...BASE, model: 'm1' });
    expect(res.data).toBeNull();
    expect(res.err).toContain('ECONNABORTED');
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(client.sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 6000]);
  });

  test('temperature 被 400 拒：弹字段后立即重试（不退避），后续请求体不再带 temperature', async () => {
    axios.post
      .mockRejectedValueOnce(httpErr(400, '{"error":"temperature is not supported by this model"}'))
      .mockResolvedValueOnce(ok('{"ok":true}'));
    const res = await client.callOnce({ ...BASE, model: 'k3' });
    expect(res.data).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[1][1].temperature).toBeUndefined();
    expect(client.sleep).not.toHaveBeenCalled();
  });

  test('其他 HTTP 错误照常退避重试，err 保留状态码与响应片段', async () => {
    axios.post.mockRejectedValue(httpErr(503, 'upstream busy'));
    const res = await client.callOnce({ ...BASE, model: 'm1' });
    expect(res.err).toContain('HTTP 503');
    expect(res.err).toContain('upstream busy');
    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});

describe('completeWithFallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(client, 'sleep').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('主模型输出不可解析 → 同模型 strict 二试成功，不回退', async () => {
    axios.post.mockResolvedValueOnce(ok('废话')).mockResolvedValueOnce(ok('{"session_summary":"s2"}'));
    const res = await client.completeWithFallback({ ...BASE, model: 'm1' });
    expect(res.data).toEqual({ session_summary: 's2' });
    expect(res.model).toBe('m1');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('m1:');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('主模型两试全失败 → 依次回退，返回命中的备用模型名', async () => {
    axios.post
      .mockResolvedValueOnce(ok('bad1'))
      .mockResolvedValueOnce(ok('bad2'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockRejectedValueOnce(httpErr(500, 'server error'))
      .mockResolvedValueOnce(ok('{"session_summary":"s3"}'));
    const res = await client.completeWithFallback({ ...BASE, model: 'm1', fallbackModels: ['m2', 'm3'] });
    expect(res.data).toEqual({ session_summary: 's3' });
    expect(res.model).toBe('m3');
    expect(res.errors.some((e) => e.startsWith('m1(严格重试):'))).toBe(true);
    expect(res.errors.some((e) => e.includes('m2:'))).toBe(true);
  });

  test('全链失败：data=null 不抛异常，errors 逐模型记录（报告照出纯统计）', async () => {
    axios.post.mockResolvedValue(ok('全是废话'));
    const res = await client.completeWithFallback({ ...BASE, model: 'm1' });
    expect(res.data).toBeNull();
    expect(res.model).toBe('');
    expect(res.errors).toHaveLength(3 * 2); // 3 个模型 × 普通/strict
    expect(res.errors.map((e) => e.slice(0, 10))).toEqual([
      'm1: JSON 解',
      'm1(严格重试): ',
      'glm-5.3-fl',
      'glm-5.3-fl',
      'qwen3.7-fl',
      'qwen3.7-fl',
    ]);
  });

  test('回退链去重：与主模型同名的备用项剔除', async () => {
    axios.post.mockResolvedValue(ok('{"x":1}'));
    const res = await client.completeWithFallback({ ...BASE, model: 'm1', fallbackModels: ['m1', '', 'm2'] });
    expect(res.model).toBe('m1');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
