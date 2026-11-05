const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createProcLog } = require('../utils/proc-log');

// copy 转码只需重封装，几秒到几十秒即可；重编码（HEVC→H.264）是 CPU 密集操作，
// 长时间直播可达数倍文件时长，需要独立的、宽松的超时上限。
const COPY_TIMEOUT_MS = 120000;
const REENCODE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 小时

const PROBE_TIMEOUT_MS = 30000;

/**
 * 转码器类，提供视频文件的快速转码功能
 * 默认使用 FFmpeg 无损复制转码（TS→MP4，faststart）；当输入视频轨为 HEVC/H.265 时，
 * 按需重编码为 H.264（libx264 + AAC），保证浏览器可播、B 站可投稿。
 */
class Transcoder {
  constructor() {
    this.name = 'transcoder';
  }

  /**
   * 探测输入文件首个视频流的编码名称。
   * ffprobe 读本地文件，仅解析头部，失败或非视频一律返回 null（由调用方回退 copy）。
   *
   * @param {string} inputPath
   * @returns {Promise<string|null>} codec_name 小写（如 'h264' / 'hevc'），探测失败返回 null
   */
  probeVideoCodec(inputPath) {
    return new Promise((resolve) => {
      let settled = false;
      let proc = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        finish(null);
        try {
          proc?.kill('SIGKILL');
        } catch (_) {}
      }, PROBE_TIMEOUT_MS);

      try {
        proc = spawn(
          'ffprobe',
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'json', inputPath],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (_) {
        return finish(null);
      }

      let stdout = '';
      proc.stdout.on('data', (chunk) => {
        if (stdout.length < 10240) stdout += chunk;
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        if (code !== 0) return finish(null);
        try {
          const json = JSON.parse(stdout);
          const codec = json?.streams?.[0]?.codec_name;
          finish(typeof codec === 'string' ? codec.toLowerCase() : null);
        } catch (_) {
          finish(null);
        }
      });
    });
  }

  /**
   * 构建转码参数。HEVC 输入走重编码（libx264 + AAC），其余走 copy 无损重封装。
   *
   * @param {string} inputPath
   * @param {string} outputPath
   * @param {boolean} shouldReencode
   * @returns {string[]}
   */
  _buildArgs(inputPath, outputPath, shouldReencode) {
    if (shouldReencode) {
      return [
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ];
    }
    return ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];
  }

  /**
   * 执行快速转码操作。
   * 默认对 HEVC 输入重编码为 H.264（可经 options.reencodeHevc 关闭回退到 copy），
   * 其余编码保持无损 copy 并添加 faststart 标志优化 MP4 流式播放。
   * inputPath === outputPath 时按原地覆盖处理：先写临时文件，成功后原子替换，
   * 避免 ffmpeg 在读取输入的同时截断同一路径。
   *
   * @param {string} inputPath - 输入视频文件的完整路径
   * @param {string} outputPath - 输出视频文件的完整路径
   * @param {string|null} sessionId - 会话ID，用于日志追踪和归档，可选参数
   * @param {Object} [options]
   * @param {boolean} [options.reencodeHevc=true] - HEVC 输入是否重编码为 H.264
   * @returns {Promise<Object>} 返回转码结果的 Promise 对象
   * @returns {boolean} return.success - 转码是否成功
   * @returns {string} [return.outputPath] - 成功时返回输出文件路径
   * @returns {number} [return.outputSize] - 成功时返回输出文件大小（字节）
   * @returns {boolean} [return.reencoded] - 是否执行了重编码（HEVC→H.264）
   * @returns {string} [return.error] - 失败时返回错误信息
   * @returns {string} return.logPath - 始终返回日志文件路径
   */
  async fastTranscode(inputPath, outputPath, sessionId = null, options = {}) {
    const { reencodeHevc = true } = options;

    let inputCodec = null;
    if (reencodeHevc) {
      inputCodec = await this.probeVideoCodec(inputPath);
    }

    const shouldReencode = inputCodec === 'hevc' || inputCodec === 'h265';
    if (shouldReencode) {
      console.log(`[转码] 检测到 HEVC 视频轨，重编码为 H.264: ${path.basename(inputPath)}`);
    }

    const isInPlace = path.resolve(inputPath) === path.resolve(outputPath);
    const tmpOutputPath = isInPlace ? `${outputPath}.reencode.tmp` : outputPath;

    const args = this._buildArgs(inputPath, tmpOutputPath, shouldReencode);
    const timeoutMs = shouldReencode ? REENCODE_TIMEOUT_MS : COPY_TIMEOUT_MS;

    return new Promise((resolve) => {
      const procLog = createProcLog('transcode', sessionId);
      const { stream, logCommand } = procLog;
      logCommand('ffmpeg', args);

      const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => stream.write(chunk));
      }

      let settled = false;
      let timeoutTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        procLog.destroy();
        resolve(value);
      };

      proc.on('close', (code) => {
        if (code === 0) {
          if (isInPlace) {
            try {
              fs.renameSync(tmpOutputPath, outputPath);
            } catch (err) {
              finish({
                success: false,
                error: `Fast transcode rename failed: ${err.message}`,
                logPath: procLog.logPath,
              });
              return;
            }
          }
          let outputSize = 0;
          try {
            outputSize = fs.statSync(outputPath).size;
          } catch (_) {}
          finish({ success: true, outputPath, outputSize, reencoded: shouldReencode, logPath: procLog.logPath });
        } else {
          if (isInPlace) {
            try {
              fs.unlinkSync(tmpOutputPath);
            } catch (_) {}
          }
          finish({
            success: false,
            error: `Fast transcode failed with code ${code}`,
            logPath: procLog.logPath,
          });
        }
      });

      // 设置超时保护，防止转码过程卡死
      timeoutTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
          finish({ success: false, error: 'Fast transcode timeout' });
        }
      }, timeoutMs);
    });
  }

  /**
   * 探测输入流/文件是否存在可识别的视频轨，供录制前防御性预检使用。
   *
   * 背景：小红书 HEVC 档位用 FLV 封装 HEVC（视频 codec tag 0x0c=12），ffmpeg 官方
   * 从不支持，录制时 ffprobe 会报 `Video codec (c) is not implemented` 且只识别出音频流，
   * 最终成品丢失视频轨。录制前探测可识别这种情况并拒绝，避免产出无画面废文件。
   *
   * 探测失败（超时 / spawn 失败 / JSON 解析失败）一律按「有视频轨」放行，
   * 避免因网络抖动误伤正常录制。
   *
   * @param {string} inputPath - 直播流 URL 或本地文件路径
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=20000] - 探测超时（毫秒）
   * @returns {Promise<{hasVideo: boolean, videoCodec: string|null, error: string|null}>}
   *   - hasVideo=true 且 error=null 表示探测到可直接录制的视频轨
   *   - hasVideo=true 且 error='flv-hevc-unrecordable' 表示 FLV 封装的 HEVC（新版 ffmpeg 可识别，优先尝试降级）
   *   - hasVideo=true 且 error='probe-timeout'|'spawn-failed'|'proc-error'|'parse-failed' 表示探测失败放行
   *   - hasVideo=false 且 error='flv-hevc-not-implemented' 表示 FLV HEVC（旧版 ffmpeg 不认识，丢视频轨）
   *   - hasVideo=false 且 error='no-video-stream' 表示流中无视频轨
   */
  probeVideoTrack(inputPath, options = {}) {
    const { timeoutMs = 20000 } = options;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let proc = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        try {
          proc?.kill('SIGKILL');
        } catch (_) {}
        finish({ hasVideo: true, videoCodec: null, error: 'probe-timeout' });
      }, timeoutMs);

      try {
        proc = spawn(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name',
            '-of',
            'json',
            '-analyzeduration',
            '8000000',
            '-probesize',
            '8000000',
            inputPath,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (_) {
        return finish({ hasVideo: true, videoCodec: null, error: 'spawn-failed' });
      }

      proc.stdout.on('data', (chunk) => {
        if (stdout.length < 10240) stdout += chunk;
      });
      proc.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      proc.on('error', () => finish({ hasVideo: true, videoCodec: null, error: 'proc-error' }));
      proc.on('close', () => {
        try {
          const json = JSON.parse(stdout);
          const video = (json?.streams || []).find((s) => s.codec_type === 'video');
          if (video) {
            const videoCodec = typeof video.codec_name === 'string' ? video.codec_name.toLowerCase() : null;
            // FLV 封装的 HEVC（小红书 _hcv 档位，codec tag 0x0c）：
            // 旧版 ffmpeg（如生产 7.1.5）的 flv demuxer 不认识，录出来只有音频；
            // 新版 ffmpeg（如 9.x）能识别并用 -c copy 录出 HEVC，但浏览器/B 站仍无法解码。
            // 两种情况下 FLV 主流都不适合直接录制，一律标记需降级（按编码判定，与
            // ffmpeg 版本解耦）。m3u8/TS 封装的 HEVC 用标准 stream_type，由转码链路
            // 负责转 H.264，这里不拦截。
            if ((videoCodec === 'hevc' || videoCodec === 'h265') && /\.flv(\?|$)/i.test(inputPath)) {
              return finish({ hasVideo: true, videoCodec, error: 'flv-hevc-unrecordable' });
            }
            return finish({ hasVideo: true, videoCodec, error: null });
          }
          const reason = /not implemented/i.test(stderr) ? 'flv-hevc-not-implemented' : 'no-video-stream';
          finish({ hasVideo: false, videoCodec: null, error: reason });
        } catch (_) {
          finish({ hasVideo: true, videoCodec: null, error: 'parse-failed' });
        }
      });
    });
  }
}

module.exports = new Transcoder();
