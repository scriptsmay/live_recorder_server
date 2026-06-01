const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const DanmakuBurner = require('../lib/core/danmaku-burner');

// ============================================================
// 辅助函数
// ============================================================

const TMP_DIR = path.join(__dirname, 'tmp_burner_test');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function tmpPath(name) {
  return path.join(TMP_DIR, name);
}

function createDummyFile(filepath, content) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, content || 'dummy content', 'utf-8');
}

/**
 * Mock a successful spawn that exits with code 0 and creates output file
 */
function mockSpawnSuccess() {
  spawn.mockImplementation((_cmd, args, _opts) => {
    const proc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      killed: false,
      kill: jest.fn(),
    };

    // Capture event handlers
    const handlers = {};
    proc.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });

    // Delay close to next tick
    setImmediate(() => {
      // Extract outputPath from args (always the last arg)
      const outputPath = args[args.length - 1];
      if (outputPath && !outputPath.startsWith('-')) {
        createDummyFile(outputPath, 'fake video data');
      }
      if (handlers.close) handlers.close(0);
    });

    return proc;
  });
}

/**
 * Mock a failing spawn (non-zero exit code)
 */
function mockSpawnFail(exitCode, stderrText) {
  spawn.mockImplementation((_cmd, _args, _opts) => {
    const proc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn(),
      killed: false,
      kill: jest.fn(),
    };

    const handlers = {};
    proc.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });

    // Feed stderr
    if (stderrText) {
      let stderrHandler;
      proc.stderr.on.mockImplementation((event, handler) => {
        stderrHandler = handler;
      });
      setImmediate(() => {
        if (stderrHandler) stderrHandler(Buffer.from(stderrText));
        if (handlers.close) handlers.close(exitCode);
      });
    } else {
      setImmediate(() => {
        if (handlers.close) handlers.close(exitCode);
      });
    }

    return proc;
  });
}

// ============================================================
// 测试组 1: _buildFilterChain
// ============================================================

