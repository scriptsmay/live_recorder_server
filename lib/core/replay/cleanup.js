const fs = require('fs/promises');

async function removeFiles(files, logger = console) {
  const list = Array.isArray(files) ? files : [files].filter(Boolean);
  const result = { deleted: 0, failed: 0 };

  for (const file of list) {
    try {
      await fs.unlink(file);
      result.deleted++;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        result.failed++;
        logger.warn?.(`[回放清理] 删除失败: ${file} ${err.message}`);
      }
    }
  }

  return result;
}

module.exports = {
  removeFiles,
};
