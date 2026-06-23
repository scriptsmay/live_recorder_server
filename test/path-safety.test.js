const path = require('path');
const fs = require('fs');
const os = require('os');

// 创建临时目录用于测试
let tmpDir;
let allowlistRoots;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-test-'));
  allowlistRoots = [tmpDir];
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const { resolveAndValidate, isWithinRoot } = require('../server/lib/utils/path-safety');

describe('isWithinRoot', () => {
  test('文件在根目录下返回 true', () => {
    expect(isWithinRoot(path.join(tmpDir, 'file.mp4'), tmpDir)).toBe(true);
  });

  test('嵌套子目录返回 true', () => {
    expect(isWithinRoot(path.join(tmpDir, 'sub', 'dir', 'file.mp4'), tmpDir)).toBe(true);
  });

  test('根目录本身返回 false', () => {
    expect(isWithinRoot(tmpDir, tmpDir)).toBe(false);
  });

  test('父目录返回 false', () => {
    expect(isWithinRoot(path.dirname(tmpDir), tmpDir)).toBe(false);
  });

  test('兄弟目录返回 false', () => {
    expect(isWithinRoot('/other/path', tmpDir)).toBe(false);
  });
});

describe('resolveAndValidate', () => {
  test('正常文件路径返回 valid', async () => {
    const testFile = path.join(tmpDir, 'test.mp4');
    fs.writeFileSync(testFile, 'dummy');
    const result = await resolveAndValidate(testFile, allowlistRoots);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe(testFile);
    fs.unlinkSync(testFile);
  });

  test('空路径返回 invalid', async () => {
    const result = await resolveAndValidate('', allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty_path');
  });

  test('null 路径返回 invalid', async () => {
    const result = await resolveAndValidate(null, allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty_path');
  });

  test('含 .. 的路径返回 invalid', async () => {
    // path.join 会规范化路径（消除 ..），所以检查的是解析后的路径位置
    const result = await resolveAndValidate(path.join(tmpDir, '..', 'etc', 'passwd'), allowlistRoots);
    expect(result.valid).toBe(false);
    // path.join 消除了 .. 后，结果等价于 outside_allowlist
    expect(['path_traversal', 'outside_allowlist']).toContain(result.reason);
  });

  test('allowlist 外路径返回 invalid', async () => {
    const result = await resolveAndValidate('/etc/passwd', allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('outside_allowlist');
  });

  test('根目录本身返回 invalid', async () => {
    const result = await resolveAndValidate(tmpDir, allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('root_directory');
  });

  test('符号链接返回 invalid', async () => {
    const target = path.join(tmpDir, 'target.mp4');
    const link = path.join(tmpDir, 'link.mp4');
    fs.writeFileSync(target, 'dummy');
    fs.symlinkSync(target, link);
    const result = await resolveAndValidate(link, allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('symlink');
    fs.unlinkSync(link);
    fs.unlinkSync(target);
  });

  test('不存在的文件仍校验路径位置', async () => {
    const result = await resolveAndValidate(path.join(tmpDir, 'nonexistent.mp4'), allowlistRoots);
    expect(result.valid).toBe(true);
  });

  test('不存在但在 allowlist 外的文件返回 invalid', async () => {
    const result = await resolveAndValidate('/nonexistent/file.mp4', allowlistRoots);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('outside_allowlist');
  });
});