describe('DanmakuBurner — buildFilterChain', () => {
  test('正常路径生成 subtitles 滤镜', () => {
    const filter = DanmakuBurner._buildFilterChain('/videos/test.ass');
    expect(filter).toContain('subtitles=');
    expect(filter).toContain('/videos/test.ass');
  });

  test('Windows 风格路径反斜杠转正斜杠', () => {
    const filter = DanmakuBurner._buildFilterChain('C:\\videos\\test.ass');
    // 反斜杠先替换为 /，然后 : 被转义为 \:，所以结果是 C\:/videos/test.ass
    expect(filter).toContain('C\\:/videos/test.ass');
    expect(filter).not.toContain('\\\\');
  });

  test('路径中冒号被转义', () => {
    const filter = DanmakuBurner._buildFilterChain('/path/with:colon.ass');
    // : 被转义为 \:，在 JS 字符串中是 \: （一个反斜杠+冒号）
    expect(filter).toContain('with\\:colon');
  });

  test('路径中单引号被转义', () => {
    const filter = DanmakuBurner._buildFilterChain("/path/it's.ass");
    // ' 被转义为 \'
    expect(filter).toContain("it\\'s");
  });

  test('中文路径正常处理', () => {
    const filter = DanmakuBurner._buildFilterChain('/视频/弹幕字幕.ass');
    expect(filter).toContain('subtitles=');
    expect(filter).toContain('/视频/弹幕字幕.ass');
  });

  test('相对路径被解析为绝对路径', () => {
    const filter = DanmakuBurner._buildFilterChain('relative/path/test.ass');
    expect(filter).toContain('subtitles=');
    // 绝对路径应以 / 开头（POSIX）
    expect(filter).toMatch(/subtitles='\/.*relative\/path\/test\.ass'/);
    expect(filter).not.toMatch(/^subtitles='relative/);
  });

  test('方括号被转义', () => {
    const filter = DanmakuBurner._buildFilterChain('/path/[test].ass');
    expect(filter).toContain('\\[');
    expect(filter).toContain('\\]');
  });
});

// ============================================================
// 测试组 2: _buildArgs
// ============================================================

describe('DanmakuBurner — buildArgs', () => {
  test('默认 CPU 编码 (libx264)', () => {
    const args = DanmakuBurner._buildArgs('/videos/test.mp4', '/videos/test.ass', '/videos/test_danmaku.mp4', false);

    expect(args).toContain('-i');
    expect(args).toContain('/videos/test.mp4');
    expect(args).toContain('-vf');
    expect(args[args.indexOf('-vf') + 1]).toContain('subtitles=');
    expect(args).toContain('libx264');
    expect(args).toContain('veryfast');
    expect(args).toContain('-crf');
    expect(args).toContain('23');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
    expect(args).toContain('-y');
    expect(args[args.length - 1]).toBe('/videos/test_danmaku.mp4');
  });

  test('QSV 硬件编码', () => {
    const args = DanmakuBurner._buildArgs('/videos/test.mp4', '/videos/test.ass', '/videos/test_danmaku.mp4', true);

    expect(args).toContain('h264_qsv');
    expect(args).toContain('-global_quality');
    expect(args).toContain('23');
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('veryfast');
  });
});

// ============================================================
// 测试组 3: burn() — 前置检查
// ============================================================

describe('DanmakuBurner — burn() 前置检查', () => {
  beforeAll(() => ensureTmp());

  test('输入文件不存在返回失败', async () => {
    const result = await DanmakuBurner.burn({
      inputPath: tmpPath('nonexistent.mp4'),
      assPath: tmpPath('nonexistent.ass'),
      outputPath: tmpPath('out.mp4'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('输入文件不存在');
  });

  test('ASS 文件不存在返回失败', async () => {
    const input = tmpPath('has_input.mp4');
    createDummyFile(input);

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: tmpPath('no_ass.ass'),
      outputPath: tmpPath('out.mp4'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ASS 文件不存在');
  });

  test('ASS 文件为空事件返回失败', async () => {
    const input = tmpPath('has_input2.mp4');
    const ass = tmpPath('empty.ass');
    createDummyFile(input);
    // Write an ASS file with no events
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'Title: empty',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ].join('\n'),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: tmpPath('out2.mp4'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('无弹幕事件');
  });

  test('输出文件已存在且未 force 返回失败', async () => {
    const input = tmpPath('has_input3.mp4');
    const ass = tmpPath('has_events.ass');
    const output = tmpPath('exists_out.mp4');
    createDummyFile(input);
    createDummyFile(output);
    // Valid ASS with events
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'Title: test',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,弹幕1',
      ].join('\n'),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('已存在');
  });
});

// ============================================================
// 测试组 4: burn() — 成功压制
// ============================================================

describe('DanmakuBurner — burn() 成功', () => {
  beforeAll(() => ensureTmp());

  beforeEach(() => {
    spawn.mockClear();
  });

  test('正常压制返回成功', async () => {
    mockSpawnSuccess();

    const input = tmpPath('burn_ok.mp4');
    const ass = tmpPath('burn_ok.ass');
    const output = tmpPath('burn_ok_danmaku.mp4');

    // Clean up output from previous runs
    try {
      fs.unlinkSync(output);
    } catch (_) {}

    createDummyFile(input);
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'Title: test',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,弹幕',
      ].join('\n'),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toBe(output);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.outputSize).toBeDefined();
    expect(spawn).toHaveBeenCalledTimes(1);

    // Verify correct FFmpeg args passed
    const callArgs = spawn.mock.calls[0];
    expect(callArgs[0]).toBe('ffmpeg');
    expect(callArgs[1]).toContain('-y');
    expect(callArgs[1]).toContain(input);
    expect(callArgs[1]).toContain(output);
    expect(callArgs[2].env.NICE).toBe('10');
  });

  test('使用 QSV 编码', async () => {
    mockSpawnSuccess();

    const input = tmpPath('burn_qsv.mp4');
    const ass = tmpPath('burn_qsv.ass');
    const output = tmpPath('burn_qsv_danmaku.mp4');
    try {
      fs.unlinkSync(output);
    } catch (_) {}

    createDummyFile(input);
    fs.writeFileSync(
      ass,
      [
        '[Script Info]\n',
        '[Events]\n',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,弹幕\n',
      ].join(''),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: true,
      useQsv: true,
    });

    expect(result.success).toBe(true);
    const callArgs = spawn.mock.calls[0];
    expect(callArgs[1]).toContain('h264_qsv');
  });

  test('保留 ASS 文件中的多行弹幕', async () => {
    mockSpawnSuccess();

    const input = tmpPath('burn_multi.mp4');
    const ass = tmpPath('burn_multi.ass');
    const output = tmpPath('burn_multi_danmaku.mp4');
    try {
      fs.unlinkSync(output);
    } catch (_) {}

    createDummyFile(input);
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'Title: test',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,弹幕A',
        'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,弹幕B',
        'Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,弹幕C',
      ].join('\n'),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: true,
    });

    expect(result.success).toBe(true);
  });

  test('ASS 无 [Events] section 返回失败', async () => {
    const input = tmpPath('no_events.mp4');
    const ass = tmpPath('no_events.ass');
    createDummyFile(input);
    fs.writeFileSync(ass, '[Script Info]\nTitle: no events\n', 'utf-8');

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: tmpPath('out3.mp4'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('无弹幕事件');
  });
});

