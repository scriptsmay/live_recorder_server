<script setup lang="ts">
defineProps<{
  modelValue: boolean
  label: string
  description?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [boolean]
}>()
</script>

<template>
  <label class="flex items-center gap-3 cursor-pointer select-none">
    <input
      :checked="modelValue"
      type="checkbox"
      class="sr-only"
      @change="emit('update:modelValue', !modelValue)"
    />

    <div
      class="relative h-6 w-11 rounded-full transition-colors duration-200"
      :class="modelValue ? 'bg-brand-600' : 'bg-gray-300'"
    >
      <span
        class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
        :class="modelValue ? 'translate-x-5' : ''"
      />
    </div>

    <div>
      <div class="text-sm font-medium text-gray-700">
        {{ label }}
      </div>

      <div v-if="description" class="text-xs text-gray-400">
        {{ description }}
      </div>
    </div>
  </label>
</template>
