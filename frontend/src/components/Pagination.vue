<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    current: number
    total: number
    pageSize?: number
  }>(),
  {
    pageSize: 50,
  },
)

const emit = defineEmits<{
  change: [page: number]
}>()

const totalPages = computed(() => Math.ceil(props.total / props.pageSize) || 1)

type PageItem = { type: 'page'; num: number } | { type: 'ellipsis'; key: string }

const pageItems = computed<PageItem[]>(() => {
  const tp = totalPages.value
  const cur = props.current

  if (tp <= 7) {
    return Array.from({ length: tp }, (_, i) => ({ type: 'page', num: i + 1 }))
  }

  const items: PageItem[] = []

  // Always show page 1
  items.push({ type: 'page', num: 1 })

  // Window of 5 pages around current
  let windowStart = Math.max(2, cur - 2)
  let windowEnd = Math.min(tp - 1, cur + 2)

  // Adjust window to keep size 5 when near edges
  if (cur <= 4) {
    windowEnd = Math.min(tp - 1, 5)
  } else if (cur >= tp - 3) {
    windowStart = Math.max(2, tp - 4)
  }

  // Ellipsis before window
  if (windowStart > 2) {
    items.push({ type: 'ellipsis', key: 'ellipsis-start' })
  }

  // Window pages
  for (let i = windowStart; i <= windowEnd; i++) {
    items.push({ type: 'page', num: i })
  }

  // Ellipsis after window
  if (windowEnd < tp - 1) {
    items.push({ type: 'ellipsis', key: 'ellipsis-end' })
  }

  // Always show last page
  if (tp > 1) {
    items.push({ type: 'page', num: tp })
  }

  return items
})
</script>

<template>
  <div class="flex items-center justify-between mt-4">
    <span class="text-sm text-gray-500">共 {{ total }} 条记录</span>
    <nav v-if="totalPages > 1" class="flex items-center gap-1">
      <!-- 首页 -->
      <button
        class="px-2 py-1 text-sm rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="
          current <= 1
            ? 'border-gray-200 text-gray-300'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
        "
        :disabled="current <= 1"
        title="首页"
        @click="emit('change', 1)"
      >
        «
      </button>

      <!-- 上一页 -->
      <button
        class="px-2.5 py-1 text-sm rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="
          current <= 1
            ? 'border-gray-200 text-gray-300'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
        "
        :disabled="current <= 1"
        @click="emit('change', current - 1)"
      >
        ‹
      </button>

      <!-- 页码 / 省略号 -->
      <template v-for="item in pageItems" :key="item.type === 'page' ? item.num : item.key">
        <button
          v-if="item.type === 'page'"
          class="px-2.5 py-1 text-sm rounded border transition-colors"
          :class="
            item.num === current
              ? 'bg-brand-600 text-white border-brand-600'
              : 'border-gray-300 text-gray-600 hover:bg-gray-100'
          "
          @click="emit('change', item.num)"
        >
          {{ item.num }}
        </button>
        <span v-else class="px-1 text-sm text-gray-400 select-none">…</span>
      </template>

      <!-- 下一页 -->
      <button
        class="px-2.5 py-1 text-sm rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="
          current >= totalPages
            ? 'border-gray-200 text-gray-300'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
        "
        :disabled="current >= totalPages"
        @click="emit('change', current + 1)"
      >
        ›
      </button>

      <!-- 末页 -->
      <button
        class="px-2 py-1 text-sm rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="
          current >= totalPages
            ? 'border-gray-200 text-gray-300'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
        "
        :disabled="current >= totalPages"
        title="末页"
        @click="emit('change', totalPages)"
      >
        »
      </button>
    </nav>
  </div>
</template>