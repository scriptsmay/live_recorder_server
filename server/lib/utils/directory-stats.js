const fs = require('fs');
const path = require('path');

/**
 * Recursively total regular-file sizes without following symbolic links.
 * Directory entry sizes are intentionally excluded.
 */
async function getDirectoryStats(rootPath) {
  let size = 0;
  let latestMtimeMs = 0;

  async function visit(currentPath) {
    const stat = await fs.promises.lstat(currentPath);
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);

    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) {
      size += stat.size;
      return;
    }

    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(path.join(currentPath, entry.name));
    }
  }

  await visit(rootPath);
  return {
    size,
    mtime: latestMtimeMs > 0 ? new Date(latestMtimeMs) : null,
  };
}

module.exports = { getDirectoryStats };
