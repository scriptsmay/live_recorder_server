const {
  randomBetween,
  simulateHumanBehavior,
  simulateInitialDelay,
  simulateScrolling,
} = require('../server/lib/core/browser/humanBehavior');

function createPageMock() {
  return {
    evaluate: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
  };
}

describe('humanBehavior', () => {
  it('returns a random integer inside the inclusive range', () => {
    expect(randomBetween(10, 20, () => 0)).toBe(10);
    expect(randomBetween(10, 20, () => 0.999999)).toBe(20);
    expect(randomBetween(20, 10, () => 0)).toBe(10);
  });

  it('simulates an initial delay inside the configured range', async () => {
    const page = createPageMock();

    await simulateInitialDelay(page, {
      minDelayMs: 100,
      maxDelayMs: 200,
      random: () => 0,
    });

    expect(page.waitForTimeout).toHaveBeenCalledWith(100);
  });

  it('simulates scrolling and returns to the top', async () => {
    const page = createPageMock();

    await simulateScrolling(page, {
      scrollCount: 2,
      random: () => 0,
    });

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(3);
  });

  it('skips scrolling when scrollCount is zero', async () => {
    const page = createPageMock();

    await simulateScrolling(page, { scrollCount: 0 });

    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('runs the full behavior sequence', async () => {
    const page = createPageMock();

    await simulateHumanBehavior(page, {
      minDelayMs: 100,
      maxDelayMs: 100,
      scrollCount: 1,
      random: () => 0,
    });

    expect(page.waitForTimeout).toHaveBeenCalledTimes(3);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
