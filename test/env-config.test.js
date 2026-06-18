const path = require('path');

function withEnv(overrides, fn) {
  const previous = { ...process.env };
  process.env = { ...previous };
  delete process.env.REPLAY_WORK_DIR;
  Object.assign(process.env, overrides);
  try {
    fn();
  } finally {
    process.env = previous;
  }
}

describe('env config', () => {
  test('initEnv derives REPLAY_WORK_DIR next to VIDEO_DOWNLOAD_DIR', () => {
    withEnv({ APP_DATA_DIR: '/data', VIDEO_DOWNLOAD_DIR: '/tmp/live/video_downloads' }, () => {
      jest.isolateModules(() => {
        const { initEnv } = require('../server/config/env');
        initEnv();

        expect(process.env.REPLAY_WORK_DIR).toBe(path.join('/tmp/live', 'replay'));
      });
    });
  });

  test('initEnv keeps explicit REPLAY_WORK_DIR', () => {
    const previous = { ...process.env };
    process.env = {
      ...previous,
      VIDEO_DOWNLOAD_DIR: '/tmp/live/video_downloads',
      REPLAY_WORK_DIR: '/mnt/replay-work',
    };
    try {
      jest.isolateModules(() => {
        const { initEnv } = require('../server/config/env');
        initEnv();

        expect(process.env.REPLAY_WORK_DIR).toBe('/mnt/replay-work');
      });
    } finally {
      process.env = previous;
    }
  });
});
