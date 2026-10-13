/**
 * 合集客户端单测（mock HTTP 层）
 * 覆盖：响应形状归一、错误码归一与可重试分类、凭证红线（错误信息/日志不得含 cookie）
 */

const {
  ERROR_CODES,
  SeasonError,
  listSeasons,
  getSeasonSection,
  getVideoInfo,
  addToSeason,
} = require('../server/lib/core/bilibili-season');

const CREDENTIAL = {
  cookieHeader: 'SESSDATA=secret_sessdata_value; bili_jct=secret_csrf_value; DedeUserID=724423252',
  csrf: 'secret_csrf_value',
  uid: '724423252',
};

const SECRET_STRINGS = ['secret_sessdata_value', 'secret_csrf_value', 'SESSDATA', 'bili_jct'];

function jsonBody(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function mockFetch(payload, options) {
  const response = jsonBody(payload, options);
  global.fetch = jest.fn().mockResolvedValue(response);
  return response;
}

function lastRequest() {
  const calls = global.fetch.mock.calls;
  return calls[calls.length - 1];
}

function lastUrl() {
  const [url] = lastRequest();
  return String(url);
}

function lastInit() {
  const [, init] = lastRequest();
  return init || {};
}

/** 真实线上形状（2026-10-13 只读探测确认） */
function seasonsPayload() {
  return {
    code: 0,
    message: 'OK',
    ttl: 1,
    data: {
      seasons: [
        {
          season: { id: 9314312, title: '测试合集', ep_num: 3, mid: 724423252 },
          sections: {
            sections: [
              { id: 10419712, title: '正片', seasonId: 9314312, epCount: 3, type: 1 },
              { id: 10419713, title: '预告', seasonId: 9314312, epCount: 0, type: 1 },
            ],
          },
          seasonStat: { view: 1 },
        },
        {
          season: { id: 9314399, title: '另一个合集', ep_num: 0 },
          sections: { sections: [{ id: 10419800, title: '正片', seasonId: 9314399 }] },
        },
      ],
      total: 2,
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('listSeasons', () => {
  it('归一 data.seasons[].season + .sections.sections[] 两级结构', async () => {
    mockFetch(seasonsPayload());
    const result = await listSeasons(CREDENTIAL);

    expect(result.total).toBe(2);
    expect(result.seasons).toHaveLength(2);
    expect(result.seasons[0]).toEqual({
      seasonId: 9314312,
      title: '测试合集',
      sections: [
        { sectionId: 10419712, title: '正片' },
        { sectionId: 10419713, title: '预告' },
      ],
    });
  });

  it('请求携带 pn/ps/order/sort/draft 与 cookie、UA、Referer', async () => {
    mockFetch(seasonsPayload());
    await listSeasons(CREDENTIAL, { pn: 2, ps: 10 });

    const url = new URL(lastUrl());
    expect(url.origin).toBe('https://member.bilibili.com');
    expect(url.pathname).toBe('/x2/creative/web/seasons');
    expect(url.searchParams.get('pn')).toBe('2');
    expect(url.searchParams.get('ps')).toBe('10');
    expect(url.searchParams.get('order')).toBe('mtime');
    expect(url.searchParams.get('sort')).toBe('desc');
    expect(url.searchParams.get('draft')).toBe('1');

    const headers = lastInit().headers;
    expect(headers.Cookie).toBe(CREDENTIAL.cookieHeader);
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers.Referer).toContain('member.bilibili.com');
  });

  it('缺省分页为 pn=1 / ps=30', async () => {
    mockFetch(seasonsPayload());
    await listSeasons(CREDENTIAL);
    expect(new URL(lastUrl()).searchParams.get('ps')).toBe('30');
  });

  it('跳过缺 id 的 season / section，绝不下发 undefined', async () => {
    mockFetch({
      code: 0,
      data: {
        seasons: [
          { season: { title: '无 ID' }, sections: { sections: [{ id: 1, title: 'a' }] } },
          { season: { id: 5, title: '无小节' }, sections: { sections: [{ title: '缺 ID' }] } },
          'not-an-object',
        ],
        total: 3,
      },
    });
    const result = await listSeasons(CREDENTIAL);

    expect(result.seasons).toEqual([{ seasonId: 5, title: '无小节', sections: [] }]);
  });

  it('data 或 seasons 缺失时返回空列表（真·没有合集）', async () => {
    mockFetch({ code: 0, message: 'OK', data: null });
    await expect(listSeasons(CREDENTIAL)).resolves.toEqual({ seasons: [], total: 0 });

    mockFetch({ code: 0, data: { seasons: null } });
    await expect(listSeasons(CREDENTIAL)).resolves.toEqual({ seasons: [], total: 0 });
  });

  it('title 缺省时回退空串，不返回 undefined', async () => {
    mockFetch({ code: 0, data: { seasons: [{ season: { id: 7 }, sections: { sections: [{ id: 8 }] } }] } });
    const result = await listSeasons(CREDENTIAL);
    expect(result.seasons[0].title).toBe('');
    expect(result.seasons[0].sections[0].title).toBe('');
  });

  it('登录态失效 code=-101 → AUTH_EXPIRED 且不可重试', async () => {
    mockFetch({ code: -101, message: '账号未登录', data: null });
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      name: 'SeasonError',
      code: ERROR_CODES.AUTH_EXPIRED,
      retryable: false,
    });
  });

  it('风控 code=-352 → RATE_LIMITED 且不可重试', async () => {
    mockFetch({ code: -352, message: '风险控制已生效' });
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMITED,
      retryable: false,
    });
  });

  it('其它非 0 业务码 → BIZ_ERROR，带上 B 站 message 便于诊断', async () => {
    mockFetch({ code: -400, message: '请求错误' });
    const err = await listSeasons(CREDENTIAL).catch((e) => e);
    expect(err).toBeInstanceOf(SeasonError);
    expect(err.code).toBe(ERROR_CODES.BIZ_ERROR);
    expect(err.message).toContain('请求错误');
    expect(err.bizCode).toBe(-400);
  });
});

