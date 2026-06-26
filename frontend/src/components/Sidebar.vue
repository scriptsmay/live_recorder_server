<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserMenu from './UserMenu.vue'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

// ---- 折叠状态 ----
const emit = defineEmits<{ 'update:collapsed': [value: boolean] }>()
const collapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')
watch(collapsed, (val) => {
  localStorage.setItem('sidebar-collapsed', String(val))
  emit('update:collapsed', val)
})
function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

// ---- 分组折叠状态 ----
const collapsedGroups = ref<Record<string, boolean>>({})
try {
  const saved = localStorage.getItem('sidebar-collapsed-groups')
  if (saved) collapsedGroups.value = JSON.parse(saved)
} catch {
  console.log('Failed to load collapsed groups')
}
watch(
  collapsedGroups,
  (val) => localStorage.setItem('sidebar-collapsed-groups', JSON.stringify(val)),
  { deep: true },
)

function toggleGroup(label: string) {
  collapsedGroups.value[label] = !collapsedGroups.value[label]
}

// ---- 移动端抽屉 ----
const mobileOpen = ref(false)
function closeMobile() {
  mobileOpen.value = false
}
router.afterEach(() => {
  if (window.innerWidth < 1024) closeMobile()
})

// ---- 菜单配置 ----
interface MenuItem {
  label: string
  to: string
  icon: string
}

interface MenuGroup {
  label: string
  icon: string
  children?: MenuItem[]
  to?: string
}

const menuGroups: MenuGroup[] = [
  {
    label: '概览',
    icon: 'M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0-.5 1.5 1.5m0 0 1-3',
    to: '/dashboard',
  },
  {
    label: '直播录制',
    icon: 'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
    children: [
      {
        label: '直播间',
        to: '/rooms',
        icon: 'M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72L4.318 3.44A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72m-13.5 8.65h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .415.336.75.75.75Z',
      },
      { label: '录制会话', to: '/sessions', icon: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
      {
        label: '录制文件',
        to: '/recordings',
        icon: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
      },
      {
        label: '转码记录',
        to: '/transcode',
        icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
      },
    ],
  },
  {
    label: '直播回放',
    icon: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    children: [
      {
        label: '回放工具箱',
        to: '/replay-toolbox',
        icon: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
      },
    ],
  },
  {
    label: '投稿',
    icon: 'M6 12 3.269 3.126A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.876L6 12Zm0 0h7.5',
    children: [
      {
        label: '投稿管理',
        to: '/templates',
        icon: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
      },
      {
        label: '投稿记录',
        to: '/upload-records',
        icon: 'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z',
      },
    ],
  },
  {
    label: '系统',
    icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
    children: [
      {
        label: '设置',
        to: '/settings',
        icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
      },
      {
        label: '文件管理',
        to: '/files',
        icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
      },
      {
        label: '日志',
        to: '/logs',
        icon: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Zm3.75 11.625a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
      },
      {
        label: 'API 文档',
        to: '/api-doc',
        icon: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
      },
    ],
  },
]

// ---- 高亮逻辑 ----
function isInGroup(group: MenuGroup): boolean {
  if (!group.children) return group.to ? route.path === group.to : false
  return group.children.some(
    (item) => route.path === item.to || route.path.startsWith(item.to + '/'),
  )
}

function isActive(item: MenuItem): boolean {
  return route.path === item.to || route.path.startsWith(item.to + '/')
}

// ---- Tooltip ----
const tooltip = ref<{ text: string; top: number } | null>(null)
function showTooltip(e: MouseEvent, text: string) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  tooltip.value = { text, top: rect.top + rect.height / 2 }
}
function hideTooltip() {
  tooltip.value = null
}
</script>

