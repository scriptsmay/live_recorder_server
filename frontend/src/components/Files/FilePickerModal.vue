<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { apiGet } from '@/utils/api'
import type { ManagedFile } from '@/types/file-manage'
import Modal from '@/components/Modal.vue'
import Pagination from '@/components/Pagination.vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title?: string
    fileType?: string | string[]
    category?: string
    modelValue?: ManagedFile | null
  }>(),
  {
    title: '选择文件',
    fileType: undefined,
    category: undefined,
    modelValue: null,
  },
)

const emit = defineEmits<{
  'update:visible': [value: boolean]
  select: [file: ManagedFile]
}>()

// ---- 状态 ----
const files = ref<ManagedFile[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const search = ref('')
const selected = ref<ManagedFile | null>(null)

let searchTimer: ReturnType<typeof setTimeout> | null = null

// ---- 工具函数 ----
function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatTime(ts: string | null): string {
  if (!ts) return '-'
  return ts.replace('T', ' ').replace(/\.\d+Z?$/, '')
}

// ---- 数据加载 ----
async function loadFiles() {
  loading.value = true
  try {
    const params: Record<string, string | number | boolean> = {
      status: 'active',
      exists_on_disk: true,
      page: page.value,
      limit: 20,
      sort: 'mtime DESC',
    }
    if (props.fileType) {
      params.type = Array.isArray(props.fileType) ? props.fileType[0] : props.fileType
    }
    if (props.category) {
      params.category = props.category
    }
    if (search.value.trim()) {
      params.search = search.value.trim()
    }
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    const res = await apiGet<{ data: ManagedFile[]; total: number }>(`/api/files?${qs}`)
    files.value = res.data ?? []
    total.value = res.total ?? 0
  } catch {
    files.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// ---- 搜索防抖 ----
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    loadFiles()
  }, 300)
}

// ---- 选择 ----
function selectFile(file: ManagedFile) {
  selected.value = selected.value?.id === file.id ? null : file
}

function confirmSelect() {
  if (selected.value) {
    emit('select', selected.value)
    close()
  }
}

function close() {
  emit('update:visible', false)
}

// ---- 键盘 ----
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

// ---- 生命周期 ----
watch(
  () => props.visible,
  (v) => {
    if (v) {
      selected.value = props.modelValue ?? null
      search.value = ''
      page.value = 1
      loadFiles()
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
)
</script>

<template>
  <Modal :visible="visible" :title="title" max-width="max-w-4xl" @update:visible="close">
    <!-- 搜索栏 -->
    <div class="px-6 pt-4 pb-3 border-b border-gray-100">
      <input
        v-model="search"
        type="text"
        placeholder="搜索文件名..."
        class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
        @input="onSearchInput"
      />
    </div>

    <!-- 文件列表 -->
    <div class="px-6 py-2 min-h-[300px] max-h-[50vh] overflow-y-auto">
      <div v-if="loading" class="py-12 text-center text-sm text-gray-400">加载中...</div>
      <div v-else-if="files.length === 0" class="py-12 text-center text-sm text-gray-400">
        暂无可用文件
      </div>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500 border-b border-gray-100">
            <th class="pb-2 font-medium">文件名</th>
            <th class="pb-2 font-medium w-24 text-right">大小</th>
            <th class="pb-2 font-medium w-40">修改时间</th>
            <th class="pb-2 font-medium w-20">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="file in files"
            :key="file.id"
            class="cursor-pointer transition-colors border-b border-gray-50"
            :class="
              selected?.id === file.id
                ? 'bg-brand-50 ring-1 ring-brand-300'
                : 'hover:bg-gray-50'
            "
            @click="selectFile(file)"
            @dblclick="selectFile(file); confirmSelect()"
          >
            <td class="py-2.5 pr-3">
              <div class="font-medium text-gray-900 truncate max-w-[400px]" :title="file.file_path">
                {{ file.file_name || file.file_path }}
              </div>
              <div class="text-xs text-gray-400 truncate max-w-[400px]">{{ file.file_path }}</div>
            </td>
            <td class="py-2.5 text-right text-gray-600">{{ formatBytes(file.file_size) }}</td>
            <td class="py-2.5 text-gray-500">{{ formatTime(file.mtime) }}</td>
            <td class="py-2.5">
              <span
                class="inline-block px-1.5 py-0.5 text-xs rounded-full"
                :class="
                  file.safe_to_delete
                    ? 'bg-green-100 text-green-700'
                    : 'bg-gray-100 text-gray-500'
                "
              >
                {{ file.safe_to_delete ? '可清理' : '受保护' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div class="px-6 pb-2">
      <Pagination :current="page" :total="total" @change="(p: number) => { page = p; loadFiles() }" />
    </div>

    <!-- 底部操作栏 -->
    <div
      class="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl"
    >
      <div class="text-sm text-gray-500">
        <template v-if="selected">
          已选：<span class="font-medium text-gray-900">{{ selected.file_name }}</span>
          <span class="text-gray-400 ml-1">({{ formatBytes(selected.file_size) }})</span>
        </template>
        <template v-else> 请选择一个文件 </template>
      </div>
      <div class="flex gap-2">
        <button
          class="px-4 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
          @click="close"
        >
          取消
        </button>
        <button
          class="px-4 py-1.5 text-sm rounded-lg text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="selected ? 'bg-brand-600 hover:bg-brand-700' : 'bg-gray-300'"
          :disabled="!selected"
          @click="confirmSelect"
        >
          确认选择
        </button>
      </div>
    </div>
  </Modal>
</template>
