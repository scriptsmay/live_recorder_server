'use strict';

const fs = require('fs');

const { isContainerRuntime } = require('../server/lib/utils/runtime');

const originalReadFileSync = fs.readFileSync;

/**
 * 打桩 fs 探测入口。dockerenv=true 表示 /.dockerenv 存在；
 * cgroup=null 表示 /proc/1/cgroup 读不到（macOS 场景）。
 * @returns {{existsSync: jest.SpyInstance, readFileSync: jest.SpyInstance}}
 */
function mockFs({ dockerenv = false, cgroup = null } = {}) {
  const existsSync = jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/.dockerenv' && dockerenv);
  const readFileSync = jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p !== '/proc/1/cgroup') return originalReadFileSync(p);
    if (cgroup === null) {
      const err = new Error('ENOENT: no such file or directory, open /proc/1/cgroup');
      err.code = 'ENOENT';
      throw err;
    }
    return cgroup;
  });
  return { existsSync, readFileSync };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isContainerRuntime', () => {
  test('/.dockerenv 存在 → 容器', () => {
    mockFs({ dockerenv: true });
    expect(isContainerRuntime()).toBe(true);
  });

  test('cgroup 含 docker → 容器', () => {
    mockFs({ cgroup: '12:pids:/docker/9f8e7d6c5b4a' });
    expect(isContainerRuntime()).toBe(true);
  });

  test('cgroup 含 kubepods → 容器', () => {
    mockFs({ cgroup: '0::/kubepods/burstable/pod123/abc123' });
    expect(isContainerRuntime()).toBe(true);
  });

  test('cgroup 含 containerd → 容器', () => {
    mockFs({ cgroup: '0::/system.slice/containerd.service' });
    expect(isContainerRuntime()).toBe(true);
  });

  test('cgroup 含 lxc → 容器', () => {
    mockFs({ cgroup: '11:devices:/lxc/mycontainer' });
    expect(isContainerRuntime()).toBe(true);
  });

  test('普通 Linux 宿主机（systemd cgroup）→ 非容器', () => {
    mockFs({ cgroup: '0::/init.scope' });
    expect(isContainerRuntime()).toBe(false);
  });

  test('macOS（无 /proc）→ 非容器', () => {
    mockFs({ cgroup: null });
    expect(isContainerRuntime()).toBe(false);
  });

  test('探测过程抛异常不阻断，按非容器处理', () => {
    const spies = mockFs({ cgroup: null });
    spies.existsSync.mockImplementation(() => {
      throw new Error('unexpected');
    });
    expect(isContainerRuntime()).toBe(false);
  });
});
