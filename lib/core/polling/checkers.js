const HuyaChecker = require('./HuyaChecker');
const BilibiliChecker = require('./BilibiliChecker');
const DouyuChecker = require('./DouyuChecker');
const DouyinChecker = require('./DouyinChecker');
const KuaishouChecker = require('./KuaishouChecker');

module.exports = {
  huya: HuyaChecker,
  bilibili: BilibiliChecker,
  douyu: DouyuChecker,
  douyin: DouyinChecker,
  kuaishou: KuaishouChecker,
};