describe('getSeasonSection', () => {
  it('用 ?id=（不是 ?section_id=）查小节，并归一 episodes', async () => {
    mockFetch({
      code: 0,
      data: {
        section: { id: 10419712, seasonId: 9314312, title: '正片', epCount: 2 },
        episodes: [
          { id: 1, aid: 5001, cid: 6001, title: 'A' },
          { id: 2, aid: 5002, cid: 6002, title: 'B' },
        ],
      },
    });
    const result = await getSeasonSection(CREDENTIAL, 10419712);

    expect(new URL(lastUrl()).searchParams.get('id')).toBe('10419712');
    expect(new URL(lastUrl()).searchParams.has('section_id')).toBe(false);
    expect(result).toEqual({
      sectionId: 10419712,
      seasonId: 9314312,
      title: '正片',
      episodeCount: 2,
      aids: [5001, 5002],
    });
  });

  it('空小节的 episodes 是 null（不是 []）→ aids 归一为空数组', async () => {
    mockFetch({ code: 0, data: { section: { id: 10419712, seasonId: 9314312, epCount: 0 }, episodes: null } });
    const result = await getSeasonSection(CREDENTIAL, 10419712);

    expect(result.aids).toEqual([]);
    expect(result.episodeCount).toBe(0);
  });

  it('幂等判断只看 aid：缺 aid 的条目被忽略，不影响已存在判断', async () => {
    mockFetch({ code: 0, data: { section: { id: 1 }, episodes: [{ cid: 9 }, { aid: 77 }] } });
    const result = await getSeasonSection(CREDENTIAL, 1);
    expect(result.aids).toEqual([77]);
  });

  it('section 不存在 → SECTION_INVALID 且不可重试', async () => {
    mockFetch({ code: -404, message: '啥都木有' });
    await expect(getSeasonSection(CREDENTIAL, 999)).rejects.toMatchObject({
      code: ERROR_CODES.SECTION_INVALID,
      retryable: false,
    });
  });

  it('非法 sectionId 直接拒绝，不发请求', async () => {
    global.fetch = jest.fn();
    await expect(getSeasonSection(CREDENTIAL, 'abc; DROP TABLE')).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_ARGUMENT,
    });
    await expect(getSeasonSection(CREDENTIAL, undefined)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_ARGUMENT,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('getVideoInfo', () => {
  it('按 bvid 查 view，cid 取 pages[0].cid', async () => {
    mockFetch({
      code: 0,
      data: { aid: 5001, title: '录像标题', pages: [{ cid: 6001 }, { cid: 6002 }] },
    });
    const result = await getVideoInfo(CREDENTIAL, { bvid: 'BV1xx411c7mD' });

    expect(new URL(lastUrl()).origin).toBe('https://api.bilibili.com');
    expect(new URL(lastUrl()).pathname).toBe('/x/web-interface/view');
    expect(new URL(lastUrl()).searchParams.get('bvid')).toBe('BV1xx411c7mD');
    expect(result).toEqual({ aid: 5001, cid: 6001, title: '录像标题' });
  });

  it('支持按 aid 查询', async () => {
    mockFetch({ code: 0, data: { aid: 5001, title: 't', pages: [{ cid: 6001 }] } });
    await getVideoInfo(CREDENTIAL, { aid: 5001 });
    expect(new URL(lastUrl()).searchParams.get('aid')).toBe('5001');
  });

  it('bvid 与 aid 都缺 → INVALID_ARGUMENT，不发请求', async () => {
    global.fetch = jest.fn();
    await expect(getVideoInfo(CREDENTIAL, {})).rejects.toMatchObject({ code: ERROR_CODES.INVALID_ARGUMENT });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('稿件过审中 code=-404 → VIDEO_NOT_READY 且可重试', async () => {
    mockFetch({ code: -404, message: '啥都木有' });
    await expect(getVideoInfo(CREDENTIAL, { bvid: 'BV1xx411c7mD' })).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_NOT_READY,
      retryable: true,
    });
  });

  it('code=0 但缺 aid / pages → VIDEO_NOT_READY（同属未就绪）', async () => {
    mockFetch({ code: 0, data: { aid: 0, pages: [] } });
    await expect(getVideoInfo(CREDENTIAL, { bvid: 'BV1xx411c7mD' })).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_NOT_READY,
      retryable: true,
    });

    mockFetch({ code: 0, data: { aid: 5001, pages: [{ cid: 0 }] } });
    await expect(getVideoInfo(CREDENTIAL, { bvid: 'BV1xx411c7mD' })).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_NOT_READY,
    });
  });

  it('data 为 null → VIDEO_NOT_READY，不抛 TypeError', async () => {
    mockFetch({ code: 0, data: null });
    await expect(getVideoInfo(CREDENTIAL, { bvid: 'BV1xx411c7mD' })).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_NOT_READY,
    });
  });
});

