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

const { resolveAndValidate, validatePathBasics, isWithinRoot } = require('../server/lib/utils/path-safety');

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

describe('validatePathBasics（无 allowlist 的基础校验）', () => {
  test('allowlist 外的绝对路径返回 valid', async () => {
    const result = await validatePathBasics('/etc/passwd');
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe('/etc/passwd');
  });

  test('tmpDir 内文件返回 valid', async () => {
    const testFile = path.join(tmpDir, 'basics.mp4');
    fs.writeFileSync(testFile, 'dummy');
    const result = await validatePathBasics(testFile);
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe(testFile);
    fs.unlinkSync(testFile);
  });

  test('空路径返回 invalid', async () => {
    const result = await validatePathBasics('');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty_path');
  });

  test('null 路径返回 invalid', async () => {
    const result = await validatePathBasics(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty_path');
  });

  test('含 .. 的路径返回 invalid', async () => {
    // path.join 会规范化消除 ..，这里用原始字符串保留 .. 段
    const result = await validatePathBasics(`${tmpDir}/../etc/passwd`);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('path_traversal');
  });

  test('符号链接返回 invalid', async () => {
    const target = path.join(tmpDir, 'basics-target.mp4');
    const link = path.join(tmpDir, 'basics-link.mp4');
    fs.writeFileSync(target, 'dummy');
    fs.symlinkSync(target, link);
    const result = await validatePathBasics(link);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('symlink');
    fs.unlinkSync(link);
    fs.unlinkSync(target);
  });

  test('不存在的文件仍返回 valid（交给读取环节报不存在）', async () => {
    const result = await validatePathBasics('/nonexistent/whatever.json');
    expect(result.valid).toBe(true);
  });
});
