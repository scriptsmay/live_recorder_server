'use strict';

/**
 * Platform detection utility for live streaming URLs.
 * Pure function module — no external dependencies, no side effects.
 *
 * @module lib/utils/platform-detector
 */

/**
 * Domain-to-platform mapping.
 * Each entry: { domain: string, platformId: string }
 * Matching rule: hostname === domain OR hostname ends with '.' + domain
 */
const SUPPORTED_PLATFORMS = [
  { domain: 'douyu.com', platformId: 'douyu' },
  { domain: 'huya.com', platformId: 'huya' },
  { domain: 'live.bilibili.com', platformId: 'bilibili' },
  { domain: 'douyin.com', platformId: 'douyin' },
];

/**
 * Detect the live streaming platform from a URL string.
 *
 * @param {*} url - URL string to inspect (any type accepted; non-strings return null).
 * @returns {string|null} Platform ID ('douyu' | 'huya' | 'bilibili' | 'douyin'),
 *   or null if the URL is unrecognized, invalid, or the input is not a string.
 */
function detectPlatform(url) {
  try {
    // Type guard: reject non-string / null / undefined inputs
    if (url === null || url === undefined || typeof url !== 'string') {
      return null;
    }

    // Prepend http:// if no scheme is present (case-insensitive check)
    let normalized = url;
    const lower = url.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      normalized = 'http://' + url;
    }

    // Extract hostname and normalize to lowercase
    const hostname = new URL(normalized).hostname.toLowerCase();

    // Match against supported platforms
    for (const { domain, platformId } of SUPPORTED_PLATFORMS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return platformId;
      }
    }

    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { detectPlatform, SUPPORTED_PLATFORMS };
