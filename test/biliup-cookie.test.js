'use strict';

const fs = require('fs');

// 白名单根固定为 /data/biliup，避免测试依赖真实目录
jest.mock('../server/lib/utils/path-safety', () => ({
  ALLOWLIST_ROOTS: ['/data/biliup'],
  resolveAndValidate: jest.fn(async (filePath) => {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return { valid: false, reason: 'empty_path' };
    }
    if (filePath.includes('..')) return { valid: false, reason: 'path_traversal' };
    if (!filePath.startsWith('/data/biliup/')) return { valid: false, reason: 'outside_allowlist' };
    return { valid: true, resolvedPath: filePath };
  }),
  validatePathBasics: jest.fn(async (filePath) => {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return { valid: false, reason: 'empty_path' };
    }
    if (filePath.includes('..')) return { valid: false, reason: 'path_traversal' };
    return { valid: true, resolvedPath: filePath };
  }),
}));
jest.mock('../server/lib/utils/runtime', () => ({ isContainerRuntime: jest.fn(() => false) }));

const {
  loadBiliupCookie,
  CookieError,
  ERROR_CODES,
  resolveCookiePathMode,
} = require('../server/lib/utils/biliup-cookie');
const { isContainerRuntime } = require('../server/lib/utils/runtime');

const SECRETS = {
  sessdata: 'SESSDATA-SECRET-VALUE',
  csrf: 'BILI-JCT-SECRET-VALUE',
  uid: '724423252',
  token: 'ACCESS-TOKEN-SECRET-VALUE',
};

const VALID_PATH = '/data/biliup/cookies.json';

function biliupCookieFile() {
  return {
    token_info: { access_token: SECRETS.token, expires_in: 7776000, mid: Number(SECRETS.uid), refresh_token: 'r' },
    cookie_info: {
      cookies: [
        { name: 'SESSDATA', value: SECRETS.sessdata, expires: 1800000000, http_only: 1, same_site: 0, secure: 1 },
        { name: 'bili_jct', value: SECRETS.csrf, expires: 1800000000, http_only: 1, same_site: 0, secure: 1 },
        { name: 'DedeUserID', value: SECRETS.uid, expires: 1800000000, http_only: 0, same_site: 0, secure: 1 },
        { name: 'sid', value: 'session-id', expires: -1, http_only: 0, same_site: 0, secure: 0 },
      ],
      domains: ['.bilibili.com'],
    },
    sso: ['https://passport.bilibili.com/x/passport-login/web/cookie/info'],
    platform: { web: true, pc: true, h5: false, android: false, ios: false, tv: false },
  };
}

function mockReadFile(impl) {
  jest.spyOn(fs.promises, 'readFile').mockImplementation(impl);
}

function mockReadJson(payload) {
  mockReadFile(async () => JSON.stringify(payload));
}

afterEach(() => {
  jest.restoreAllMocks();
});

// 除「路径策略」用例外，其余用例统一按容器 strict 语义运行，
// 避免测试机自身运行环境（容器/宿主机）影响结果
const originalCookiePathMode = process.env.BILIUP_COOKIE_PATH_MODE;

beforeEach(() => {
  process.env.BILIUP_COOKIE_PATH_MODE = 'strict';
});

afterAll(() => {
  if (originalCookiePathMode === undefined) delete process.env.BILIUP_COOKIE_PATH_MODE;
  else process.env.BILIUP_COOKIE_PATH_MODE = originalCookiePathMode;
});

describe('loadBiliupCookie — 正常解析', () => {
  test('返回 cookieHeader / csrf / uid', async () => {
    mockReadJson(biliupCookieFile());

    const result = await loadBiliupCookie(VALID_PATH);

    expect(result.csrf).toBe(SECRETS.csrf);
    expect(result.uid).toBe(SECRETS.uid);
    expect(result.cookieHeader).toContain(`SESSDATA=${SECRETS.sessdata}`);
    expect(result.cookieHeader).toContain(`bili_jct=${SECRETS.csrf}`);
    expect(result.cookieHeader).toContain('sid=session-id');
  });

  test('cookieHeader 为 name=value 分号串且不含 token_info', async () => {
    mockReadJson(biliupCookieFile());

    const { cookieHeader } = await loadBiliupCookie(VALID_PATH);

    expect(cookieHeader.split('; ')).toHaveLength(4);
    cookieHeader.split('; ').forEach((pair) => expect(pair).toMatch(/^[^=\s]+=.*/));
    expect(cookieHeader).not.toContain(SECRETS.token);
  });

  test('token_info 存在但没有 DedeUserID cookie 时回退到 mid', async () => {
    const file = biliupCookieFile();
    file.cookie_info.cookies = file.cookie_info.cookies.filter((c) => c.name !== 'DedeUserID');
    mockReadJson(file);

    const result = await loadBiliupCookie(VALID_PATH);

    expect(result.uid).toBe(SECRETS.uid);
  });

  test('cookie 项字段不全时忽略该项而非抛错', async () => {
    const file = biliupCookieFile();
    file.cookie_info.cookies.push({ name: 'broken' }, { value: 'no-name' }, null);
    mockReadJson(file);

    const { cookieHeader } = await loadBiliupCookie(VALID_PATH);

    expect(cookieHeader.split('; ')).toHaveLength(4);
  });
});

