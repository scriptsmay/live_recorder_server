<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string | number
    sublines?: string[]
    warning?: string
    to?: string
    iconPath: string
    tone?: string
    loading?: boolean
  }>(),
  {
    sublines: () => [],
    warning: '',
    to: '',
    tone: 'indigo',
    loading: false,
  },
)

const toneMap: Record<string, { icon: string; glow: string; wrap: string }> = {
  indigo: { icon: 'text-indigo-400', glow: 'bg-indigo-500/50', wrap: 'bg-indigo-500/10' },
  blue: { icon: 'text-blue-400', glow: 'bg-blue-500/50', wrap: 'bg-blue-500/10' },
  amber: { icon: 'text-amber-400', glow: 'bg-amber-500/50', wrap: 'bg-amber-500/10' },
  cyan: { icon: 'text-cyan-400', glow: 'bg-cyan-500/50', wrap: 'bg-cyan-500/10' },
  teal: { icon: 'text-teal-400', glow: 'bg-teal-500/50', wrap: 'bg-teal-500/10' },
  rose: { icon: 'text-rose-400', glow: 'bg-rose-500/50', wrap: 'bg-rose-500/10' },
  purple: { icon: 'text-purple-400', glow: 'bg-purple-500/50', wrap: 'bg-purple-500/10' },
  emerald: { icon: 'text-emerald-400', glow: 'bg-emerald-500/50', wrap: 'bg-emerald-500/10' },
}

const palette = computed(() => toneMap[props.tone] ?? toneMap.indigo)
</script>

<template>
  <component
    :is="to ? 'router-link' : 'div'"
    :to="to"
    class="group relative block min-h-[136px] overflow-hidden rounded-xl p-5 hairline-card shimmer-sweep transition-all duration-200"
    :class="to ? 'cursor-pointer hover:-translate-y-0.5 hover:border-gray-300' : ''"
  >
    <div
      class="pointer-events-none absolute -right-8 -top-12 h-24 w-24 rounded-full blur-2xl transition-opacity duration-300 opacity-40 group-hover:opacity-80"
      :class="palette.glow"
    />

    <div v-if="loading" class="relative animate-pulse">
      <div class="mb-4 h-3 w-20 rounded bg-gray-200" />
      <div class="mb-3 h-8 w-14 rounded bg-gray-200" />
      <div class="h-3 w-28 rounded bg-gray-100" />
    </div>

    <div v-else class="relative flex items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="text-[0.8rem] font-medium text-gray-400">{{ label }}</div>
        <div class="mt-1.5 text-3xl font-semibold tracking-tight text-gray-900 tabular-nums">
          {{ value }}
        </div>
        <div class="mt-1.5 space-y-0.5">
          <div v-for="line in sublines" :key="line" class="text-xs text-gray-500">
            {{ line }}
          </div>
          <div v-if="warning" class="text-xs font-medium text-amber-400">{{ warning }}</div>
        </div>
      </div>
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200"
        :class="palette.wrap"
      >
        <svg
          class="h-5 w-5"
          :class="palette.icon"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" :d="iconPath" />
        </svg>
      </div>
    </div>
  </component>
</template>
