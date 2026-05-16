class ResponseHelper {
  static success(res, data = null, message = '') {
    res.json({
      success: true,
      data,
      message,
      timestamp: Date.now(),
    });
  }

  static successWithStatus(res, statusCode, data = null, message = '') {
    res.status(statusCode).json({
      success: true,
      data,
      message,
      timestamp: Date.now(),
    });
  }

  static error(res, message, code = 500, details = null) {
    res.status(code).json({
      success: false,
      error: {
        code,
        message,
        details,
      },
      timestamp: Date.now(),
    });
  }

  static badRequest(res, message, details = null) {
    this.error(res, message, 400, details);
  }

  static unauthorized(res, message = '未授权') {
    this.error(res, message, 401);
  }

  static forbidden(res, message = '禁止访问') {
    this.error(res, message, 403);
  }

  static notFound(res, message = '资源不存在') {
    this.error(res, message, 404);
  }

  static conflict(res, message = '资源冲突') {
    this.error(res, message, 409);
  }

  static tooManyRequests(res, message = '请求过于频繁') {
    this.error(res, message, 429);
  }

  static internalError(res, message = '内部服务器错误', details = null) {
    this.error(res, message, 500, details);
  }
}

module.exports = ResponseHelper;