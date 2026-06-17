const path = require('path');
const fs = require('fs');

// 定义期望的API清单（来自 API.md）
const EXPECTED_APIS = [
  // 直播间管理
  { method: 'GET', path: '/rooms' },
  { method: 'POST', path: '/rooms' },
  { method: 'GET', path: '/rooms/:id' },
  { method: 'PUT', path: '/rooms/:id' },
  { method: 'DELETE', path: '/rooms/:id' },

  // 录制控制
  { method: 'POST', path: '/rooms/:id/pause' },
  { method: 'POST', path: '/rooms/:id/resume' },
  { method: 'POST', path: '/rooms/:id/stop' },

  // 录制触发
  { method: 'POST', path: '/notify/live_download' },
  { method: 'GET', path: '/notify/status' },

  // 录制会话
  { method: 'GET', path: '/sessions/:id' },
  { method: 'DELETE', path: '/sessions/:id' },

  // 录制文件
  { method: 'GET', path: '/recording_files' },
  { method: 'PUT', path: '/recording_files/:id/associate' },
  { method: 'DELETE', path: '/recording_files/missing' },
  { method: 'GET', path: '/recordings/:id/stream' },
  { method: 'DELETE', path: '/recordings/:id' },

  // 全局设置
  { method: 'GET', path: '/settings' },
  { method: 'PUT', path: '/settings/:key' },

  // 投稿模板
  { method: 'GET', path: '/upload_templates' },
  { method: 'POST', path: '/upload_templates' },
  { method: 'PUT', path: '/upload_templates/:id' },
  { method: 'DELETE', path: '/upload_templates/:id' },

  // 稿件投递
  { method: 'POST', path: '/sessions/:id/upload' },
  { method: 'GET', path: '/upload_records' },
  { method: 'DELETE', path: '/upload_records/:id' },

  // 回放工具箱
  { method: 'GET', path: '/replay/principals' },
  { method: 'GET', path: '/replay/principals/:principalId/records' },
  { method: 'GET', path: '/replay/records/:id' },
  { method: 'POST', path: '/replay/records/sync' },
  { method: 'POST', path: '/replay/records/:id/actions/:action' },
  { method: 'POST', path: '/replay/records/:id/cancel' },
  { method: 'GET', path: '/replay/principals/:principalId/uploads' },
  { method: 'GET', path: '/replay/tasks' },
  { method: 'POST', path: '/replay/tasks/enqueue' },
  { method: 'GET', path: '/replay/principals/:principalId/settings' },
  { method: 'PUT', path: '/replay/principals/:principalId/settings' },

  // 额外的现有接口
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/scan_files' },
  { method: 'GET', path: '/' },
  { method: 'POST', path: '/notify/feishu_webhook' },
  { method: 'GET', path: '/sessions' },
];

// 从路由文件中提取路由的辅助函数
function extractRoutesFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const routes = [];

  // 匹配 router.get/post/put/delete
  const regex = /router\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    let path = match[2];
    // 处理可选参数
    if (path.includes('?')) {
      path = path.replace(/\?/g, '');
    }
    routes.push({ method, path });
  }

  return routes;
}

// 规范化路径用于比较
function normalizePath(p) {
  return p
    .replace(/:id/g, ':param')
    .replace(/:key/g, ':param')
    .replace(/:session_id/g, ':param')
    .replace(/:template_id/g, ':param');
}

// 路径匹配函数
function matchPath(actual, expected) {
  const normActual = normalizePath(actual);
  const normExpected = normalizePath(expected);
  return normActual === normExpected;
}

describe('API接口完整性检查', () => {
  let implementedRoutes = [];

  beforeAll(() => {
    // 从所有路由文件中提取已实现的路由
    const routerFiles = [
      path.join(__dirname, '../router/api.js'),
      path.join(__dirname, '../router/rooms.js'),
      path.join(__dirname, '../router/settings.js'),
      path.join(__dirname, '../router/upload.js'),
      path.join(__dirname, '../router/replay.js'),
    ];

    for (const file of routerFiles) {
      const routes = extractRoutesFromFile(file);
      implementedRoutes = implementedRoutes.concat(routes);
    }
  });

  test('所有期望的API接口都应该已实现', () => {
    const missingApis = [];

    for (const expected of EXPECTED_APIS) {
      const found = implementedRoutes.some(
        (actual) => actual.method === expected.method && matchPath(actual.path, expected.path)
      );

      if (!found) {
        missingApis.push(expected);
      }
    }

    if (missingApis.length > 0) {
      console.log('❌ 缺失的API接口:');
      missingApis.forEach((api) => {
        console.log(`  ${api.method} /api${api.path}`);
      });
    }

    expect(missingApis.length).toBe(0);
  });

  test('检查是否有额外实现但未记录在文档中的接口', () => {
    const extraRoutes = [];

    for (const actual of implementedRoutes) {
      const foundInExpected = EXPECTED_APIS.some(
        (expected) => expected.method === actual.method && matchPath(expected.path, actual.path)
      );

      if (!foundInExpected) {
        extraRoutes.push(actual);
      }
    }

    if (extraRoutes.length > 0) {
      console.log('⚠️  额外实现的API接口（可能需要更新文档）:');
      extraRoutes.forEach((api) => {
        console.log(`  ${api.method} /api${api.path}`);
      });
    }

    // 这个测试只做提示，不强制失败
    expect(true).toBe(true);
  });

  test('显示已实现的API接口清单', () => {
    console.log('\n✅ 已实现的API接口清单:');
    const sortedRoutes = [...implementedRoutes].sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });

    sortedRoutes.forEach((route) => {
      console.log(`  ${route.method} /api${route.path}`);
    });

    console.log(`\n总计: ${implementedRoutes.length} 个API接口\n`);
    expect(true).toBe(true);
  });
});
