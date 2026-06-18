function normalizeRange(min, max) {
  const normalizedMin = Number.isFinite(min) ? min : 0;
  const normalizedMax = Number.isFinite(max) ? max : normalizedMin;
  return normalizedMin <= normalizedMax ? [normalizedMin, normalizedMax] : [normalizedMax, normalizedMin];
}

function randomBetween(min, max, random = Math.random) {
  const [low, high] = normalizeRange(Math.floor(min), Math.floor(max));
  const value = typeof random === 'function' ? random() : Math.random();
  const bounded = Math.min(Math.max(value, 0), 0.999999);
  return low + Math.floor(bounded * (high - low + 1));
}

async function simulateInitialDelay(page, options = {}) {
  const random = options.random || Math.random;
  const minDelayMs = options.minDelayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  await page.waitForTimeout(randomBetween(minDelayMs, maxDelayMs, random));
}

async function simulateScrolling(page, options = {}) {
  const random = options.random || Math.random;
  const scrollCount = Math.max(0, Number(options.scrollCount ?? 2));

  for (let index = 0; index < scrollCount; index += 1) {
    const distance = randomBetween(100, 400, random);
    await page.evaluate((top) => {
      window.scrollBy({ top, behavior: 'smooth' });
    }, distance);
    await page.waitForTimeout(randomBetween(500, 1500, random));
  }

  if (scrollCount > 0) {
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await page.waitForTimeout(randomBetween(300, 800, random));
  }
}

async function simulateHumanBehavior(page, options = {}) {
  await simulateInitialDelay(page, options);
  await simulateScrolling(page, options);
}

module.exports = {
  randomBetween,
  simulateHumanBehavior,
  simulateInitialDelay,
  simulateScrolling,
};
