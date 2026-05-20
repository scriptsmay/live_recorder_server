const path = require('path');
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
 * @param {Object} downloader - 下载器实例
 * @param {string} template - 文件名模板，默认 '{room_name}_{datetime}'
 * @param {string} roomName - 房间名称
 * @param {string} title - 直播标题
 * @param {number} segmentDuration - 分段时长（秒）
 * @param {boolean} _reuseSession - 是否复用会话（预留参数）
 * @param {string} _roomOutputPath - 房间输出路径（预留参数）
 * @returns {string} 输出文件路径
 */
function generateOutputPath(
  downloader,
  template = '{room_name}_{datetime}',
  roomName,
  title,
  segmentDuration,
  _reuseSession,
  _roomOutputPath
) {
  // useSegment 代表的是输出文件名是否会随时间变量变化
  // 有的下载器不支持分段下载， useSegment 为 false
  const useSegment = segmentDuration > 0 && downloader.isSegment();
  const ext = downloader.getExtension();

  let outputFilePattern;

  if (useSegment) {
    // 如果需要切片，则输出文件名使用ffmpeg segements 模板
    const strftimeName = templateToStrftime(template, roomName || title, ext);
    outputFilePattern = path.join(DOWNLOAD_DIR, strftimeName);
  } else {
    // 如果不切片，则使用 generateFilename 方法生成固定的文件名
    const filename = generateFilename(template, roomName || title, ext);
    outputFilePattern = path.join(DOWNLOAD_DIR, filename);
  }

  return outputFilePattern;
}

module.exports = {
  generateFilename,
  templateToStrftime,
  sanitizeFilename,
  generateOutputPath,
};
