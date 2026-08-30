/**
 * STT (Serialized Text Transfer) — 斗鱼纯文本序列化编解码
 * 移植自 biliup `codec/stt.rs`。
 *
 * 格式：key@=value/ 键值对，`/` 分隔；转义：@A → @、@S → /。
 * 含 `/` 的输入解析为 Map（多项 key@=value）或 List（无 @= 的多项），
 * 单项无 `/` 时递归：含 `@=` 解析为 {key: value}，否则为转义字符串。
 */

/** @S/@A 转义还原 */
function decodeString(s) {
  return String(s).replaceAll('@S', '/').replaceAll('@A', '@');
}

/** @ → @A、/ → @S 转义 */
function encodeString(s) {
  return String(s).replaceAll('@', '@A').replaceAll('/', '@S');
}

/**
 * 解码 STT 文本。返回 string | Object | string[]（与 biliup SttValue 对应）。
 * @param {string} input
 * @returns {string|Object|string[]}
 */
function decode(input) {
  if (input.includes('/')) {
    const items = input.split('/').filter((s) => s !== '');
    const dict = {};
    const list = [];
    for (const item of items) {
      const decoded = decode(item);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        Object.assign(dict, decoded);
      } else {
        list.push(decoded);
      }
    }
    return list.length > 0 ? list : dict;
  }
  if (input.includes('@=')) {
    const idx = input.indexOf('@=');
    const key = decodeString(input.slice(0, idx));
    const value = decode(input.slice(idx + 2));
    return { [key]: value };
  }
  return decodeString(input);
}

/**
 * 顶层取字符串字段（Map 值为 string 时返回）。
 * @param {string|Object|string[]} decoded - decode() 的返回值
 * @param {string} key
 * @returns {string|null}
 */
function getStr(decoded, key) {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const v = decoded[key];
  return typeof v === 'string' ? v : null;
}

module.exports = { decode, encodeString, decodeString, getStr };
