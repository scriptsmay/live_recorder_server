const { Worker } = require('worker_threads');
const path = require('path');
const { spawn } = require('child_process');

class FSWorkerPool {
  constructor(size = 2) {
    this.workers = [];
    this.queue = [];
    this._init(size);
  }

  _init(size) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(path.join(__dirname, 'workers/fs-scanner.js'));
      worker.isBusy = false;
      worker.on('message', (res) => {
        worker.isBusy = false;
        if (worker._currentResolve) {
          worker._currentResolve(res.results);
          worker._currentResolve = null;
        }
        this._processQueue();
      });
      worker.on('error', (err) => {
        worker.isBusy = false;
        if (worker._currentReject) {
          worker._currentReject(err);
          worker._currentReject = null;
        }
        this._processQueue();
      });
      this.workers.push(worker);
    }
  }

  _processQueue() {
    if (this.queue.length === 0) return;
    const idle = this.workers.find((w) => !w.isBusy);
    if (!idle) return;
    const task = this.queue.shift();
    this._executeOnWorker(idle, task.dir, task.opts).then(task.resolve).catch(task.reject);
  }

  _executeOnWorker(worker, dir, opts) {
    worker.isBusy = true;
    return new Promise((resolve, reject) => {
      worker._currentResolve = resolve;
      worker._currentReject = reject;
      worker.postMessage({ dir, ...opts });
    });
  }

  async scan(dir, opts = {}) {
    const idle = this.workers.find((w) => !w.isBusy);
    if (idle) {
      return this._executeOnWorker(idle, dir, opts);
    }

    const fallback = opts.fallback !== false;
    if (fallback) {
      console.warn('[WorkerPool] 无空闲 Worker，降级至子进程 find');
      return this._fallbackFind(dir, opts);
    }

    return new Promise((resolve, _reject) => {
      this.queue.push({ dir, opts, resolve, reject: _reject });
    });
  }

  _fallbackFind(dir, opts) {
    return new Promise((resolve) => {
      const args = [dir, '-type', 'f'];
      if (opts.mtime) args.push('-mtime', String(opts.mtime));
      if (opts.minSize) args.push('-size', `+${opts.minSize}c`);
      const proc = spawn('find', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => {
        if (code !== 0) return resolve([]);
        const files = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((fp) => {
            let stat;
            try {
              stat = require('fs').statSync(fp);
            } catch {
              return null;
            }
            return {
              path: fp,
              name: path.basename(fp),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              birthtimeMs: stat.birthtimeMs,
              ctimeMs: stat.ctimeMs,
            };
          })
          .filter(Boolean);
        resolve(files);
      });
      proc.on('error', () => resolve([]));
    });
  }

  terminate() {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch (_) {}
    }
  }
}

module.exports = FSWorkerPool;
