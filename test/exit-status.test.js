const { isUnexpectedExit } = require('../server/lib/utils/exit-status');

// D2 判定表：人工停止 > SIGTERM > (code 0, 无信号) > 其余意外退出
describe('isUnexpectedExit — 退出原因判定', () => {
  test('人工停止：即使被兜底 SIGKILL，也判定为正常退出', () => {
    expect(isUnexpectedExit({ code: null, signal: 'SIGKILL', isManualStop: true })).toBe(false);
  });

  test('人工停止：非零退出码也判定为正常退出', () => {
    expect(isUnexpectedExit({ code: 1, signal: null, isManualStop: true })).toBe(false);
  });

  test('人工停止：默认参数不影响判定', () => {
    expect(isUnexpectedExit({ code: 255, signal: 'SIGKILL', isManualStop: false })).toBe(true);
  });

  test('SIGTERM：正常终止信号', () => {
    expect(isUnexpectedExit({ code: null, signal: 'SIGTERM', isManualStop: false })).toBe(false);
  });

  test('SIGTERM：即使退出码非零也视为正常终止', () => {
    expect(isUnexpectedExit({ code: 143, signal: 'SIGTERM', isManualStop: false })).toBe(false);
  });

  test('code=0 且 signal=null：进程正常退出', () => {
    expect(isUnexpectedExit({ code: 0, signal: null })).toBe(false);
  });

  test('非零退出码：意外退出', () => {
    expect(isUnexpectedExit({ code: 1, signal: null })).toBe(true);
    expect(isUnexpectedExit({ code: 255, signal: null })).toBe(true);
  });

  test('外部 SIGKILL：意外退出', () => {
    expect(isUnexpectedExit({ code: null, signal: 'SIGKILL' })).toBe(true);
  });

  test('其他信号（崩溃）：意外退出', () => {
    expect(isUnexpectedExit({ code: null, signal: 'SIGSEGV' })).toBe(true);
    expect(isUnexpectedExit({ code: null, signal: 'SIGABRT' })).toBe(true);
  });

  test('code=0 但带非 SIGTERM 信号：意外退出', () => {
    expect(isUnexpectedExit({ code: 0, signal: 'SIGKILL' })).toBe(true);
  });
});