describe('loadBiliupCookie — 错误分类', () => {
  test('空路径 → COOKIE_NOT_CONFIGURED', async () => {
    mockReadFile(async () => {
      throw new Error('路径非法时不应触达文件系统');
    });

    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      await expect(loadBiliupCookie(bad)).rejects.toMatchObject({ code: ERROR_CODES.NOT_CONFIGURED });
    }
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });

  test('路径越界 → COOKIE_PATH_INVALID', async () => {
    mockReadFile(async () => {
      throw new Error('白名单外不应触达文件系统');
    });

    await expect(loadBiliupCookie('/etc/passwd')).rejects.toMatchObject({
      code: ERROR_CODES.PATH_INVALID,
    });
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });

  test('路径穿越 → COOKIE_PATH_INVALID', async () => {
    await expect(loadBiliupCookie('/data/biliup/../../etc/passwd')).rejects.toMatchObject({
      code: ERROR_CODES.PATH_INVALID,
    });
  });

  test('文件不存在 → COOKIE_NOT_FOUND', async () => {
    const err = new Error('no such file');
    err.code = 'ENOENT';
    mockReadFile(async () => {
      throw err;
    });

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  test('无读取权限 → COOKIE_UNREADABLE', async () => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    mockReadFile(async () => {
      throw err;
    });

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.UNREADABLE });
  });

  test('非 JSON 内容 → COOKIE_MALFORMED', async () => {
    mockReadFile(async () => '# Netscape HTTP Cookie File\nnot json at all');

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.MALFORMED });
  });

  test('缺 cookie_info → COOKIE_MALFORMED', async () => {
    mockReadJson({ token_info: { mid: 1 } });

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.MALFORMED });
  });

  test('cookies 不是数组 → COOKIE_MALFORMED', async () => {
    mockReadJson({ cookie_info: { cookies: { SESSDATA: SECRETS.sessdata } } });

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.MALFORMED });
  });

  test('无 bili_jct → COOKIE_NO_CSRF（登录态可用但无法写操作）', async () => {
    const file = biliupCookieFile();
    file.cookie_info.cookies = file.cookie_info.cookies.filter((c) => c.name !== 'bili_jct');
    mockReadJson(file);

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.NO_CSRF });
  });

  test('bili_jct 为空串 → COOKIE_NO_CSRF', async () => {
    const file = biliupCookieFile();
    file.cookie_info.cookies.find((c) => c.name === 'bili_jct').value = '';
    mockReadJson(file);

    await expect(loadBiliupCookie(VALID_PATH)).rejects.toMatchObject({ code: ERROR_CODES.NO_CSRF });
  });

  test('两者都缺 uid → 返回 null，不抛错', async () => {
    const file = biliupCookieFile();
    file.cookie_info.cookies = file.cookie_info.cookies.filter((c) => c.name !== 'DedeUserID');
    delete file.token_info.mid;
    mockReadJson(file);

    const result = await loadBiliupCookie(VALID_PATH);

    expect(result.uid).toBeNull();
    expect(result.csrf).toBe(SECRETS.csrf);
  });
});