describe('addToSeason', () => {
  const episodes = [{ aid: 5001, cid: 6001, title: '录像标题' }];

  it('POST csrf 同时进 query 与 body，episodes 补 charging_pay:0', async () => {
    mockFetch({ code: 0, message: 'OK', data: { aid: 5001 } });
    const result = await addToSeason(CREDENTIAL, { sectionId: 10419712, episodes });

    expect(lastInit().method).toBe('POST');
    const url = new URL(lastUrl());
    expect(url.pathname).toBe('/x2/creative/web/season/section/episodes/add');
    expect(url.searchParams.get('csrf')).toBe(CREDENTIAL.csrf);

    const body = JSON.parse(lastInit().body);
    expect(body.sectionId).toBe(10419712);
    expect(body.csrf).toBe(CREDENTIAL.csrf);
    expect(body.episodes).toEqual([{ aid: 5001, cid: 6001, title: '录像标题', charging_pay: 0 }]);
    expect(lastInit().headers['Content-Type']).toBe('application/json; charset=UTF-8');
    expect(result).toMatchObject({ added: true, alreadyAdded: false });
  });

  it('缺省 charging_pay 补 0、title 归一为字符串', async () => {
    mockFetch({ code: 0, data: {} });
    await addToSeason(CREDENTIAL, { sectionId: 1, episodes: [{ aid: 5, cid: 6 }] });
    expect(JSON.parse(lastInit().body).episodes).toEqual([{ aid: 5, cid: 6, title: '', charging_pay: 0 }]);
  });

  it('20080「已在合集中」归一为成功且不再重试（服务端去重）', async () => {
    mockFetch({ code: 20080, message: '稿件已经在合集内' });
    const result = await addToSeason(CREDENTIAL, { sectionId: 1, episodes });

    expect(result).toMatchObject({ added: true, alreadyAdded: true, bizCode: 20080 });
  });

  it('20111「编辑过于频繁」→ 可重试，交上层退避', async () => {
    mockFetch({ code: 20111, message: '合集编辑过于频繁，请稍后再试' });
    await expect(addToSeason(CREDENTIAL, { sectionId: 1, episodes })).rejects.toMatchObject({
      code: ERROR_CODES.TOO_FREQUENT,
      retryable: true,
    });
  });

  it('csrf 失败 code=-111 → CSRF_FAILED 且不可重试', async () => {
    mockFetch({ code: -111, message: 'csrf 验证错误' });
    await expect(addToSeason(CREDENTIAL, { sectionId: 1, episodes })).rejects.toMatchObject({
      code: ERROR_CODES.CSRF_FAILED,
      retryable: false,
    });
  });

  it('episodes 为空 / 缺 cid → INVALID_ARGUMENT，不发写请求', async () => {
    global.fetch = jest.fn();
    await expect(addToSeason(CREDENTIAL, { sectionId: 1, episodes: [] })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_ARGUMENT,
    });
    await expect(addToSeason(CREDENTIAL, { sectionId: 1, episodes: [{ aid: 5 }] })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_ARGUMENT,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('无 csrf 的凭证不允许写操作', async () => {
    global.fetch = jest.fn();
    await expect(addToSeason({ cookieHeader: 'SESSDATA=x' }, { sectionId: 1, episodes })).rejects.toMatchObject({
      code: ERROR_CODES.CREDENTIAL_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('传输层与错误分类', () => {
  it('HTTP 5xx → HTTP_ERROR 且可重试', async () => {
    mockFetch({ code: 0 }, { ok: false, status: 503 });
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      code: ERROR_CODES.HTTP_ERROR,
      retryable: true,
      httpStatus: 503,
    });
  });

  it('HTTP 403 → HTTP_ERROR 且不可重试', async () => {
    mockFetch({ code: 0 }, { ok: false, status: 403 });
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      code: ERROR_CODES.HTTP_ERROR,
      retryable: false,
    });
  });

  it('网络异常 → NETWORK_ERROR 且可重试', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      code: ERROR_CODES.NETWORK_ERROR,
      retryable: true,
    });
  });

  it('返回 HTML（接口被改造 / 网关页）→ RESPONSE_MALFORMED 可重试', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new Error('Unexpected token < in JSON')),
      text: jest.fn().mockResolvedValue('<html></html>'),
    });
    await expect(listSeasons(CREDENTIAL)).rejects.toMatchObject({
      code: ERROR_CODES.RESPONSE_MALFORMED,
      retryable: true,
    });
  });

  it('超时 → SEASON_TIMEOUT，且错误信息不含 URL / 凭证', async () => {
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        })
    );

    const err = await addToSeason(CREDENTIAL, {
      sectionId: 1,
      episodes: [{ aid: 5, cid: 6, title: 't' }],
      timeoutMs: 5,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SeasonError);
    expect(err.code).toBe(ERROR_CODES.SEASON_TIMEOUT);
    expect(err.retryable).toBe(true);
    for (const secret of SECRET_STRINGS) {
      expect(err.message).not.toContain(secret);
    }
    expect(err.message).not.toContain('member.bilibili.com');
  });

  it('缺省超时取环境变量 SEASON_HTTP_TIMEOUT_MS，显式 timeoutMs 优先', async () => {
    const previous = process.env.SEASON_HTTP_TIMEOUT_MS;
    process.env.SEASON_HTTP_TIMEOUT_MS = '12345';
    const timerSpy = jest.spyOn(global, 'setTimeout');
    mockFetch({ code: 0, data: { seasons: [] } });
    await listSeasons(CREDENTIAL);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 12345);

    await listSeasons(CREDENTIAL, { timeoutMs: 999 });
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 999);

    if (previous === undefined) delete process.env.SEASON_HTTP_TIMEOUT_MS;
    else process.env.SEASON_HTTP_TIMEOUT_MS = previous;
  });
});

