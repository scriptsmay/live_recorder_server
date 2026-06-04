import type { App } from 'vue'
import { timeAgo, formatTime } from '../utils/lib'

/**
 * 时间格式化 Vue 插件
 * 向全局属性注入 $formatTime 和 $timeAgo 两个格式化工具方法
 */
export default {
  /**
   * 插件安装函数，在 app.use() 时被调用
   * @param app - Vue 应用实例
   */
  install(app: App) {
    /**
     * 将日期格式化为指定格式的字符串
     * @param date - 待格式化的日期，支持字符串、时间戳或 Date 对象
     * @param format - 输出格式，默认为 'YYYY-MM-DD HH:mm:ss'
     * @param omit - 当 date 为空值时的替代返回值，默认为空字符串
     * @returns 格式化后的时间字符串，或 date 为空时返回 omit 值
     */
    app.config.globalProperties.$formatTime = (
      date: string | number | Date | null | undefined,
      options: {
        format?: string
        omit?: string
      } = {},
    ): string => {
      const { format = 'YYYY-MM-DD HH:mm:ss', omit = '-' } = options

      if (!date) return omit
      return formatTime(date, format)
    }

    /**
     * 将日期转换为相对时间描述（如"3 小时前"）
     * @param date - 目标日期，支持字符串、时间戳或 Date 对象
     * @returns 相对时间描述字符串，date 为空时返回空字符串
     */
    app.config.globalProperties.$timeAgo = (date: string | number | Date): string => {
      if (!date) return ''
      return timeAgo(date)
    }
  },
}
