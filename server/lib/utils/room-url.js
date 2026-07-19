'use strict';

/**
 * Return the stable part of a live-room URL used as the room identifier.
 * Share links often append tracking parameters that must not create a new room.
 *
 * @param {*} roomUrl
 * @returns {*}
 */
function normalizeRoomUrl(roomUrl) {
  if (typeof roomUrl !== 'string') return roomUrl;

  const trimmed = roomUrl.trim();

  // Douyin also supports a query-only room identifier. Keep that identity
  // parameter while discarding unrelated share/tracking parameters.
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com')) &&
      parsed.pathname === '/' &&
      parsed.searchParams.has('web_rid')
    ) {
      return `${parsed.origin}/?web_rid=${encodeURIComponent(parsed.searchParams.get('web_rid'))}`;
    }
  } catch (_) {
    // Keep the normal string-based fallback for malformed or scheme-less input.
  }

  const queryIndex = trimmed.indexOf('?');
  const fragmentIndex = trimmed.indexOf('#');
  const delimiterIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);

  if (delimiterIndexes.length === 0) return trimmed;
  return trimmed.slice(0, Math.min(...delimiterIndexes));
}

module.exports = { normalizeRoomUrl };