describe('loadBiliupCookie — 凭证红线', () => {
  function withError(code) {
    const err = new Error('underlying failure');
    err.code = code;
    mockReadFile(async () => {
      throw err;
    });
    return loadBiliupCookie(VALID_PATH);
  }

  function withoutCsrf() {
    const file = biliupCookieFile();
    file.cookie_info.cookies = file.cookie_info.cookies.filter((c) => c.name !== 'bili_jct');
    mockReadJson(file);
    return loadBiliupCookie(VALID_PATH);
  }

  test.each([
    ['路径越界', () => loadBiliupCookie('/etc/passwd')],
    ['路径穿越', () => loadBiliupCookie('/data/biliup/../x.json')],
    ['无读取权限', () => withError('EACCES')],
    [
      '坏 JSON（正文含疑似凭证）',
      () => {
        mockReadFile(async () => `{ "cookies": [{ "value": "${SECRETS.sessdata}" }`);
        return loadBiliupCookie(VALID_PATH);
      },
    ],
    [
      '缺 cookie_info',
      () => {
        mockReadJson({ sessdata: SECRETS.sessdata });
        return loadBiliupCookie(VALID_PATH);
      },
    ],
    ['无 bili_jct', withoutCsrf],
  ])('失败路径 %s 的错误不含任何凭证值', async (_label, run) => {
    const err = await run().then(
      () => null,
      (e) => e
    );

    expect(err).toBeInstanceOf(CookieError);
    const text = `${err.message}\n${err.stack}`;
    for (const secret of Object.values(SECRETS)) {
      expect(text).not.toContain(secret);
    }
  });

  test('只读：不触发任何文件写入', async () => {
    const spy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    mockReadJson(biliupCookieFile());

    await loadBiliupCookie(VALID_PATH);

    expect(spy).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('CookieError 是 Error 子类且带 code', async () => {
    mockReadJson({ cookie_info: {} });

    const err = await loadBiliupCookie(VALID_PATH).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CookieError');
    expect(Object.values(ERROR_CODES)).toContain(err.code);
  });
});

describe('loadBiliupCookie — 路径策略（宿主机 / 容器）', () => {
  const HOST_PATH = '/Users/virola/biliup/cookies.json';

  beforeEach(() => {
    isContainerRuntime.mockReturnValue(false);
    delete process.env.BILIUP_COOKIE_PATH_MODE;
  });

  test('auto + 宿主机：白名单外的本机绝对路径可读', async () => {
    mockReadJson(biliupCookieFile());

    const result = await loadBiliupCookie(HOST_PATH);

    expect(result.csrf).toBe(SECRETS.csrf);
    expect(result.uid).toBe(SECRETS.uid);
  });

  test('auto + 容器：白名单外路径拒绝且不触达文件系统', async () => {
    isContainerRuntime.mockReturnValue(true);
    mockReadFile(async () => {
      throw new Error('白名单外不应触达文件系统');
    });

    await expect(loadBiliupCookie(HOST_PATH)).rejects.toMatchObject({ code: ERROR_CODES.PATH_INVALID });
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });

  test('BILIUP_COOKIE_PATH_MODE=any：容器内也允许白名单外路径', async () => {
    isContainerRuntime.mockReturnValue(true);
    process.env.BILIUP_COOKIE_PATH_MODE = 'any';
    mockReadJson(biliupCookieFile());

    const result = await loadBiliupCookie(HOST_PATH);

    expect(result.csrf).toBe(SECRETS.csrf);
  });

  test('BILIUP_COOKIE_PATH_MODE=strict：宿主机也收敛到白名单', async () => {
    process.env.BILIUP_COOKIE_PATH_MODE = 'strict';
    mockReadFile(async () => {
      throw new Error('白名单外不应触达文件系统');
    });

    await expect(loadBiliupCookie(HOST_PATH)).rejects.toMatchObject({ code: ERROR_CODES.PATH_INVALID });
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });

  test('any 模式下仍拒绝 .. 穿越', async () => {
    process.env.BILIUP_COOKIE_PATH_MODE = 'any';
    mockReadFile(async () => {
      throw new Error('穿越路径不应触达文件系统');
    });

    await expect(loadBiliupCookie('/Users/virola/../etc/passwd')).rejects.toMatchObject({
      code: ERROR_CODES.PATH_INVALID,
    });
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });
});

describe('resolveCookiePathMode', () => {
  beforeEach(() => {
    isContainerRuntime.mockReturnValue(false);
  });

  test('默认 auto + 宿主机 → any', () => {
    delete process.env.BILIUP_COOKIE_PATH_MODE;
    expect(resolveCookiePathMode()).toBe('any');
  });

  test('默认 auto + 容器 → strict', () => {
    delete process.env.BILIUP_COOKIE_PATH_MODE;
    isContainerRuntime.mockReturnValue(true);
    expect(resolveCookiePathMode()).toBe('strict');
  });

  test('显式 strict 覆盖自动判定', () => {
    process.env.BILIUP_COOKIE_PATH_MODE = 'strict';
    expect(resolveCookiePathMode()).toBe('strict');
  });

  test('显式 any 覆盖自动判定（大小写不敏感）', () => {
    process.env.BILIUP_COOKIE_PATH_MODE = 'ANY';
    isContainerRuntime.mockReturnValue(true);
    expect(resolveCookiePathMode()).toBe('any');
  });

  test('无法识别的取值按 auto 处理', () => {
    process.env.BILIUP_COOKIE_PATH_MODE = 'nonsense';
    isContainerRuntime.mockReturnValue(true);
    expect(resolveCookiePathMode()).toBe('strict');
  });
});
