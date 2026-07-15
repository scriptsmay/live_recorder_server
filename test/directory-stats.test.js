const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDirectoryStats } = require('../server/lib/utils/directory-stats');

describe('getDirectoryStats', () => {
  test('目录大小等于内部文件之和', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hls-stats-'));
    try {
      await fs.promises.mkdir(path.join(root, 'nested'));
      await fs.promises.writeFile(path.join(root, 'playlist.m3u8'), Buffer.alloc(13));
      await fs.promises.writeFile(path.join(root, 'nested', 'segment.ts'), Buffer.alloc(29));

      const stats = await getDirectoryStats(root);

      expect(stats.size).toBe(42);
      expect(stats.mtime).toBeInstanceOf(Date);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
