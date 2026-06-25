const path = require('path');
const fs = require('fs');

// 定义期望的API清单（与 server/router/ 中所有路由一一对应）
const EXPECTED_APIS = [
  // ===== api.js =====
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/notify/feishu_webhook' },
  { method: 'GET', path: '/notify/status' },
  { method: 'POST', path: '/notify/live_download' },
  { method: 'POST', path: '/scan_files' },
  { method: 'GET', path: '/dashboard/status' },
  { method: 'GET', path: '/recording_files' },
  { method: 'PUT', path: '/recording_files/:id/associate' },
  { method: 'DELETE', path: '/recording_files/missing' },
  { method: 'DELETE', path: '/recordings/:id' },
  { method: 'GET', path: '/api-doc' },
  { method: 'GET', path: '/recordings/:id/stream' },
  { method: 'GET', path: '/recordings/:id/hls' },
  { method: 'POST', path: '/recordings/:id/generate-hls' },
  { method: 'POST', path: '/recordings/:id/transcode' },

  // ===== rooms.js =====
  { method: 'GET', path: '/rooms' },
  { method: 'POST', path: '/rooms' },
  { method: 'GET', path: '/rooms/:id' },
  { method: 'PUT', path: '/rooms/:id' },
  { method: 'DELETE', path: '/rooms/:id' },
  { method: 'POST', path: '/rooms/:id/pause' },
  { method: 'POST', path: '/rooms/:id/resume' },
  { method: 'POST', path: '/rooms/:id/stop' },
  { method: 'GET', path: '/sessions' },
  { method: 'GET', path: '/sessions/:id' },
  { method: 'DELETE', path: '/sessions/:id' },

  // ===== settings.js =====
  { method: 'GET', path: '/settings' },
  { method: 'PUT', path: '/settings/:key' },
  { method: 'PUT', path: '/settings' },

  // ===== upload.js =====
  { method: 'GET', path: '/upload_templates' },
  { method: 'POST', path: '/upload_templates' },
  { method: 'PUT', path: '/upload_templates/:id' },
  { method: 'DELETE', path: '/upload_templates/:id' },
  { method: 'POST', path: '/biliup/renew' },
  { method: 'POST', path: '/sessions/:id/upload' },
  { method: 'GET', path: '/upload_records' },
  { method: 'GET', path: '/upload_records/merged' },
  { method: 'DELETE', path: '/upload_records/:id' },

  // ===== replay.js =====
  { method: 'GET', path: '/replay/principals' },
  { method: 'GET', path: '/replay/principals/:principalId/records' },
  { method: 'GET', path: '/replay/records/:id' },
  { method: 'POST', path: '/replay/records/sync' },
  { method: 'POST', path: '/replay/records/mark-completed' },
  { method: 'POST', path: '/replay/records/:id/actions/:action' },
  { method: 'POST', path: '/replay/records/:id/cancel' },
  { method: 'GET', path: '/replay/records/:id/upload-preview' },
  { method: 'GET', path: '/replay/principals/:principalId/uploads' },
  { method: 'GET', path: '/replay/tasks' },
  { method: 'POST', path: '/replay/tasks/enqueue' },
  { method: 'GET', path: '/replay/principals/:principalId/settings' },
  { method: 'PUT', path: '/replay/principals/:principalId/settings' },

  // ===== auth.js（挂载在 /api/auth，路径带 auth/ 前缀） =====
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'GET', path: '/auth/me' },
  { method: 'POST', path: '/auth/change-password' },
  { method: 'GET', path: '/auth/lock-status' },

  // ===== danmaku.js =====
  { method: 'GET', path: '/sessions/:id/danmaku-page' },
  { method: 'POST', path: '/danmaku/batch' },
  { method: 'POST', path: '/sessions/:id/danmaku/ass' },
  { method: 'POST', path: '/sessions/:id/danmaku/burn' },
  { method: 'GET', path: '/danmaku_capture_records' },
  { method: 'GET', path: '/danmaku_burn_records' },
  { method: 'DELETE', path: '/danmaku_burn_records/:id' },
  { method: 'GET', path: '/danmaku/status' },
  { method: 'GET', path: '/danmaku/search' },
  { method: 'GET', path: '/danmaku-toolbox/sessions' },
  { method: 'GET', path: '/danmaku/burn_output/:id/stream' },
  { method: 'POST', path: '/danmaku/free-burn' },
  { method: 'GET', path: '/danmaku/free-burn/records' },
  { method: 'GET', path: '/danmaku/free-burn/:id/stream' },

  // ===== transcode.js =====
  { method: 'GET', path: '/transcode_records' },
  { method: 'DELETE', path: '/transcode_records/:id' },

  // ===== logs.js =====
  { method: 'GET', path: '/logs/files' },
  { method: 'GET', path: '/logs/content' },
  { method: 'GET', path: '/logs/stream' },
  { method: 'DELETE', path: '/logs' },

  // ===== file-manage.js =====
  { method: 'GET', path: '/files/summary' },
  { method: 'GET', path: '/files' },
  { method: 'GET', path: '/files/:id' },
  { method: 'POST', path: '/files/delete-plan' },
  { method: 'POST', path: '/files/delete' },
  { method: 'GET', path: '/files/delete-tasks/:taskId' },
  { method: 'POST', path: '/files/:id/delete' },
  { method: 'POST', path: '/files/scan' },
];

// 从路由文件中提取路由的辅助函数
function extractRoutesFromFile(filePath, prefix = '') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const routes = [];

  // 匹配 router.get/post/put/delete（支持路径数组取第一个）
  const regex = /router\.(get|post|put|delete|patch)\s*\(\s*(?:\[?\s*)?['"]([^'"]+)['"]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    let routePath = match[2];
    // 处理可选参数
    if (routePath.includes('?')) {
      routePath = routePath.replace(/\?/g, '');
    }
    // 给 auth.js 等挂载前缀不同的路由加上前缀
    routes.push({ method, path: prefix ? prefix + routePath : routePath });
  }

  return routes;
}

// 规范化路径用于比较
function normalizePath(p) {
  return p
    .replace(/:id/g, ':param')
    .replace(/:key/g, ':param')
    .replace(/:session_id/g, ':param')
    .replace(/:template_id/g, ':param')
    .replace(/:principalId/g, ':param')
    .replace(/:action/g, ':param')
    .replace(/:taskId/g, ':param');
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
    // auth.js 挂载在 /api/auth，需要加 'auth/' 前缀
    // 其余都挂载在 /api，无需额外前缀
    const routerDir = path.join(__dirname, '../server/router');
    const routerFiles = [
      { file: 'api.js', prefix: '' },
      { file: 'rooms.js', prefix: '' },
      { file: 'settings.js', prefix: '' },
      { file: 'upload.js', prefix: '' },
      { file: 'replay.js', prefix: '' },
      { file: 'auth.js', prefix: '/auth' },
      { file: 'danmaku.js', prefix: '' },
      { file: 'transcode.js', prefix: '' },
      { file: 'logs.js', prefix: '' },
      { file: 'file-manage.js', prefix: '' },
      // 跳过 hls.js（regex 路由，非标准 API）和 spa.js（前端兜底）
    ];

    for (const { file, prefix } of routerFiles) {
      const filePath = path.join(routerDir, file);
      if (fs.existsSync(filePath)) {
        const routes = extractRoutesFromFile(filePath, prefix);
        implementedRoutes = implementedRoutes.concat(routes);
      }
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
