const ResponseHelper = require('../lib/response');

describe('ResponseHelper', () => {
  let mockRes;

  beforeEach(() => {
    mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
  });

  describe('success', () => {
    it('should return success response with data', () => {
      const data = { key: 'value' };
      ResponseHelper.success(mockRes, data, 'Success message');

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data,
        message: 'Success message',
        timestamp: expect.any(Number),
      });
    });

    it('should return success response with default values', () => {
      ResponseHelper.success(mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: null,
        message: '',
        timestamp: expect.any(Number),
      });
    });
  });

  describe('error', () => {
    it('should return error response with code and message', () => {
      ResponseHelper.error(mockRes, 'Error message', 400, { detail: 'details' });

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 400,
          message: 'Error message',
          details: { detail: 'details' },
        },
        timestamp: expect.any(Number),
      });
    });

    it('should return default 500 error', () => {
      ResponseHelper.error(mockRes, 'Internal error');

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  describe('badRequest', () => {
    it('should return 400 error', () => {
      ResponseHelper.badRequest(mockRes, 'Bad request');

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('notFound', () => {
    it('should return 404 error', () => {
      ResponseHelper.notFound(mockRes, 'Not found');

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });
});