class PlatformChecker {
  constructor(roomUrl) {
    this.roomUrl = roomUrl;
  }

  async checkStatus() {
    throw new Error('Not implemented');
  }

  static getPlatformId() {
    throw new Error('Not implemented');
  }

  static canHandleUrl(_url) {
    throw new Error('Not implemented');
  }
}

module.exports = PlatformChecker;
