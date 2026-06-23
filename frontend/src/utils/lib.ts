/**
 * 基础库函数
 */

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

/**
 * 最近时间可读显示
 */
export function timeAgo(time: string | number | Date) {
  return dayjs(time).fromNow()
}

/**
 * 统一时间格式化显示
 */
export function formatTime(time: string | number | Date, format = 'YYYY-MM-DD HH:mm:ss') {
  return dayjs(time).format(format)
}

/**
 * 格式化字节数为可读字符串
 *
 * @param bytes 字节数，支持 number / string / null / undefined
 * @returns 如 '1.5 GB'，无效值返回 '-'
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n)) return '-'
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
