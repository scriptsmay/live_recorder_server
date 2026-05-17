const FFmpegDownloader = require('./FFmpegDownloader');

const INSTANCES = {
  ffmpeg: new FFmpegDownloader(),
};

async function getActiveDownloader() {
  return INSTANCES.ffmpeg;
}

module.exports = { getActiveDownloader };
