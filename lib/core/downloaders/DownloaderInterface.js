class DownloaderInterface {
  get name() {
    throw new Error('subclass must implement name getter');
  }

  getExtension() {
    return '.mp4';
  }

  /**
   * 下载后切割 - true
   * 边下边切割 - false
   * @returns
   */
  getCutAfterDownloaded() {
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
