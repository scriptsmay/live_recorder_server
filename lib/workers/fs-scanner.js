const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

parentPort.on('message', async (task) => {
  try {
    const results = await processDirectory(task.dir, task);
    parentPort.postMessage({ type: 'done', results });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});

async function processDirectory(dir, opts) {
  const files = [];
  const walkDir = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walkDir(fp);
        continue;
      }
      if (opts.filter && entry.name && !new RegExp(opts.filter).test(entry.name)) continue;
      try {
        const stat = fs.statSync(fp);
        files.push({
          path: fp,
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      } catch (_) {}
    }
  };
  walkDir(dir);
  return files;
}
