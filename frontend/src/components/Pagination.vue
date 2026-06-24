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

const pages = computed(() => {
  const max = 7
  let start = Math.max(1, props.current - 3)
  const end = Math.min(totalPages.value, start + max - 1)
  if (end - start < max - 1) {
    start = Math.max(1, end - max + 1)
  }
  const result: number[] = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
})
</script>

<template>
  <div class="flex items-center justify-between mt-4">
    <span class="text-sm text-gray-500">共 {{ total }} 条记录</span>
    <nav v-if="totalPages > 1" class="flex items-center gap-1">
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
        上一页
      </button>
      <button
        v-for="p in pages"
        :key="p"
        class="px-2.5 py-1 text-sm rounded border transition-colors"
        :class="
          p === current
            ? 'bg-brand-600 text-white border-brand-600'
            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
        "
        @click="emit('change', p)"
      >
        {{ p }}
      </button>
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
        下一页
      </button>
    </nav>
  </div>
</template>
