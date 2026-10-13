const fs = require('fs');

/**
 * 运行环境探测：当前进程是否跑在容器运行时内
 * （Docker / containerd / k8s / LXC / podman）。
 *
 * 宿主机直跑（npm start / npm run dev / PM2）返回 false。探测手段：
 * 1. `/.dockerenv` 存在（Docker 镜像约定文件）
 * 2. `/proc/1/cgroup` 含容器运行时标识（Linux 各类容器）
 *
 * 任一命中即视为容器；两者都读不到（如 macOS 无 /proc）视为非容器。
 * 调用方应把「探测不到」按非容器处理，并在文档中说明默认策略。
 */

const CONTAINER_CGROUP_PATTERN = /docker|containerd|kubepods|lxc|podman/i;

/**
 * @returns {boolean} true = 容器内运行；false = 宿主机直跑（或探测不到 /proc）
 */
function isContainerRuntime() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // existsSync 抛异常时继续下一步，不阻断启动
  }

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (CONTAINER_CGROUP_PATTERN.test(cgroup)) return true;
  } catch {
    // macOS 等无 /proc；读不到视为非容器
  }

  return false;
}

module.exports = { isContainerRuntime };
