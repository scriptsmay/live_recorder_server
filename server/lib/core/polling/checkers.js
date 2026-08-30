const HuyaChecker = require('./HuyaChecker');
const BilibiliChecker = require('./BilibiliChecker');
const DouyuChecker = require('./DouyuChecker');
const DouyinChecker = require('./DouyinChecker');
const KuaishouAPIChecker = require('./KuaishouAPIChecker');

const { createModuleLogger } = require('../logger');

const log = createModuleLogger('polling');

// 封面自取整体超时兜底：底层 checker 用裸 fetch 无超时，平台 API 挂起时不能阻塞录制启动
const COVER_FETCH_TIMEOUT_MS = 10000;

const CHECKERS = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
  kuaishou: KuaishouAPIChecker,
};

/**
 * 按房间 URL 解析对应平台的 Checker 类（遍历各 checker 的 canHandleUrl）
 *
 * @param {string} url - 房间 URL
 * @returns {class|null} 匹配的 Checker 类，无匹配返回 null
 */
function resolveCheckerByUrl(url) {
  if (!url) return null;
  for (const Checker of Object.values(CHECKERS)) {
    if (Checker.canHandleUrl(url)) {
      return Checker;
    }
  }
  return null;
}

/**
 * 按房间 URL 自取直播间封面（best-effort 兜底）
 *
 * 用于 API 触发录制但调用方未传 cover_url 的场景：反查一次平台状态取 roomCover。
 * 整体带 COVER_FETCH_TIMEOUT_MS 超时兜底（部分 checker 底层是裸 fetch，无请求超时）。
 * 任何失败（无匹配 checker / 接口报错 / 超时 / 状态无封面）都只告警并返回空串，
 * 调用方（录制启动）不应因此中断。
 *
 * @param {string} url - 房间 URL
 * @returns {Promise<string>} 封面 URL，失败为空串
 */
async function fetchRoomCoverByUrl(url) {
  try {
    const Checker = resolveCheckerByUrl(url);
    if (!Checker) {
      log.warn(`[封面自取] 未找到支持的平台 checker: ${url}`);
      return '';
    }
    const checker = new Checker(url);
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`封面自取超时(${COVER_FETCH_TIMEOUT_MS / 1000}s)`)),
        COVER_FETCH_TIMEOUT_MS
      );
      checker.checkStatus().then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
    const cover = status?.roomCover || '';
    if (cover) {
      log.info(`[封面自取] ${url} 获取成功: ${cover.slice(0, 100)}`);
    }
    return cover;
  } catch (err) {
    log.warn(`[封面自取] ${url} 获取失败（不影响录制）: ${err.message}`);
    return '';
  }
}

module.exports = {
  ...CHECKERS,
  resolveCheckerByUrl,
  fetchRoomCoverByUrl,
};
