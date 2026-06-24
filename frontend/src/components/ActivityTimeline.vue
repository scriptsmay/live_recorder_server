<script setup lang="ts">
import { computed, ref } from 'vue'
import { timeAgo } from '@/utils/lib'
import type { ActivityItem } from '@/types/api'

const props = defineProps<{
  activities: ActivityItem[]
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  retry: []
}>()

const expanded = ref(false)
const INITIAL_COUNT = 6

const visibleActivities = computed(() =>
  expanded.value ? props.activities : props.activities.slice(0, INITIAL_COUNT),
)
const hasMore = computed(() => props.activities.length > INITIAL_COUNT)

const typeMeta: Record<ActivityItem['type'], { dot: string; label: string }> = {
  session_completed: { dot: 'bg-green-500', label: '录制完成' },
  session_interrupted: { dot: 'bg-red-500', label: '录制中断' },
  upload_success: { dot: 'bg-orange-500', label: '投稿成功' },
  upload_failed: { dot: 'bg-red-500', label: '投稿失败' },
  transcode_completed: { dot: 'bg-blue-500', label: '转码完成' },
  transcode_failed: { dot: 'bg-red-500', label: '转码失败' },
}

function metaOf(type: ActivityItem['type']) {
  return typeMeta[type] ?? { dot: 'bg-gray-400', label: type }
}

function activityKey(item: ActivityItem) {
  return `${item.type}:${item.timestamp}:${item.title}`
}
</script>

<template>
  <section class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="px-6 py-3 border-b border-gray-200">
      <h2 class="text-sm font-semibold text-gray-900">近期活动</h2>
    </div>

    <div v-if="loading" class="p-5 space-y-3">
      <div v-for="i in 3" :key="i" class="flex items-center gap-3 animate-pulse">
        <div class="w-2.5 h-2.5 rounded-full bg-gray-200"></div>
        <div class="flex-1">
          <div class="h-3 bg-gray-200 rounded w-2/3 mb-2"></div>
          <div class="h-2.5 bg-gray-100 rounded w-1/3"></div>
        </div>
      </div>
    </div>

    <div v-else-if="error" class="px-6 py-8 text-center">
      <p class="text-sm text-red-600 mb-3">加载失败</p>
      <button
        class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        @click="emit('retry')"
      >
        重试
      </button>
    </div>

    <div
      v-else-if="props.activities.length === 0"
      class="px-6 py-10 text-center text-sm text-gray-400"
    >
      暂无近期活动
    </div>

    <template v-else>
      <TransitionGroup name="activity-list" tag="div" class="divide-y divide-gray-100">
        <div v-for="item in visibleActivities" :key="activityKey(item)">
          <router-link
            v-if="item.link"
            :to="item.link"
            class="flex items-start gap-3 px-6 py-2.5 hover:bg-gray-50 active:bg-gray-100 transition-colors no-underline"
          >
            <span class="mt-2 h-2 w-2 rounded-full shrink-0" :class="metaOf(item.type).dot"></span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium text-gray-900 truncate">{{ item.title }}</span>
                <span class="text-xs text-gray-400 shrink-0">{{ timeAgo(item.timestamp) }}</span>
              </span>
              <span class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                <span>{{ metaOf(item.type).label }}</span>
                <span class="text-gray-200">·</span>
                <span class="truncate">{{ item.detail }}</span>
              </span>
            </span>
          </router-link>

          <div v-else class="flex items-start gap-3 px-6 py-2.5">
            <span class="mt-2 h-2 w-2 rounded-full shrink-0" :class="metaOf(item.type).dot"></span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium text-gray-900 truncate">{{ item.title }}</span>
                <span class="text-xs text-gray-400 shrink-0">{{ timeAgo(item.timestamp) }}</span>
              </span>
              <span class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                <span>{{ metaOf(item.type).label }}</span>
                <span class="text-gray-200">·</span>
                <span class="truncate">{{ item.detail }}</span>
              </span>
            </span>
          </div>
        </div>
      </TransitionGroup>

      <div v-if="hasMore" class="border-t border-gray-100">
        <button
          type="button"
          class="w-full py-2.5 text-xs font-medium text-gray-500 hover:text-brand-600 hover:bg-gray-50 transition-colors"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : `查看全部 ${props.activities.length} 条` }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.activity-list-enter-active,
.activity-list-move {
  transition: all 0.3s ease;
}

.activity-list-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}

.activity-list-leave-active {
  position: absolute;
}
</style>
