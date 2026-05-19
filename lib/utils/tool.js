const dayjs = require('dayjs');

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
 * 将格式字符串转换为具体时间
 * @param {string} template - 例如 '%Y%m%d_%H%M%S'
 * @param {Date} date - 要格式化的时间对象，默认为当前时间
 */
function formatTime(template, date = new Date(), options = {}) {
  const { roomName, ext = '.mp4' } = options;
  const targetDate = dayjs(date);
  const vars = {
    room_name: sanitizeFilename(roomName || 'unknown'),
    datetime: targetDate.format('YYYYMMDD_HHmmss'),
    YYYY: targetDate.format('YYYY'),
    MM: targetDate.format('MM'),
    DD: targetDate.format('DD'),
    HH: targetDate.format('HH'),
    mm: targetDate.format('mm'),
    ss: targetDate.format('ss'),
  };
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return sanitizeFilename(result) + ext;
}

/**
 * 根据模板生成文件名
 *
 * @param {string} template - 文件名模板
 * @param {string} roomName - 房间名称
 * @param {string} ext - 文件扩展名
 * @param {Date|string} date - 时间对象，或dayjs支持解析的时间格式，默认为当前时间
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

module.exports = {
  formatTime,
  generateFilename,
  templateToStrftime,
  sanitizeFilename,
};
