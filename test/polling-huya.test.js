const HuyaChecker = require('../server/lib/core/polling/HuyaChecker');

// HuyaChecker 直接使用全局 fetch（mp API + 网页备用源），在用例内按调用顺序 mock
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function htmlResponse(html) {
  return { ok: true, status: 200, text: async () => html };
}

function mpApiBody({ liveData = {}, realLiveStatus = 'ON' } = {}) {
  return {
    status: 200,
    data: {
      realLiveStatus,
      profileInfo: { nick: '测试主播' },
      liveData: { introduction: '直播标题', ...liveData },
      stream: {
        baseSteamInfoList: [
          {
            sCdnType: 'HW',
            sStreamName: '721931-1234567',
            sFlvUrl: 'http://hw.flv.huya.com/src',
            sFlvAntiCode: 'wsSecret=abc&wsTime=123',
          },
        ],
      },
    },
  };
}

describe('HuyaChecker', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(jest.fn());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('静态方法', () => {
    it('should return correct platform id', () => {
      expect(HuyaChecker.getPlatformId()).toBe('huya');
    });

    it('should handle huya.com URLs', () => {
      expect(HuyaChecker.canHandleUrl('https://www.huya.com/721931')).toBe(true);
      expect(HuyaChecker.canHandleUrl('https://www.huya.com/beisheng1117')).toBe(true);
    });

    it('should not handle non-huya URLs', () => {
      expect(HuyaChecker.canHandleUrl('https://www.kuaishou.com/abc')).toBe(false);
      expect(HuyaChecker.canHandleUrl('https://live.bilibili.com/123')).toBe(false);
    });
  });

  describe('getRoomId', () => {
    it('should extract room id from URL', () => {
      const checker = new HuyaChecker('https://www.huya.com/721931');
      expect(checker.getRoomId()).toBe('721931');
    });

    it('should strip query and hash from room id', () => {
      const checker = new HuyaChecker('https://www.huya.com/721931?from=share#live');
      expect(checker.getRoomId()).toBe('721931');
    });
  });

  describe('checkStatus 封面提取', () => {
    it('should extract screenshot from mp API liveData (主数据源)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          mpApiBody({
            liveData: { screenshot: 'https://huya-img.msstatic.com/livecover.jpg' },
          })
        )
      );

      const checker = new HuyaChecker('https://www.huya.com/721931');
      const result = await checker.checkStatus();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('mp.huya.com/cache.php');
      expect(fetchMock.mock.calls[0][0]).toContain('roomid=721931');
      expect(result.isLive).toBe(true);
      expect(result.roomCover).toBe('https://huya-img.msstatic.com/livecover.jpg');
      expect(result.streamUrl).toContain('.flv');
    });

    it('should fall back to TT_ROOM_DATA.screenshot when mp API has no screenshot (备用源)', async () => {
      fetchMock
        .mockResolvedValueOnce(
          htmlResponse(
            '<html><script>var TT_ROOM_DATA = {"profileRoom":"11223344","screenshot":"https://huya-img.msstatic.com/webcover.jpg"};</script></html>'
          )
        )
        .mockResolvedValueOnce(jsonResponse(mpApiBody({ liveData: {} })));

      const checker = new HuyaChecker('https://www.huya.com/beisheng1117');
      const result = await checker.checkStatus();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.roomCover).toBe('https://huya-img.msstatic.com/webcover.jpg');
    });

    it('should prefer mp API screenshot over web screenshot', async () => {
      fetchMock
        .mockResolvedValueOnce(
          htmlResponse(
            '<html><script>var TT_ROOM_DATA = {"profileRoom":"11223344","screenshot":"https://huya-img.msstatic.com/webcover.jpg"};</script></html>'
          )
        )
        .mockResolvedValueOnce(
          jsonResponse(mpApiBody({ liveData: { screenshot: 'https://huya-img.msstatic.com/mpcover.jpg' } }))
        );

      const checker = new HuyaChecker('https://www.huya.com/beisheng1117');
      const result = await checker.checkStatus();

      expect(result.roomCover).toBe('https://huya-img.msstatic.com/mpcover.jpg');
    });

    it('should return empty roomCover when no screenshot anywhere', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(mpApiBody({ liveData: {} })));

      const checker = new HuyaChecker('https://www.huya.com/721931');
      const result = await checker.checkStatus();

      expect(result.roomCover).toBe('');
    });

    it('should still extract screenshot when room is offline', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          mpApiBody({
            realLiveStatus: 'OFF',
            liveData: { screenshot: 'https://huya-img.msstatic.com/livecover.jpg' },
          })
        )
      );

      const checker = new HuyaChecker('https://www.huya.com/721931');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
      expect(result.roomCover).toBe('https://huya-img.msstatic.com/livecover.jpg');
    });

    it('should return error result when mp API reports failure', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 500, message: 'server error' }));

      const checker = new HuyaChecker('https://www.huya.com/721931');
      const result = await checker.checkStatus();

      expect(result.isLive).toBe(false);
      expect(result.error).toBe('无法获取流信息');
    });

    it('should return error result when request fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const checker = new HuyaChecker('https://www.huya.com/721931');
      const result = await checker.checkStatus();

      expect(result.error).toBe('无法获取流信息');
    });
  });
});
