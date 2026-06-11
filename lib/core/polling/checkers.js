const HuyaChecker = require('./HuyaChecker');
const BilibiliChecker = require('./BilibiliChecker');
const DouyuChecker = require('./DouyuChecker');
const DouyinChecker = require('./DouyinChecker');
const KuaishouChecker = require('./KuaishouChecker');

function resolveKuaishouChecker() {
  if (String(process.env.KUAISHOU_CHECKER_MODE || '').toLowerCase() === 'api') {
    return require('./KuaishouAPIChecker');
  }
  return KuaishouChecker;
}

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
  kuaishou: resolveKuaishouChecker(),
};
