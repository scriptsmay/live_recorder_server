const fs = require('fs');
const path = require('path');

/**
 * 文件管理模块 — 路径安全校验工具
 *
 * 提供路径解析、allowlist 校验、符号链接检测等安全能力，
 * 防止路径穿越、符号链接逃逸和根目录误删。
 */

const ALLOWLIST_ROOTS = [
  process.env.VIDEO_DOWNLOAD_DIR || '/data/video_downloads',
  process.env.REPLAY_WORK_DIR || '/data/replay',
  process.env.BILIUP_WORK_DIR || '/data/biliup',
].map((r) => path.resolve(r));

/**
 * 检查 resolvedPath 是否位于 root 目录下（含 root 本身）
 * @param {string} resolvedPath
 * @param {string} root
 * @returns {boolean}
 */
function isWithinRoot(resolvedPath, root) {
  const rel = path.relative(root, resolvedPath);
  // path.relative 返回 '' 表示相同路径；以 '..' 开头或为绝对路径表示逃逸
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 解析并校验文件路径的安全性。
 *
 * 校验规则：
 * 1. 非空路径
 * 2. 解析后为绝对路径
 * 3. 不含 '..' 段
 * 4. 非符号链接
 * 5. 位于 allowlist 根目录之一内
 * 6. 不是 allowlist 根目录本身
 *
 * @param {string} filePath - 原始文件路径
 * @param {string[]} [allowlistRoots] - 允许的根目录列表，默认 ALLOWLIST_ROOTS
 * @returns {Promise<{valid: true, resolvedPath: string} | {valid: false, reason: string}>}
 */
async function resolveAndValidate(filePath, allowlistRoots) {
  const roots = allowlistRoots || ALLOWLIST_ROOTS;

  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return { valid: false, reason: 'empty_path' };
  }

  const resolved = path.resolve(filePath);

  // 检查路径中是否包含 '..' 段（原始输入，非 resolve 后）
  if (filePath.includes('..')) {
    return { valid: false, reason: 'path_traversal' };
  }

  // 符号链接检测
  try {
    const lstat = await fs.promises.lstat(resolved);
    if (lstat.isSymbolicLink()) {
      return { valid: false, reason: 'symlink' };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在时仍需校验路径是否在 allowlist 内（用于删除已丢失文件的 DB 记录）
    } else {
      return { valid: false, reason: `stat_error: ${err.message}` };
    }
  }

  // 检查是否位于 allowlist 根目录内
  const withinRoot = roots.some((root) => isWithinRoot(resolved, root));
  if (!withinRoot) {
    // 也检查是否恰好等于某个根目录（禁止删除根目录本身）
    const isRoot = roots.some((root) => resolved === root);
    if (isRoot) {
      return { valid: false, reason: 'root_directory' };
    }
    return { valid: false, reason: 'outside_allowlist' };
  }

  return { valid: true, resolvedPath: resolved };
}

module.exports = {
  ALLOWLIST_ROOTS,
  resolveAndValidate,
  isWithinRoot,
};
