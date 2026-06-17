/**
 * 统一的 API 请求封装
 *
 * 基于原生 fetch，提供：
 * - 自动 JSON 解析
 * - 统一错误处理
 * - 请求/响应拦截（可扩展）
 */

export interface ApiResponse<T = unknown> {
  status: string
  data: T
  message?: string
}

export class ApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}

let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

async function request<T>(url: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  const res = await fetch(url, { ...options, headers })
  if (res.status === 401 && unauthorizedHandler) {
    unauthorizedHandler()
  }

  // 非 JSON 响应直接返回文本
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!res.ok) {
      throw new ApiError(res.status, `请求失败: ${res.statusText}`)
    }
    return { status: 'ok', data: (await res.text()) as unknown as T }
  }

  const body = await res.json()

  if (!res.ok) {
    const message = body.message ?? body.error ?? `请求失败 (${res.status})`
    throw new ApiError(res.status, message)
  }

  return body as ApiResponse<T>
}

/** GET 请求 */
export function apiGet<T = unknown>(url: string): Promise<ApiResponse<T>> {
  return request<T>(url)
}

/** POST 请求 */
export function apiPost<T = unknown>(url: string, data?: unknown): Promise<ApiResponse<T>> {
  return request<T>(url, {
    method: 'POST',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  })
}

/** PUT 请求 */
export function apiPut<T = unknown>(url: string, data?: unknown): Promise<ApiResponse<T>> {
  return request<T>(url, {
    method: 'PUT',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  })
}

/** DELETE 请求 */
export function apiDelete<T = unknown>(url: string, data?: unknown): Promise<ApiResponse<T>> {
  return request<T>(url, {
    method: 'DELETE',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  })
}