// ============================================================
// 测试组 5: burn() — 失败场景
// ============================================================

describe('DanmakuBurner — burn() 失败', () => {
  beforeAll(() => ensureTmp());

  beforeEach(() => {
    spawn.mockClear();
  });

  test('FFmpeg 非零退出码返回失败', async () => {
    mockSpawnFail(1, 'Error: Invalid data found when processing input');

    const input = tmpPath('burn_fail.mp4');
    const ass = tmpPath('burn_fail.ass');
    const output = tmpPath('burn_fail_danmaku.mp4');
    createDummyFile(input);
    fs.writeFileSync(
      ass,
      [
        '[Script Info]\n',
        '[Events]\n',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,弹幕\n',
      ].join(''),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
      force: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('FFmpeg 退出码 1');
  });

  test('FFmpeg spawn 出错返回失败', async () => {
    spawn.mockImplementation((_cmd, _args, _opts) => {
      const proc = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        killed: false,
        kill: jest.fn(),
      };

      const handlers = {};
      proc.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });

      setImmediate(() => {
        if (handlers.error) handlers.error(new Error('ENOENT: ffmpeg not found'));
      });

      return proc;
    });

    const input = tmpPath('spawn_fail.mp4');
    const ass = tmpPath('spawn_fail.ass');
    const output = tmpPath('spawn_fail_danmaku.mp4');
    createDummyFile(input);
    fs.writeFileSync(
      ass,
      [
        '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,弹幕\n',
      ].join(''),
      'utf-8'
    );

    const result = await DanmakuBurner.burn({
      inputPath: input,
      assPath: ass,
      outputPath: output,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('FFmpeg 启动失败');
  });
});

// ============================================================
// 测试组 6: getVideoDurationMs
// ============================================================

describe('DanmakuBurner — getVideoDurationMs', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  test('正常解析时长', async () => {
    spawn.mockImplementation((_cmd, _args, _opts) => {
      const proc = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      };

      const handlers = {};
      proc.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });

      setImmediate(() => {
        // Simulate stdout
        let stdoutHandler;
        proc.stdout.on.mock.calls.forEach((call) => {
          if (call[0] === 'data') stdoutHandler = call[1];
        });
        if (stdoutHandler) stdoutHandler(Buffer.from('120.5\n'));
        if (handlers.close) handlers.close(0);
      });

      return proc;
    });

    const duration = await DanmakuBurner.getVideoDurationMs('/videos/test.mp4');
    expect(duration).toBe(120500);
  });

  test('ffprobe 失败返回 0', async () => {
    mockSpawnFail(1, 'No such file');

    const duration = await DanmakuBurner.getVideoDurationMs('/videos/nonexistent.mp4');
    expect(duration).toBe(0);
  });
});

// ============================================================
// 测试组 7: estimateTimeout
// ============================================================

