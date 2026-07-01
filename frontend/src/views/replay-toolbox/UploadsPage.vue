<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import ReplayUploadTable from '@/components/replay/ReplayUploadTable.vue'

const route = useRoute()
const store = useReplayToolboxStore()

const principalId = computed(() => route.params.principalId as string)

function handleUploadPageChange(page: number) {
  store.fetchUploads({ page })
}

onMounted(async () => {
  store.selectedPrincipalId = principalId.value
  await store.fetchUploads({ page: 1 })
})

watch(principalId, async (id) => {
  store.selectedPrincipalId = id
  await store.fetchUploads({ page: 1 })
})
</script>

<template>
  <ReplayUploadTable
    :uploads="store.uploads"
    :loading="store.loadingUploads"
    :upload-page="store.uploadPage"
    :upload-total="store.uploadTotal"
    :upload-page-size="store.uploadPageSize"
    @upload-page-change="handleUploadPageChange"
  />
</template>
