/**
 * 基础库函数
 */

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
dayjs.extend(relativeTime)

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
