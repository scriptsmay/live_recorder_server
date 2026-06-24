const fs = require('fs');
const path = require('path');

describe('SPA route fallback', () => {
  test('file management page is included in server-side history fallback', () => {
    const spaRouter = fs.readFileSync(path.join(__dirname, '../server/router/spa.js'), 'utf8');

    expect(spaRouter).toContain("'/files'");
  });
});
