jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({
    data: {
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        },
      },
    },
  }),
}));

const axios = require('axios');
const { WbiSigner, createMixinKey } = require('../server/lib/core/danmaku/codec/wbi');

describe('WBI sign', () => {
  test('导航栏 key → mixin key → wts + w_rid（回归向量）', async () => {
    // img/sub key 为 bilibili-api-collect 文档公开示例值
    const mixin = createMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(mixin).toHaveLength(32);

    const signer = new WbiSigner();
    const params = { foo: '114', bar: '514' };
    const ok = await signer.sign(params, {});
    expect(ok).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.bilibili.com/x/web-interface/nav',
      expect.objectContaining({ headers: {}, timeout: 5000 })
    );
    expect(typeof params.wts).toBe('string');
    expect(Number(params.wts)).toBeGreaterThan(0);
    expect(params.w_rid).toMatch(/^[0-9a-f]{32}$/);
  });

  test('key 缓存生效（2 小时内不重复请求导航栏）', async () => {
    axios.get.mockClear();
    const signer = new WbiSigner();
    await signer.sign({}, {});
    const callsAfterFirst = axios.get.mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    await signer.sign({}, {});
    expect(axios.get.mock.calls.length).toBe(1); // 命中缓存
  });

  test('导航栏请求失败 → sign 返回 false（调用方降级默认 WS 地址）', async () => {
    axios.get.mockRejectedValueOnce(new Error('network down'));
    const signer = new WbiSigner();
    const params = {};
    const ok = await signer.sign(params, {});
    expect(ok).toBe(false);
    expect(params.w_rid).toBeUndefined();
  });

  test('导航栏响应缺字段 → sign 返回 false', async () => {
    axios.get.mockResolvedValueOnce({ data: { code: -101 } });
    const signer = new WbiSigner();
    const ok = await signer.sign({}, {});
    expect(ok).toBe(false);
  });
});