describe('凭证红线', () => {
  it('缺 cookieHeader 的凭证直接拒绝，不发请求', async () => {
    global.fetch = jest.fn();
    await expect(listSeasons({})).rejects.toMatchObject({ code: ERROR_CODES.CREDENTIAL_INVALID });
    await expect(listSeasons({ cookieHeader: '   ' })).rejects.toMatchObject({
      code: ERROR_CODES.CREDENTIAL_INVALID,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  const failureCases = [
    ['HTTP 5xx', () => mockFetch({ code: 0 }, { ok: false, status: 500 })],
    ['业务失败码', () => mockFetch({ code: -101, message: '账号未登录' })],
    [
      '网络异常',
      () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      },
    ],
    [
      '响应非 JSON',
      () => {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: jest.fn().mockRejectedValue(new Error('bad json')),
          text: jest.fn().mockResolvedValue('oops'),
        });
      },
    ],
  ];

  it.each(failureCases)('%s 失败路径的错误对象不含任何凭证', async (_label, setup) => {
    setup();
    const err = await listSeasons(CREDENTIAL).catch((e) => e);
    expect(err).toBeInstanceOf(SeasonError);
    const dump = `${err.message}\n${err.stack}`;
    for (const secret of SECRET_STRINGS) {
      expect(dump).not.toContain(secret);
    }
  });

  it('写接口失败同样不外泄凭证', async () => {
    mockFetch({ code: -111, message: 'csrf 验证错误' });
    const err = await addToSeason(CREDENTIAL, {
      sectionId: 1,
      episodes: [{ aid: 5, cid: 6, title: 't' }],
    }).catch((e) => e);

    const dump = `${err.message}\n${err.stack}`;
    for (const secret of SECRET_STRINGS) {
      expect(dump).not.toContain(secret);
    }
  });

  it('只读：任何操作都不触发 fetch 之外的写文件调用', async () => {
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockImplementation(async () => {});
    mockFetch(seasonsPayload());
    await listSeasons(CREDENTIAL);
    await getSeasonSection(CREDENTIAL, 10419712);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
