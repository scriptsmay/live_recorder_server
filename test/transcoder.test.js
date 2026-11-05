// 转码器：HEVC 输入重编码 H.264、copy 路径、探测回退
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../server/lib/utils/proc-log', () => ({
  createProcLog: jest.fn(() => ({
    stream: { write: jest.fn() },
    logPath: '/tmp/fake-transcode.log',
    rename: jest.fn(),
    logCommand: jest.fn(),
    destroy: jest.fn(),
  })),
}));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const transcoder = require('../server/lib/core/transcoder');

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function emitLater(child, code) {
  setImmediate(() => child.emit('close', code));
}

/** 依次 mock ffprobe（探测 codec）+ ffmpeg（转码）。 */
function mockProbeThenTranscode({ codec = 'h264', probeCode = 0, transcodeCode = 0, probeError = null } = {}) {
  const probeChild = makeChild();
  const ffmpegChild = makeChild();

  spawn
    .mockImplementationOnce(() => {
      setImmediate(() => {
        if (probeError) {
          probeChild.emit('error', probeError);
          return;
        }
        if (probeCode !== 0) {
          probeChild.emit('close', probeCode);
          return;
        }
        probeChild.stdout.emit('data', Buffer.from(JSON.stringify({ streams: [{ codec_name: codec }] })));
        probeChild.emit('close', 0);
      });
      return probeChild;
    })
    .mockImplementationOnce(() => {
      emitLater(ffmpegChild, transcodeCode);
      return ffmpegChild;
    });

  return { probeChild, ffmpegChild };
}

describe('transcoder.probeVideoCodec', () => {
  beforeEach(() => spawn.mockReset());

  test('解析 ffprobe 输出返回小写 codec', async () => {
    const child = makeChild();
    spawn.mockImplementationOnce(() => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ streams: [{ codec_name: 'HEVC' }] })));
        child.emit('close', 0);
      });
      return child;
    });

    await expect(transcoder.probeVideoCodec('/x.ts')).resolves.toBe('hevc');
  });

  test('ffprobe 非 0 退出返回 null', async () => {
    const child = makeChild();
    spawn.mockImplementationOnce(() => {
      emitLater(child, 1);
      return child;
    });

    await expect(transcoder.probeVideoCodec('/x.ts')).resolves.toBeNull();
  });

  test('无视频流返回 null', async () => {
    const child = makeChild();
    spawn.mockImplementationOnce(() => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ streams: [] })));
        child.emit('close', 0);
      });
      return child;
    });

    await expect(transcoder.probeVideoCodec('/x.ts')).resolves.toBeNull();
  });

  test('ffprobe 不可用返回 null', async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error('spawn ffprobe ENOENT');
    });

    await expect(transcoder.probeVideoCodec('/x.ts')).resolves.toBeNull();
  });
});

describe('transcoder.fastTranscode', () => {
  beforeEach(() => spawn.mockReset());

  test('HEVC 输入重编码为 H.264', async () => {
    mockProbeThenTranscode({ codec: 'hevc', transcodeCode: 0 });

    const result = await transcoder.fastTranscode('/in.ts', '/out.mp4', '42');

    expect(result).toMatchObject({ success: true, reencoded: true, outputPath: '/out.mp4' });
    const ffmpegArgs = spawn.mock.calls[1][1];
    expect(ffmpegArgs).toContain('libx264');
    expect(ffmpegArgs).toContain('aac');
    expect(ffmpegArgs).not.toContain('copy');
  });

  test('H.264 输入保持 copy 不重编码', async () => {
    mockProbeThenTranscode({ codec: 'h264', transcodeCode: 0 });

    const result = await transcoder.fastTranscode('/in.ts', '/out.mp4', '42');

    expect(result).toMatchObject({ success: true, reencoded: false });
    const ffmpegArgs = spawn.mock.calls[1][1];
    expect(ffmpegArgs).toContain('copy');
    expect(ffmpegArgs).not.toContain('libx264');
  });

  test('reencodeHevc=false 时跳过探测，HEVC 也走 copy', async () => {
    const ffmpegChild = makeChild();
    spawn.mockImplementationOnce(() => {
      emitLater(ffmpegChild, 0);
      return ffmpegChild;
    });

    const result = await transcoder.fastTranscode('/in.ts', '/out.mp4', '42', { reencodeHevc: false });

    expect(result).toMatchObject({ success: true, reencoded: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    const ffmpegArgs = spawn.mock.calls[0][1];
    expect(ffmpegArgs).toContain('copy');
    expect(ffmpegArgs).not.toContain('libx264');
  });

  test('探测失败回退 copy', async () => {
    mockProbeThenTranscode({ probeCode: 1, transcodeCode: 0 });

    const result = await transcoder.fastTranscode('/in.ts', '/out.mp4', '42');

    expect(result).toMatchObject({ success: true, reencoded: false });
    const ffmpegArgs = spawn.mock.calls[1][1];
    expect(ffmpegArgs).toContain('copy');
  });

  test('转码失败返回 success false', async () => {
    mockProbeThenTranscode({ codec: 'h264', transcodeCode: 1 });

    const result = await transcoder.fastTranscode('/in.ts', '/out.mp4', '42');

    expect(result.success).toBe(false);
    expect(result.error).toContain('code 1');
  });

  test('原地覆盖（重新转码同一文件）先写临时文件再原子替换', async () => {
    mockProbeThenTranscode({ codec: 'hevc', transcodeCode: 0 });
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {});
    const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 2048 });

    const result = await transcoder.fastTranscode('/in.mp4', '/in.mp4', '42');

    expect(result).toMatchObject({ success: true, reencoded: true, outputPath: '/in.mp4', outputSize: 2048 });
    const ffmpegArgs = spawn.mock.calls[1][1];
    expect(ffmpegArgs).toContain('/in.mp4.reencode.tmp');
    expect(renameSpy).toHaveBeenCalledWith('/in.mp4.reencode.tmp', '/in.mp4');

    renameSpy.mockRestore();
    statSpy.mockRestore();
  });
});
