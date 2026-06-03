<script setup lang="ts">
defineProps<{
  activeCaptures: number
  queueLength: number
  processing: number
  sessionCount: number
}>()
</script>

<template>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    <!-- 采集中 -->
    <div class="flex items-center gap-3 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div
        class="w-10 h-10 rounded-lg bg-gradient-to-br from-green-500 to-green-600 flex items-center justify-center text-white shrink-0"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 16 16">
          <path d="M6 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM1 9h14v1H1z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </div>
      <div>
        <div class="text-xl font-bold text-gray-900">{{ activeCaptures }}</div>
        <div class="text-xs text-gray-500">采集中</div>
      </div>
    </div>

    <!-- 排队中 -->
    <div class="flex items-center gap-3 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div
        class="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center text-white shrink-0"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 16 16">
          <path
            d="M5 10.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"
          />
          <path
            d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3z"
          />
        </svg>
      </div>
      <div>
        <div class="text-xl font-bold text-gray-900">{{ queueLength }}</div>
        <div class="text-xs text-gray-500">排队中</div>
      </div>
    </div>

    <!-- 压制中 -->
    <div class="flex items-center gap-3 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div
        class="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-600 to-violet-700 flex items-center justify-center text-white shrink-0"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 16 16">
          <path
            d="M8 16c.319 0 .616-.18.762-.471l.206-.412 2.049-4.098a.4.4 0 0 0-.078-.459L8.477 7.64a.2.2 0 0 1-.043-.118l.545-5.454a.25.25 0 0 0-.417-.203L5.93 4.488a.4.4 0 0 1-.459.078L2.35 3.004a.25.25 0 0 0-.325.325l1.562 3.121a.4.4 0 0 1-.078.459L.488 9.94a.25.25 0 0 0 .203.417l5.454.545a.2.2 0 0 1 .118.043l3.49 3.49A.25.25 0 0 0 8 16z"
          />
        </svg>
      </div>
      <div>
        <div class="text-xl font-bold text-gray-900">{{ processing }}</div>
        <div class="text-xs text-gray-500">压制中</div>
      </div>
    </div>

    <!-- 会话总数 -->
    <div class="flex items-center gap-3 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <div
        class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shrink-0"
      >
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 16 16">
          <path
            d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13.5a.5.5 0 0 1-.777.416L8 13.101l-5.223 2.815A.5.5 0 0 1 2 15.5V2zm2-1a1 1 0 0 0-1 1v12.566l4.723-2.482a.5.5 0 0 1 .554 0L13 14.566V2a1 1 0 0 0-1-1H4z"
          />
        </svg>
      </div>
      <div>
        <div class="text-xl font-bold text-gray-900">{{ sessionCount }}</div>
        <div class="text-xs text-gray-500">会话总数</div>
      </div>
    </div>
  </div>
</template>
