<script setup lang="ts">
import { useRouteProgress } from '@/utils/route-progress'

const { active, progress } = useRouteProgress()
</script>

<template>
  <Transition name="rp">
    <div v-if="active" class="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
      <div
        class="h-full rounded-r-full bg-gradient-to-r from-brand-500 to-brand-400 shadow-[0_0_10px_0_var(--color-brand-500),0_0_4px_0_var(--color-brand-400)] transition-[width] duration-200 ease-out"
        :style="{ width: progress + '%' }"
      />
    </div>
  </Transition>
</template>

<style scoped>
.rp-enter-active {
  transition: opacity 0.2s ease;
}
.rp-leave-active {
  transition: opacity 0.35s ease;
}
.rp-enter-from,
.rp-leave-to {
  opacity: 0;
}
</style>
