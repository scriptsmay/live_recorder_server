module.exports = {
  // 忽略包含大文件的目录
  testPathIgnorePatterns: ['/node_modules/', '/dev_downloads/', '/logs/', '/docs/'],
  // 忽略模块路径
  modulePathIgnorePatterns: ['/dev_downloads/', '/logs/'],
  // 忽略特定文件类型
  transformIgnorePatterns: ['/node_modules/', '\\.(mp4|ts|mp3|wav|avi|mov|mkv)$'],
};
