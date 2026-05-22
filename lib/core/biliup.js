const { spawn } = require('child_process');
const fs = require('fs');
const { createProcLog } = require('../utils/proc-log');

/**
 * Biliup 上传器类，封装 biliup 工具的视频上传功能
 * 负责将录制的视频文件上传到 Bilibili
 */
class Biliup {
  constructor() {
    this.name = 'biliup';
  }

  /**
   * 执行视频上传操作
   * 使用 biliup 工具将视频文件上传到 Bilibili
   *
   * @param {Object} options - 上传配置选项
   * @param {string} options.cookiesPath - B站 cookies 文件路径
   * @param {string[]} options.files - 要上传的视频文件路径数组
   * @param {string} options.title - 视频标题
   * @param {string} [options.desc=''] - 视频描述
   * @param {string} [options.tags=''] - 视频标签，逗号分隔
   * @param {string} [options.source=''] - 视频来源
   * @param {number} [options.tid] - 分区ID
   * @param {number} [options.copyright] - 版权声明
   * @param {boolean} [options.isOnlySelf] - 是否仅自己可见
   * @param {string} [options.cover] - 封面图片路径
   * @param {number} [options.dtime] - 定时发布时间（时间戳）
   * @param {string|null} [options.recordId=null] - 上传记录ID，用于日志追踪
   * @returns {Promise<Object>} 返回上传结果的 Promise 对象
   * @returns {boolean} return.success - 上传是否成功
   * @returns {string} [return.bvId] - 成功时返回 BV 号
   * @returns {string} [return.output] - 完整的 biliup 输出
   * @returns {string} [return.error] - 失败时返回错误信息
   * @returns {string} return.logPath - 始终返回日志文件路径
   */
  async upload({
    cookiesPath,
    files,
    title,
    desc = '',
    tags = '',
    source = '',
    tid,
    copyright,
    isOnlySelf,
    cover,
    dtime,
    recordId = null,
  }) {
    return new Promise((resolve) => {
      const biliupPath = process.env.BILIUP_PATH || 'biliup';
      const args = ['-u', cookiesPath, 'upload'];

      if (title) args.push('--title', title);
      if (desc) args.push(`--desc=${desc}`);
      if (tags) args.push('--tag', tags);
      if (source) args.push('--source', source);
      if (tid) args.push('--tid', String(tid));
      if (copyright) args.push('--copyright', String(copyright));
      if (isOnlySelf) args.push('--is-only-self', String(isOnlySelf));
      if (cover) args.push('--cover', cover);
      if (dtime) args.push('--dtime', String(dtime));

      args.push(...files);

      const uploadCwd = process.env.BILIUP_WORK_DIR || process.env.HOME || '.';
      fs.mkdirSync(uploadCwd, { recursive: true });

      const procLog = createProcLog('biliup', recordId);
      const { stream: logStream, logCommand } = procLog;
      logCommand(biliupPath, args);

      const proc = spawn(biliupPath, args, {
        cwd: uploadCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let output = '';

      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => {
          const s = chunk.toString();
          output += s;
          logStream.write(s);
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          const s = chunk.toString();
          output += s;
          logStream.write(s);
        });
      }

      proc.on('error', () => {
        procLog.destroy();
        resolve({
          success: false,
          error: '进程启动失败',
          output,
          logPath: procLog.logPath,
        });
      });

      proc.on('close', (code) => {
        procLog.destroy();
        const bvMatch = output.match(/BV[0-9A-Za-z]{10}/);
        const bvId = bvMatch ? bvMatch[0] : '';

        if (code === 0) {
          resolve({
            success: true,
            bvId,
            output,
            logPath: procLog.logPath,
          });
        } else {
          resolve({
            success: false,
            error: `exit code ${code}`,
            output,
            logPath: procLog.logPath,
          });
        }
      });
    });
  }
}

module.exports = new Biliup();
