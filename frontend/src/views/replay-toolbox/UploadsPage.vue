<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import ReplayUploadTable from '@/components/replay/ReplayUploadTable.vue'

const route = useRoute()
const store = useReplayToolboxStore()

const principalId = computed(() => route.params.principalId as string)

onMounted(async () => {
  store.selectedPrincipalId = principalId.value
  await store.fetchUploads()
})

watch(principalId, async (id) => {
  store.selectedPrincipalId = id
  await store.fetchUploads()
})
</script>

<template>
  <ReplayUploadTable :uploads="store.uploads" :loading="store.loadingUploads" />
</template>
