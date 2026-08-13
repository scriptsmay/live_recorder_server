const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dayjs = require('dayjs');

const DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR;

/**
 * 清理文件名中的非法字符
 *
 * @param {string} name - 原始文件名
 * @returns {string} 清理后的文件名
 */
function sanitizeFilename(name) {
  return name
    .replace(/[\\/:\*\?"<>\|\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}
/**
 * 根据模板生成文件名（统一入口）
 *
 * @param {string} template - 文件名模板
 * @param {string} roomName - 房间名称
 * @param {string} ext - 文件扩展名
 * @param {Date|string} date - 时间对象，默认为当前时间
 * @returns {string} 生成的文件名
 */
function generateFilename(template, roomName, ext = '.mp4', date = new Date()) {
  const dateObj = dayjs(date);
  const vars = {
    room_name: sanitizeFilename(roomName || 'unknown'),
    datetime: dateObj.format('YYYYMMDD_HHmmss'),
    YYYY: dateObj.format('YYYY'),
    MM: dateObj.format('MM'),
    DD: dateObj.format('DD'),
    HH: dateObj.format('HH'),
    mm: dateObj.format('mm'),
    ss: dateObj.format('ss'),
  };
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return sanitizeFilename(result) + ext;
}

/**
 * 将模板转换为 strftime 格式
 *
 * @param {string} template - 文件名模板
 * @param {string} roomName - 房间名称
 * @param {string} ext - 文件扩展名
 * @returns {string} strftime 格式的路径
 */
function templateToStrftime(template, roomName, ext = '.mp4') {
  const roomNameSafe = sanitizeFilename(roomName || 'unknown').replace(/%/g, '%%');
  return (
    template
      .replace(/{room_name}/g, roomNameSafe)
      .replace(/{datetime}/g, '%Y%m%d_%H%M%S')
      .replace(/{YYYY}/g, '%Y')
      .replace(/{MM}/g, '%m')
      .replace(/{DD}/g, '%d')
      .replace(/{HH}/g, '%H')
      .replace(/{mm}/g, '%M')
      .replace(/{ss}/g, '%S') + ext
  );
}

/**
 * 生成输出文件路径
 *
 * 路径结构：VIDEO_DOWNLOAD_DIR/[sessionId]/[filename]
 *
 * @param {Object} downloader - 下载器实例
 * @param {string} template - 文件名模板，默认 '{room_name}_{datetime}'
 * @param {string} roomName - 房间名称
 * @param {string} title - 直播标题
 * @param {number} segmentDuration - 分段时长（秒）
 * @param {boolean} _reuseSession - 是否复用会话（预留参数）
 * @param {string|number} sessionId - 会话ID（可选，用于生成目录路径）
 * @returns {string} 输出文件路径
 */
function generateOutputPath(
  downloader,
  template = '{room_name}_{datetime}',
  roomName,
  title,
  segmentDuration,
  _reuseSession,
  sessionId = null
) {
  // useSegment 代表的是输出文件名是否会随时间变量变化
  // 有的下载器不支持分段下载， useSegment 为 false
  const useSegment = segmentDuration > 0 && downloader.isSegment();
  const ext = downloader.getExtension();

  let outputFilePattern;
  let baseDir = DOWNLOAD_DIR;

  // 如果提供了 sessionId，构建会话目录
  if (sessionId) {
    baseDir = path.join(DOWNLOAD_DIR, String(sessionId));
  }

  if (useSegment) {
    // 如果需要切片，则输出文件名使用ffmpeg segements 模板
    const strftimeName = templateToStrftime(template, roomName || title, ext);
    outputFilePattern = path.join(baseDir, strftimeName);
  } else {
    // 如果不切片，则使用 generateFilename 方法生成固定的文件名
    const filename = generateFilename(template, roomName || title, ext);
    outputFilePattern = path.join(baseDir, filename);
  }

  return outputFilePattern;
}

/**
 * 弹幕数据集中目录名（VIDEO_DOWNLOAD_DIR 下的保留目录名）
 *
 * 该目录与会话目录同级。sessionId 为 SERIAL 整数，不会与此名冲突，
 * 但文件扫描逻辑必须显式跳过该目录，否则会被判定为孤儿会话目录。
 */
const DANMAKU_DIR_NAME = 'danmaku';

/**
 * 生成弹幕 JSONL 文件路径（唯一入口）
 *
 * 路径结构：VIDEO_DOWNLOAD_DIR/danmaku/[sessionId].jsonl
 *
 * v1.8.0 起弹幕数据集中扁平存放，不再放在会话目录的 danmaku/ 子目录下。
 * 业务代码禁止自行 path.join 拼接弹幕路径，一律走本函数。
 *
 * @param {string|number} sessionId - 录制会话 ID
 * @returns {string} 弹幕 JSONL 绝对路径
 */
function getDanmakuJsonlPath(sessionId) {
  if (sessionId === null || sessionId === undefined || sessionId === '') {
    throw new Error('getDanmakuJsonlPath: sessionId 不能为空');
  }
  const downloadDir = process.env.VIDEO_DOWNLOAD_DIR;
  if (!downloadDir) {
    throw new Error('getDanmakuJsonlPath: 环境变量 VIDEO_DOWNLOAD_DIR 未配置');
  }
  return path.join(downloadDir, DANMAKU_DIR_NAME, `${sessionId}.jsonl`);
}

/**
 * 获取弹幕数据集中目录
 *
 * 与 `getDanmakuJsonlPath()` 的差异：本函数用于展示/统计场景（如文件管理概览），
 * 缺少环境变量时沿用仓库既有约定回落到 `/data/video_downloads`（同 `path-safety.js`
 * 的 ALLOWLIST_ROOTS 写法），不抛错；写入路径则必须显式配置，故那边严格校验。
 *
 * @returns {string} VIDEO_DOWNLOAD_DIR/danmaku 绝对路径
 */
function getDanmakuDir() {
  const downloadDir = process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads';
  return path.join(downloadDir, DANMAKU_DIR_NAME);
}

/**
 * 孤儿弹幕目录名（下划线前缀，显式区别于 sessionId 命名的正常 JSONL）
 *
 * `danmaku/` 目录下除 `_orphan/` 外全是 `{sessionId}.jsonl`。下划线前缀让
 * scan-files 与 danmaku-tool 的批量扫描能一眼跳过，无需维护白名单。
 */
const ORPHAN_DIR_NAME = '_orphan';

/** 人工丢弃的孤儿弹幕归档目录名（只移动不硬删，保留最坏兜底） */
const DISCARDED_DIR_NAME = '_discarded';

/**
 * 计算 roomUrl 的短哈希（孤儿弹幕文件名用）
 *
 * roomUrl 含 `:` `/` `?` 等非法文件名字符，且长度可达 512。取 sha1 前 12 位
 * 十六进制（48 bit）足够避免个位数量级房间的碰撞，同时保持文件名可读。
 *
 * @param {string} roomUrl - 直播间 URL
 * @returns {string} 12 位十六进制哈希
 */
function hashRoomUrl(roomUrl) {
  if (!roomUrl) {
    throw new Error('hashRoomUrl: roomUrl 不能为空');
  }
  return crypto.createHash('sha1').update(String(roomUrl)).digest('hex').slice(0, 12);
}

/**
 * 获取孤儿弹幕根目录
 *
 * @returns {string} VIDEO_DOWNLOAD_DIR/danmaku/_orphan 绝对路径
 */
function getOrphanDanmakuDir() {
  return path.join(getDanmakuDir(), ORPHAN_DIR_NAME);
}

/**
 * 获取人工丢弃的孤儿弹幕归档目录
 *
 * @returns {string} VIDEO_DOWNLOAD_DIR/danmaku/_discarded 绝对路径
 */
function getDiscardedOrphanDanmakuDir() {
  return path.join(getDanmakuDir(), DISCARDED_DIR_NAME);
}

/**
 * 生成孤儿弹幕 JSONL 文件路径（唯一入口）
 *
 * 路径结构：VIDEO_DOWNLOAD_DIR/danmaku/_orphan/{YYYY-MM-DD}/{roomUrlHash}.jsonl
 *
 * 按天分片避免单文件无限增长；同一天同一房间的多个批次追加到同一文件。
 * 业务代码禁止自行 path.join 拼接孤儿弹幕路径，一律走本函数。
 *
 * @param {string} roomUrl - 直播间 URL
 * @param {Date|string|number} [date] - 归档日期，默认当前时间
 * @returns {string} 孤儿弹幕 JSONL 绝对路径
 */
function getOrphanDanmakuPath(roomUrl, date = new Date()) {
  const downloadDir = process.env.VIDEO_DOWNLOAD_DIR;
  if (!downloadDir) {
    throw new Error('getOrphanDanmakuPath: 环境变量 VIDEO_DOWNLOAD_DIR 未配置');
  }
  const day = dayjs(date).format('YYYY-MM-DD');
  return path.join(downloadDir, DANMAKU_DIR_NAME, ORPHAN_DIR_NAME, day, `${hashRoomUrl(roomUrl)}.jsonl`);
}

/**
 * 解析 JSONL 文本内容，跳过空行与畸形行，只返回合法的对象行
 *
 * 弹幕 JSONL 是"人可编辑"的落盘格式（人工审阅、手动拼接孤儿文件都会发生），
 * 因此单行 JSON 可能是 `null` / 数字 / 字符串等非对象值。调用方几乎总是直接访问
 * `ev.ts_abs_ms` 之类的属性，所以在这里就统一过滤掉非对象行，避免各调用方各写一遍守卫。
 *
 * 与 `readJsonlLines` 的分工：本函数只做解析，不碰 IO，供已经异步拿到内容的
 * 调用方（如 HTTP 处理器用 fs.promises.readFile）复用，避免为了复用而把异步读退化成同步读。
 *
 * @param {string} content - JSONL 文本
 * @param {Object} [options]
 * @param {boolean} [options.skipMeta=true] - 跳过 `_meta` 元信息行
 * @param {number} [options.tailLines] - 只解析尾部 N 行（缺省解析全部）
 * @returns {Array<Object>} 合法对象数组
 */
function parseJsonlContent(content, options = {}) {
  const { skipMeta = true, tailLines } = options;
  let lines = String(content || '').split('\n');
  if (tailLines > 0 && lines.length > tailLines) {
    lines = lines.slice(lines.length - tailLines);
  }
  const items = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    // 非对象行（null / 数字 / 字符串 / 数组）一律丢弃：调用方按对象取属性
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      continue;
    }
    if (skipMeta && obj._meta) {
      continue;
    }
    items.push(obj);
  }
  return items;
}

/**
 * 同步读取并解析 JSONL 文件（`parseJsonlContent` 的 IO 包装）
 *
 * @param {string} filePath - JSONL 文件路径
 * @param {Object} [options] - 同 `parseJsonlContent`
 * @returns {Array<Object>} 合法对象数组；文件不存在或读取失败时返回空数组
 */
function readJsonlLines(filePath, options = {}) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return [];
  }
  return parseJsonlContent(content, options);
}

module.exports = {
  generateFilename,
  templateToStrftime,
  sanitizeFilename,
  generateOutputPath,
  getDanmakuJsonlPath,
  getDanmakuDir,
  getOrphanDanmakuDir,
  getOrphanDanmakuPath,
  getDiscardedOrphanDanmakuDir,
  hashRoomUrl,
  parseJsonlContent,
  readJsonlLines,
  DANMAKU_DIR_NAME,
  ORPHAN_DIR_NAME,
  DISCARDED_DIR_NAME,
};
