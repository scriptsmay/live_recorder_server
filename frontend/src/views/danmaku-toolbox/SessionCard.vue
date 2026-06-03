<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolboxSession } from '@/stores/danmaku-toolbox'
import SegmentsPanel from './SegmentsPanel.vue'

const props = defineProps<{
  session: ToolboxSession
  selected: boolean
}>()

const emit = defineEmits<{
  'toggle-select': [sessionId: number]
  'generate-ass': [sessionId: number]
  'burn-session': [sessionId: number, force: boolean]
  'search-danmaku': [sessionId: number, roomName: string]
}>()

const segmentsExpanded = ref(false)
const segmentsLoaded = ref(false)

const isDone = computed(() => {
  return props.session.status === 'completed' || props.session.status === 'interrupted'
})

const burnProgress = computed(() => {
  const total = props.session.danmaku_burn_total || 0
  const completed = props.session.danmaku_burn_completed || 0
  if (total <= 0 || completed >= total) return null
  return Math.round((completed / total) * 100)
})

const danmakuBadge = computed(() => {
  const s = props.session
  const count = s.danmaku_event_count || 0
  if (s.danmaku_status === 'recording')
    return { text: `采集中 (${count})`, cls: 'bg-red-100 text-red-700' }
  if (s.danmaku_status === 'completed')
    return { text: `已完成 · ${count} 条`, cls: 'bg-green-100 text-green-700' }
  if (s.danmaku_status === 'failed') return { text: '采集失败', cls: 'bg-red-100 text-red-600' }
  if (count > 0) return { text: `${count} 条`, cls: 'bg-gray-100 text-gray-600' }
  return null
})

const burnBadge = computed(() => {
  const s = props.session
  const total = s.danmaku_burn_total || 0
  const completed = s.danmaku_burn_completed || 0
  const failed = s.danmaku_burn_failed || 0
  if (total <= 0) return null
  if (failed > 0)
    return { text: `${completed}/${total} (${failed} 失败)`, cls: 'bg-red-100 text-red-600' }
  if (completed === total)
    return { text: `压制完成 ${completed}/${total}`, cls: 'bg-green-100 text-green-700' }
  return { text: `压制中 ${completed}/${total}`, cls: 'bg-amber-100 text-amber-700' }
})

const sessionBadge = computed(() => {
  const s = props.session
  if (s.status === 'recording')
    return { text: '录制中', cls: 'bg-red-100 text-red-700 animate-pulse' }
  if (s.status === 'completed') return { text: '已完成', cls: 'bg-green-100 text-green-700' }
  if (s.status === 'interrupted') return { text: '已中断', cls: 'bg-gray-200 text-gray-600' }
  return null
})
</script>

<template>
  <div
    class="bg-white rounded-xl border shadow-sm overflow-hidden transition-all hover:shadow-md mb-3"
    :class="selected ? 'border-brand-500 ring-2 ring-brand-500/15' : 'border-gray-200'"
  >
    <!-- 卡片头部 -->
    <div
      class="flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 flex-wrap"
      style="background: linear-gradient(135deg, #fff7ed 0%, #ffffff 60%)"
    >
      <input
        type="checkbox"
        :checked="selected"
        class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
        @change="emit('toggle-select', session.id)"
      />
      <span
        class="inline-flex items-center bg-brand-600 text-white text-xs font-bold px-2 py-0.5 rounded-md shrink-0"
      >
        #{{ session.id }}
      </span>
      <span
        class="text-sm font-semibold text-gray-900 flex-1 min-w-0 truncate"
        :title="session.room_url || ''"
      >
        {{ session.room_name || session.room_url || '未命名' }}
      </span>
      <div class="flex items-center gap-1.5 shrink-0 flex-wrap">
        <span
          v-if="danmakuBadge"
          class="text-xs font-medium px-2 py-0.5 rounded-full"
          :class="danmakuBadge.cls"
          >{{ danmakuBadge.text }}</span
        >
        <span
          v-if="burnBadge"
          class="text-xs font-medium px-2 py-0.5 rounded-full"
          :class="burnBadge.cls"
          >{{ burnBadge.text }}</span
        >
        <span
          v-if="sessionBadge"
          class="text-xs font-medium px-2 py-0.5 rounded-full"
          :class="sessionBadge.cls"
          >{{ sessionBadge.text }}</span
        >
      </div>
    </div>

    <!-- 卡片主体 -->
    <div class="px-4 py-3">
      <!-- 元信息行 -->
      <div class="flex items-center flex-wrap gap-x-4 gap-y-1 mb-2">
        <span class="inline-flex items-center gap-1 text-xs text-gray-500">
          弹幕
          <strong class="text-gray-900 font-semibold">{{
            session.danmaku_event_count || 0
          }}</strong>
          条
        </span>
        <span
          v-if="session.ass_segment_count"
          class="inline-flex items-center gap-1 text-xs text-gray-500"
        >
          ASS
          <strong class="text-gray-900 font-semibold">{{ session.ass_segment_count }}</strong> 段
        </span>
        <span
          v-if="session.danmaku_burn_total > 0"
          class="inline-flex items-center gap-1 text-xs text-gray-500"
        >
          压制
          <strong class="text-gray-900 font-semibold">{{
            session.danmaku_burn_completed || 0
          }}</strong
          >/{{ session.danmaku_burn_total }}
        </span>
      </div>

      <!-- 压制进度条 -->
      <div v-if="burnProgress !== null" class="h-1 rounded-full bg-gray-200 overflow-hidden mb-2">
        <div
          class="h-full rounded-full bg-gradient-to-r from-green-500 to-green-600 transition-all duration-500"
          :style="{ width: burnProgress + '%' }"
        />
      </div>

      <!-- 操作按钮 -->
      <div class="flex items-center flex-wrap gap-1.5 mt-2">
        <button
          class="px-2.5 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          @click="segmentsExpanded = !segmentsExpanded"
        >
          {{ segmentsExpanded ? '收起分段' : '展开分段' }}
        </button>

        <template v-if="isDone">
          <button
            class="px-2.5 py-1 text-xs font-medium rounded-md border border-sky-300 text-sky-700 hover:bg-sky-50 transition-colors"
            @click="emit('generate-ass', session.id)"
          >
            生成 ASS
          </button>
          <button
            class="px-2.5 py-1 text-xs font-medium rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            @click="emit('burn-session', session.id, false)"
          >
            全部压制
          </button>
          <button
            class="px-2.5 py-1 text-xs font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
            @click="emit('burn-session', session.id, true)"
          >
            强制重压
          </button>
        </template>

        <button
          class="px-2.5 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          @click="emit('search-danmaku', session.id, session.room_name || '')"
        >
          搜索弹幕
        </button>

        <router-link
          :to="`/sessions/${session.id}/danmaku`"
          class="px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 text-blue-700 hover:bg-blue-50 transition-colors no-underline"
        >
          详情页
        </router-link>
      </div>

      <!-- 分段面板（折叠区） -->
      <SegmentsPanel
        v-if="segmentsExpanded"
        :session-id="session.id"
        :loaded="segmentsLoaded"
        @loaded="segmentsLoaded = true"
      />
    </div>
  </div>
</template>
