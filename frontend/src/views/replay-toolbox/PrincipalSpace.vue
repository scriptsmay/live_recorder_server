<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'

const route = useRoute()
const router = useRouter()
const store = useReplayToolboxStore()

const principalId = computed(() => route.params.principalId as string)

const principal = computed(
  () => store.principals.find((p) => p.principal_id === principalId.value) ?? null,
)

const tabs = [
  { name: 'records', label: '回放记录', to: 'records' },
  { name: 'uploads', label: '投稿记录', to: 'uploads' },
  { name: 'tasks', label: '任务队列', to: 'tasks' },
  { name: 'settings', label: '配置', to: 'settings' },
]

const activeTab = computed(() => {
  const matched = route.matched
  const last = matched[matched.length - 1]
  return last?.name?.toString().replace('replay-', '') || 'records'
})

onMounted(async () => {
  if (store.principals.length === 0) {
    await store.fetchPrincipals()
  }
  store.selectedPrincipalId = principalId.value
})

watch(principalId, async (id) => {
  store.selectedPrincipalId = id
})

function navigateToTab(tab: string) {
  router.push(`/replay-toolbox/${principalId.value}/${tab}`)
}
</script>

<template>
  <div>
    <div class="flex items-center gap-3 mb-3">
      <router-link
        to="/replay-toolbox"
        class="text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        ← 返回主播列表
      </router-link>
    </div>

    <div
      class="flex flex-col sm:flex-row sm:items-center gap-8 mb-3 bg-white p-4 rounded-lg shadow-sm"
    >
      <div>
        <h1 class="text-2xl font-bold text-gray-900">
          {{ principal?.room_name || principalId }}
        </h1>
        <p class="text-sm text-gray-500 mt-1">{{ principalId }}</p>
      </div>
      <div class="flex gap-1 border-b border-gray-200">
        <button
          v-for="tab in tabs"
          :key="tab.name"
          class="px-4 py-2 text-sm font-medium transition-colors -mb-px"
          :class="
            activeTab === tab.name
              ? 'text-brand-600 border-b-2 border-brand-600'
              : 'text-gray-500 hover:text-gray-700'
          "
          @click="navigateToTab(tab.to)"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <router-view />
  </div>
</template>
