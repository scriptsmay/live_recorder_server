const fs = require('fs');
const path = require('path');

// 从后端 SPA fallback 白名单里抽出静态路由（'/xxx' 形式的字面量）
function parseSpaRoutes() {
  const spaRouter = fs.readFileSync(path.join(__dirname, '../server/router/spa.js'), 'utf8');
  const match = spaRouter.match(/const spaRoutes = \[([\s\S]*?)\];/);
  if (!match) throw new Error('spa.js 中未找到 spaRoutes 数组');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// 从前端 Vue Router 里抽出静态页面路由：
// - 排除根路径（由 base 路由处理，不经 fallback）
// - 排除动态段 `:param`（由 spaDynamicPatterns 覆盖）
// - 排除纯重定向路由（如 /upload_records → /upload-records，由 spa.js 专门的 301 处理）
function parseFrontendRoutes() {
  const routerSource = fs.readFileSync(path.join(__dirname, '../frontend/src/router/index.ts'), 'utf8');
  return [...routerSource.matchAll(/\{\s*path:\s*'(\/[^']*)'([^}]*)\}/g)]
    .filter(([, , body]) => !body.includes('redirect:'))
    .map(([, p]) => p)
    .filter((p) => p !== '/' && !p.includes(':'));
}

describe('SPA route fallback', () => {
  test('每个前端静态路由都在后端 history fallback 白名单里', () => {
    const spaRoutes = parseSpaRoutes();
    const frontendRoutes = parseFrontendRoutes();

    // 根路径由 base 路由处理，不经 fallback
    const missing = frontendRoutes.filter((r) => !spaRoutes.includes(r));

    expect(missing).toEqual([]);
  });

  test('白名单里不含前端已不存在的路由（防死条目）', () => {
    const spaRoutes = parseSpaRoutes();
    const frontendRoutes = parseFrontendRoutes();

    const stale = spaRoutes.filter((r) => !frontendRoutes.includes(r));

    expect(stale).toEqual([]);
  });

  test('前端路由清单非空（防止解析正则失配导致测试空转）', () => {
    expect(parseFrontendRoutes().length).toBeGreaterThan(5);
    expect(parseSpaRoutes().length).toBeGreaterThan(5);
  });
});