describe('DanmakuBurner — estimateTimeout', () => {
  test('超时公式 = max(30min, 时长×4)', async () => {
    // Short video: should use 30min minimum
    const shortMs = await DanmakuBurner.estimateTimeout('/videos/short.mp4');
    // For a short video, estimateTimeout calls getVideoDurationMs which returns 0 (mock failure)
    // 30 * 60 * 1000 = 1800000
    expect(shortMs).toBe(1800000);
  });

  test('长视频超时按 4 倍估算', async () => {
    // We need a special mock for this test
    spawn.mockImplementation((cmd, _args, _opts) => {
      if (cmd === 'ffprobe' || cmd.includes('ffprobe')) {
        const proc = {
          stdout: { on: jest.fn() },
          stderr: { on: jest.fn() },
          on: jest.fn(),
        };
        const handlers = {};
        proc.on.mockImplementation((event, handler) => {
          handlers[event] = handler;
        });
        setImmediate(() => {
          let stdoutHandler;
          proc.stdout.on.mock.calls.forEach((call) => {
            if (call[0] === 'data') stdoutHandler = call[1];
          });
          if (stdoutHandler) stdoutHandler(Buffer.from('3600\n')); // 1 hour
          if (handlers.close) handlers.close(0);
        });
        return proc;
      }
      // Fallback
      const proc = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      };
      proc.on.mockImplementation((e, h) => {
        setImmediate(() => h(0));
      });
      return proc;
    });

    const timeout = await DanmakuBurner.estimateTimeout('/videos/long.mp4');
    // 3600s * 1000 * 4 = 14400000
    expect(timeout).toBe(14400000);
  });
});

// ============================================================
// 测试组 8: probeCapabilities
// ============================================================

describe('DanmakuBurner — probeCapabilities', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  test('检测 FFmpeg 能力', async () => {
    spawn.mockImplementation((_cmd, args, _opts) => {
      const proc = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      };
      const handlers = {};
      proc.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });

      setImmediate(() => {
        if (args.includes('-filters')) {
          let stdoutHandler;
          proc.stdout.on.mock.calls.forEach((call) => {
            if (call[0] === 'data') stdoutHandler = call[1];
          });
          if (stdoutHandler) stdoutHandler(Buffer.from('... subtitles V->V Render subtitles ...\nass V->V ...'));
          if (handlers.close) handlers.close(0);
        } else if (args.includes('-encoders')) {
          let stdoutHandler;
          proc.stdout.on.mock.calls.forEach((call) => {
            if (call[0] === 'data') stdoutHandler = call[1];
          });
          if (stdoutHandler) stdoutHandler(Buffer.from('... libx264 ... h264_qsv ...'));
          if (handlers.close) handlers.close(0);
        } else {
          if (handlers.close) handlers.close(0);
        }
      });

      return proc;
    });

    const caps = await DanmakuBurner.probeCapabilities();
    expect(caps.subtitlesFilter).toBe(true);
    expect(caps.libx264).toBe(true);
    expect(caps.qsvEncoder).toBe(true);
  });

  test('ffmpeg 不可用时返回默认值', async () => {
    spawn.mockImplementation((_cmd, _args, _opts) => {
      const proc = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      };
      const handlers = {};
      proc.on.mockImplementation((event, handler) => {
        handlers[event] = handler;
      });
      setImmediate(() => {
        if (handlers.error) handlers.error(new Error('ENOENT'));
      });
      return proc;
    });

    const caps = await DanmakuBurner.probeCapabilities();
    expect(caps.subtitlesFilter).toBe(false);
    expect(caps.libx264).toBe(false);
  });
});

// ============================================================
// 测试组 9: 自定义 FFmpeg 路径
// ============================================================

describe('DanmakuBurner — 自定义路径', () => {
  const originalPath = process.env.FFMPEG_PATH;
  const originalProbePath = process.env.FFPROBE_PATH;

  afterEach(() => {
    process.env.FFMPEG_PATH = originalPath;
    process.env.FFPROBE_PATH = originalProbePath;
    // Reset module cache
    jest.resetModules();
  });

  test('使用环境变量 FFMPEG_PATH', () => {
    process.env.FFMPEG_PATH = '/usr/local/bin/ffmpeg';
    process.env.FFPROBE_PATH = '/usr/local/bin/ffprobe';

    jest.resetModules();
    jest.doMock('child_process', () => ({ spawn: jest.fn() }));
    const FreshBurner = require('../lib/core/danmaku-burner');

    expect(FreshBurner.ffmpegPath).toBe('/usr/local/bin/ffmpeg');
    expect(FreshBurner.ffprobePath).toBe('/usr/local/bin/ffprobe');
  });
});

// Cleanup: remove temporary test directory
afterAll(() => {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});
