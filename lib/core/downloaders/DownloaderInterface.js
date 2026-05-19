const EventEmitter = require('events');

class DownloaderInterface extends EventEmitter {
  get name() {
    throw new Error('subclass must implement name getter');
  }
  // 增加一个通用的事件触发助手
  emitSegment(path) {
    this.emit('segment', path);
  }

  getExtension() {
    return '.mp4';
  }

  isSegment() {
    // 默认不支持分段
    return false;
  }

  buildArgs(url, outputPath, _options = {}) {
    throw new Error('subclass must implement buildArgs()');
  }

  spawn(_args) {
    throw new Error('subclass must implement spawn()');
  }

  stop(pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {}
  }

  pause(pid) {
    try {
      process.kill(pid, 'SIGSTOP');
    } catch (_) {}
  }

  resume(pid) {
    try {
      process.kill(pid, 'SIGCONT');
    } catch (_) {}
  }

  isRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  parseProgress(_stderrLine) {
    return null;
  }

  parseMetadata(_stdoutLine) {
    return null;
  }

  getRetryStrategy(_errorCode) {
    return {
      shouldRetry: false,
      delayMs: 0,
      maxRetries: 0,
    };
  }

  canHandleUrl(_url) {
    return true;
  }

  getDefaultOptions() {
    return {};
  }
}

module.exports = DownloaderInterface;
