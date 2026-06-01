const PLATFORMS = {
  WINDOWS: 'Windows NT 10.0; Win64; x64',
  MAC: 'Macintosh; Intel Mac OS X 10_15_7',
  LINUX: 'X11; Linux x86_64',
};

const UA_TEMPLATES = {
  chrome: (platform) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
  safari: (platform) =>
    `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15`,
  mobile: () =>
    `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1`,
};

function getOptimalUserAgent() {
  const platformMap = {
    win32: PLATFORMS.WINDOWS,
    darwin: PLATFORMS.MAC,
    linux: PLATFORMS.LINUX,
  };
  const platformStr = platformMap[process.platform] || PLATFORMS.LINUX;
  return UA_TEMPLATES.chrome(platformStr);
}

function getRandomUserAgent() {
  const uaList = [
    UA_TEMPLATES.chrome(PLATFORMS.WINDOWS),
    UA_TEMPLATES.chrome(PLATFORMS.MAC),
    UA_TEMPLATES.chrome(PLATFORMS.LINUX),
    UA_TEMPLATES.safari(PLATFORMS.MAC),
    UA_TEMPLATES.mobile(),
  ];
  return uaList[Math.floor(Math.random() * uaList.length)];
}

module.exports = {
  getOptimalUserAgent,
  getRandomUserAgent,
  UA_TEMPLATES,
  PLATFORMS,
};