<template>
  <!-- 移动端汉堡按钮 -->
  <button
    class="lg:hidden fixed top-3 left-3 z-50 p-2 rounded-lg text-gray-300 bg-black/40 hover:text-white hover:bg-black/60 transition-colors"
    @click="mobileOpen = true"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  </button>

  <!-- 移动端遮罩 -->
  <Transition name="fade">
    <div
      v-if="mobileOpen"
      class="sidebar-overlay lg:hidden fixed inset-0 bg-black/50 z-40"
      @click="closeMobile"
    />
  </Transition>

  <!-- 侧边栏 -->
  <aside
    class="fixed top-0 left-0 h-full bg-gray-900 border-r border-gray-700 z-50 flex flex-col transition-all duration-200"
    :class="[
      collapsed ? 'w-16' : 'w-56',
      mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
    ]"
  >
    <!-- Logo -->
    <div class="flex items-center h-14 px-4 border-b border-gray-700 shrink-0">
      <router-link
        to="/dashboard"
        class="flex items-center gap-2 text-white hover:text-brand-400 transition-colors"
      >
        <img src="/logo.svg" alt="K-Recorder" class="h-6 shrink-0" />
        <span v-if="!collapsed" class="font-semibold text-lg tracking-wide">K-Recorder</span>
      </router-link>
      <button
        v-if="!collapsed"
        class="ml-auto hidden lg:block p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        @click="toggleCollapsed"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
          />
        </svg>
      </button>
      <button
        v-else
        class="ml-auto hidden lg:block p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        @click="toggleCollapsed"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 5l7 7-7 7M5 5l7 7-7 7"
          />
        </svg>
      </button>
    </div>

    <!-- 菜单 -->
    <nav class="flex-1 overflow-y-auto py-2 px-2">
      <template v-for="group in menuGroups" :key="group.label">
        <!-- 无子菜单（概览） -->
        <div v-if="!group.children" class="mb-1">
          <router-link
            :to="group.to!"
            class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
            :class="
              route.path === group.to
                ? 'text-white bg-brand-600'
                : 'text-gray-300 hover:text-white hover:bg-gray-700'
            "
            @mouseenter="collapsed ? showTooltip($event, group.label) : undefined"
            @mouseleave="hideTooltip"
          >
            <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                :d="group.icon"
              />
            </svg>
            <span v-if="!collapsed">{{ group.label }}</span>
          </router-link>
        </div>

        <!-- 有子菜单 -->
        <div v-else class="mb-1">
          <!-- 分组标题 -->
          <button
            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
            :class="
              isInGroup(group) ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            "
            @click="collapsed && group.children?.length ? router.push(group.children[0].to) : toggleGroup(group.label)"
            @mouseenter="collapsed ? showTooltip($event, group.label) : undefined"
            @mouseleave="hideTooltip"
          >
            <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                :d="group.icon"
              />
            </svg>
            <span v-if="!collapsed" class="flex-1 text-left">{{ group.label }}</span>
            <svg
              v-if="!collapsed"
              class="w-4 h-4 shrink-0 transition-transform duration-200"
              :class="collapsedGroups[group.label] ? '' : 'rotate-90'"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>

          <!-- 子菜单 -->
          <Transition name="slide">
            <div
              v-if="!collapsed && !collapsedGroups[group.label]"
              class="ml-5 pl-3 border-l border-gray-700"
            >
              <router-link
                v-for="item in group.children"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors"
                :class="
                  isActive(item)
                    ? 'text-white bg-brand-600/50'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                "
              >
                <span>{{ item.label }}</span>
              </router-link>
            </div>
          </Transition>
        </div>
      </template>
    </nav>

    <!-- 底部 -->
    <div class="border-t border-gray-700 px-4 py-3 shrink-0 overflow-visible relative z-10">
      <div v-if="!collapsed" class="flex items-center justify-between">
        <UserMenu />
        <span class="text-xs text-gray-500">v{{ appStore.appVersion || '—' }}</span>
      </div>
      <div v-else class="flex justify-center">
        <UserMenu />
      </div>
    </div>

    <!-- Tooltip -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="tooltip && collapsed"
          class="fixed left-[4.5rem] px-2 py-1 bg-gray-800 text-white text-xs rounded shadow-lg whitespace-nowrap z-[60] pointer-events-none"
          :style="{ top: tooltip.top + 'px', transform: 'translateY(-50%)' }"
        >
          {{ tooltip.text }}
        </div>
      </Transition>
    </Teleport>
  </aside>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-enter-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.slide-leave-active {
  transition: all 0.15s ease;
  overflow: hidden;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  max-height: 0;
}
.slide-enter-to,
.slide-leave-from {
  opacity: 1;
  max-height: 500px;
}
</style>
