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
  { domain: 'kuaishou.com', platformId: 'kuaishou' },
  { domain: 'douyu.com', platformId: 'douyu' },
  { domain: 'huya.com', platformId: 'huya' },
  { domain: 'live.bilibili.com', platformId: 'bilibili' },
  { domain: 'douyin.com', platformId: 'douyin' },
  { domain: 'xiaohongshu.com', platformId: 'xiaohongshu' },
  { domain: 'xhslink.com', platformId: 'xiaohongshu' },
  { domain: 'redelight.cn', platformId: 'xiaohongshu' },
];

/**
 * Extract the first HTTP(S) URL from a share text string if present.
 *
 * @param {string} input
 * @returns {string}
 */
function extractFirstUrlFromText(input) {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  const match = trimmed.match(/https?:\/\/[^\s，。！!、；;”"’'】\]）)]+/i);
  return match ? match[0] : trimmed;
}

/**
 * Detect the live streaming platform from a URL string.
 *
 * @param {*} url - URL string to inspect (any type accepted; non-strings return null).
 * @returns {string|null} Platform ID ('douyu' | 'huya' | 'bilibili' | 'douyin' | 'kuaishou' | 'xiaohongshu'),
 *   or null if the URL is unrecognized, invalid, or the input is not a string.
 */
function detectPlatform(url) {
  try {
    // Type guard: reject non-string / null / undefined inputs
    if (url === null || url === undefined || typeof url !== 'string') {
      return null;
    }

    // Support share texts that wrap an HTTP(S) link
    let normalized = extractFirstUrlFromText(url);
    const lower = normalized.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      normalized = 'http://' + normalized;
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

module.exports = { detectPlatform, extractFirstUrlFromText, SUPPORTED_PLATFORMS };
