const EventEmitter = require('events');

class DownloaderManager extends EventEmitter {
  constructor() {
    super();
    this.activeDownloads = new Map();
    this.downloadHistory = [];
  }

  startDownload(downloadId, downloader, args, options = {}) {
    const downloadInfo = {
      id: downloadId,
      downloader: downloader.name,
      startTime: Date.now(),
      status: 'starting',
      progress: null,
      error: null,
      retries: 0,
      maxRetries: options.maxRetries || 0,
      pid: null,
      process: null,
    };

    this.activeDownloads.set(downloadId, downloadInfo);
    this.emit('downloadStart', downloadInfo);

    try {
      const proc = downloader.spawn(args);
      downloadInfo.process = proc;
      downloadInfo.pid = proc.pid;
      downloadInfo.status = 'downloading';

      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          const line = chunk.toString();
          const progress = downloader.parseProgress(line);
          if (progress) {
            downloadInfo.progress = progress;
            downloadInfo.lastUpdate = Date.now();
            this.emit('downloadProgress', downloadId, progress);
          }
        });
      }

      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => {
          const line = chunk.toString();
          const progress = downloader.parseProgress(line);
          if (progress) {
            downloadInfo.progress = progress;
            downloadInfo.lastUpdate = Date.now();
            this.emit('downloadProgress', downloadId, progress);
          }
        });
      }

      proc.on('close', async (code) => {
        if (code === 0) {
          downloadInfo.status = 'completed';
          downloadInfo.endTime = Date.now();
          this.emit('downloadComplete', downloadId, downloadInfo);
        } else {
          const retryStrategy = downloader.getRetryStrategy(code);
          if (retryStrategy.shouldRetry && downloadInfo.retries < retryStrategy.maxRetries) {
            downloadInfo.retries++;
            downloadInfo.status = 'retrying';
            this.emit('downloadRetry', downloadId, {
              attempt: downloadInfo.retries,
              maxAttempts: retryStrategy.maxRetries,
              delay: retryStrategy.delayMs,
            });

            setTimeout(() => {
              if (this.activeDownloads.has(downloadId)) {
                this.startDownload(downloadId, downloader, args, options);
              }
            }, retryStrategy.delayMs);
            return;
          }

          downloadInfo.status = 'failed';
          downloadInfo.error = `Exit code: ${code}`;
          downloadInfo.endTime = Date.now();
          this.emit('downloadError', downloadId, downloadInfo);
        }

        this.activeDownloads.delete(downloadId);
        this.addToHistory(downloadInfo);
      });

      proc.on('error', (err) => {
        downloadInfo.status = 'failed';
        downloadInfo.error = err.message;
        downloadInfo.endTime = Date.now();
        this.emit('downloadError', downloadId, downloadInfo);
        this.activeDownloads.delete(downloadId);
        this.addToHistory(downloadInfo);
      });

      return proc;
    } catch (err) {
      downloadInfo.status = 'failed';
      downloadInfo.error = err.message;
      downloadInfo.endTime = Date.now();
      this.emit('downloadError', downloadId, downloadInfo);
      this.activeDownloads.delete(downloadId);
      this.addToHistory(downloadInfo);
      throw err;
    }
  }

  stopDownload(downloadId) {
    const downloadInfo = this.activeDownloads.get(downloadId);
    if (downloadInfo && downloadInfo.process) {
      try {
        process.kill(downloadInfo.pid, 'SIGTERM');
        downloadInfo.status = 'stopping';
        this.emit('downloadStopping', downloadId);
      } catch (err) {
        console.error(`[DownloaderManager] 停止下载失败: ${err.message}`);
      }
    }
  }

  getDownloadStatus(downloadId) {
    return this.activeDownloads.get(downloadId) || null;
  }

  getAllActiveDownloads() {
    return Array.from(this.activeDownloads.values());
  }

  addToHistory(downloadInfo) {
    this.downloadHistory.push({
      ...downloadInfo,
      process: undefined,
    });
    if (this.downloadHistory.length > 100) {
      this.downloadHistory.shift();
    }
  }

  getHistory() {
    return this.downloadHistory;
  }
}

module.exports = new DownloaderManager();
