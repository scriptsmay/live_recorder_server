<script setup lang="ts">
/**
 * biliup 账号登记 - 管理投稿/合集使用的 B 站账号
 *
 * 后端只提供新增 / 查询 / 删除，没有修改：账号信息以 cookie 文件为准，改配置请改文件本身。
 * 因此本页也没有编辑入口，只有「刷新登录态」和「查看合集」两个只读探针。
 * 页面 state 不保存任何 cookie 内容，接口响应本身也不含。
 */
import { ref, onMounted } from 'vue'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { formatTime } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Modal from '@/components/Modal.vue'
import type { BiliupAccount, BiliupLoginStatus, SeasonListResult } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()

const NAME_MAX = 64

// ---- 列表状态 ----
const accounts = ref<BiliupAccount[]>([])
const loading = ref(false)
const refreshingIds = ref(new Set<number>())

// ---- 新增弹窗 ----
const createVisible = ref(false)
const creating = ref(false)
const formName = ref('')
const formPath = ref('')

// ---- 合集弹窗 ----
const seasonsVisible = ref(false)
const seasonsLoading = ref(false)
const seasonsAccount = ref<BiliupAccount | null>(null)
const seasonsData = ref<SeasonListResult | null>(null)

interface Badge {
  text: string
  cls: string
}

function loginBadge(status: BiliupLoginStatus): Badge {
  switch (status) {
    case 'ok':
      return { text: '已登录', cls: 'bg-green-100 text-green-700' }
    case 'expired':
      return { text: '已失效', cls: 'bg-red-100 text-red-700' }
    default:
      return { text: '未知', cls: 'bg-gray-100 text-gray-500' }
  }
}

function loginTooltip(status: BiliupLoginStatus) {
  if (status === 'ok') return '登录态正常'
  if (status === 'expired') return 'cookie 已失效，请重新登录该账号后再试'
  return '未能确认登录态，多为网络异常或 cookie 文件不可读'
}

// ---- 数据加载 ----
async function fetchAccounts() {
  loading.value = true
  try {
    const res = await apiGet<BiliupAccount[]>('/api/biliup_accounts')
    accounts.value = res.data
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载账号列表失败')
  } finally {
    loading.value = false
  }
}

/** 详情接口会顺带探测线上登录态并回写，用作列表里的「刷新」按钮 */
async function handleRefreshLogin(account: BiliupAccount) {
  refreshingIds.value.add(account.id)
  try {
    const res = await apiGet<BiliupAccount>(`/api/biliup_accounts/${account.id}`)
    const index = accounts.value.findIndex((a) => a.id === account.id)
    if (index >= 0) accounts.value[index] = res.data
    if (res.data.login_status === 'expired') {
      toast.warning(`账号「${account.name}」cookie 已失效，请重新登录`)
    } else {
      toast.success(`账号「${account.name}」登录态已更新`)
    }
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '登录态刷新失败')
  } finally {
    refreshingIds.value.delete(account.id)
  }
}

// ---- 新增 ----
function openCreate() {
  formName.value = ''
  formPath.value = ''
  createVisible.value = true
}

async function handleCreate() {
  const name = formName.value.trim()
  const cookiesPath = formPath.value.trim()
  if (!name || name.length > NAME_MAX) {
    toast.error(`账号名称需为 1-${NAME_MAX} 个字符`)
    return
  }
  if (!cookiesPath.startsWith('/')) {
    toast.error('cookie 路径需为绝对路径（以 / 开头）')
    return
  }

  creating.value = true
  try {
    const res = await apiPost<BiliupAccount>('/api/biliup_accounts', {
      name,
      cookies_path: cookiesPath,
    })
    accounts.value.push(res.data)
    createVisible.value = false
    toast.success(`账号「${res.data.name}」已登记`)
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '登记账号失败')
  } finally {
    creating.value = false
  }
}

// ---- 删除 ----
async function handleDelete(account: BiliupAccount) {
  const ok = await confirm(
    `确定要删除账号「${account.name}」的登记吗？cookie 文件不会被删除，仍然保留在 ${account.cookies_path}。`,
    { title: '删除账号登记', confirmText: '删除登记' },
  )
  if (!ok) return

  try {
    const res = await apiDelete(`/api/biliup_accounts/${account.id}`)
    toast.success(res.message || '账号登记已删除，cookie 文件保留')
    accounts.value = accounts.value.filter((a) => a.id !== account.id)
  } catch (err) {
    // 被投稿模板引用时后端返回 409，文案里带引用数量
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

// ---- 查看合集 ----
async function loadSeasons(account: BiliupAccount, force = false) {
  seasonsLoading.value = true
  try {
    const query = force ? '?force=1' : ''
    const res = await apiGet<SeasonListResult>(`/api/biliup_accounts/${account.id}/seasons${query}`)
    seasonsData.value = res.data
    if (force) toast.success('合集列表已重新拉取')
  } catch (err) {
    seasonsData.value = null
    toast.error(err instanceof ApiError ? err.message : '合集列表获取失败')
  } finally {
    seasonsLoading.value = false
  }
}

function openSeasons(account: BiliupAccount) {
  seasonsAccount.value = account
  seasonsData.value = null
  seasonsVisible.value = true
  loadSeasons(account)
}

onMounted(fetchAccounts)
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-900">biliup 账号</h1>
      <button
        class="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        @click="openCreate"
      >
        新增账号
      </button>
    </div>

    <p class="mb-4 text-sm text-gray-500">
      这里只登记 biliup 使用的 cookie 文件路径，用于投稿模板选择账号与自动加入合集。账号信息以
      cookie 文件为准，改密码/重新登录请直接更新文件；本页不读取也不展示 cookie 内容。
    </p>

    <!-- 加载中 -->
    <div v-if="loading && accounts.length === 0" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- 表格 -->
    <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div class="overflow-x-auto border-b border-gray-200">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">名称</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">UID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">昵称</th>
              <th class="px-4 py-3 text-center font-medium text-gray-500 w-24">登录态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">cookie 路径</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-44">最近检查</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500 w-64">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="accounts.length === 0">
              <td colspan="8" class="px-4 py-8 text-center text-gray-400">
                暂无账号登记，点击「新增账号」开始
              </td>
            </tr>
            <tr v-for="a in accounts" :key="a.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 text-gray-900 font-medium">{{ a.id }}</td>
              <td class="px-4 py-3 text-gray-900">{{ a.name }}</td>
              <td class="px-4 py-3 text-gray-600">{{ a.uid || '-' }}</td>
              <td class="px-4 py-3 text-gray-600">{{ a.nickname || '-' }}</td>
              <td class="px-4 py-3 text-center">
                <span
                  class="inline-block max-w-[6rem] truncate px-2 py-0.5 rounded-full text-xs font-medium align-middle"
                  :class="loginBadge(a.login_status).cls"
                  :title="loginTooltip(a.login_status)"
                >
                  {{ loginBadge(a.login_status).text }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span
                  class="block max-w-[22rem] truncate font-mono text-xs text-gray-500"
                  :title="a.cookies_path"
                >
                  {{ a.cookies_path }}
                </span>
              </td>
              <td class="px-4 py-3 text-gray-500">
                {{ a.last_checked_at ? formatTime(a.last_checked_at) : '-' }}
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1">
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                    :disabled="refreshingIds.has(a.id)"
                    @click="handleRefreshLogin(a)"
                  >
                    {{ refreshingIds.has(a.id) ? '检查中' : '刷新登录态' }}
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-brand-200 text-brand-600 hover:bg-brand-50 transition-colors"
                    @click="openSeasons(a)"
                  >
                    查看合集
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    @click="handleDelete(a)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增弹窗 -->
    <Modal v-model:visible="createVisible" title="新增 biliup 账号">
      <div class="px-6 py-4 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">账号名称</label>
          <input
            v-model="formName"
            type="text"
            maxlength="64"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="投稿模板里显示的名称，如 笨铁子小号"
          />
          <p class="mt-1 text-xs text-gray-400">需唯一，最长 {{ NAME_MAX }} 个字符</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">cookie 文件路径</label>
          <input
            v-model="formPath"
            type="text"
            class="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="/data/biliup/cookies.json"
          />
          <p class="mt-1 text-xs text-gray-400">
            绝对路径：Docker 部署填容器内路径（需位于 /data/biliup 等白名单目录）；宿主机直跑（npm
            start / npm run dev）填本机路径。保存时只读校验一次，不会回写文件。
          </p>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button
            class="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
            @click="createVisible = false"
          >
            取消
          </button>
          <button
            class="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
            :disabled="creating"
            @click="handleCreate"
          >
            {{ creating ? '校验中...' : '登记账号' }}
          </button>
        </div>
      </div>
    </Modal>

    <!-- 合集弹窗 -->
    <Modal
      v-model:visible="seasonsVisible"
      :title="seasonsAccount ? `${seasonsAccount.name} 的合集` : '合集列表'"
      max-width="max-w-2xl"
    >
      <div class="px-6 py-4">
        <div class="mb-3 flex items-center justify-between">
          <span v-if="seasonsData && !seasonsLoading" class="text-xs text-gray-400">
            共 {{ seasonsData.seasons.length }} 个合集 ·
            {{ seasonsData.cached ? '使用缓存' : '实时拉取' }}
            <template v-if="seasonsData.fetched_at"
              >（{{ formatTime(seasonsData.fetched_at) }}）</template
            >
          </span>
          <button
            class="ml-auto px-3 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
            :disabled="seasonsLoading || !seasonsAccount"
            @click="seasonsAccount && loadSeasons(seasonsAccount, true)"
          >
            {{ seasonsLoading ? '拉取中...' : '强制刷新' }}
          </button>
        </div>

        <div v-if="seasonsLoading" class="text-center py-8">
          <div
            class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
          />
          <span class="text-sm text-gray-500">正在拉取合集列表...</span>
        </div>

        <div
          v-else-if="!seasonsData || seasonsData.seasons.length === 0"
          class="text-center py-8 text-sm text-gray-400"
        >
          该账号还没有创建任何合集
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="s in seasonsData.seasons"
            :key="s.seasonId"
            class="border border-gray-200 rounded-lg p-3"
          >
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-medium text-gray-900">{{ s.title }}</span>
              <span class="text-xs text-gray-400 font-mono">#{{ s.seasonId }}</span>
              <span class="ml-auto text-xs text-gray-400">{{ s.sections.length }} 个小节</span>
            </div>
            <div v-if="s.sections.length" class="mt-2 flex flex-wrap gap-1.5">
              <span
                v-for="sec in s.sections"
                :key="sec.sectionId"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-xs text-gray-600"
                :title="`小节 ID：${sec.sectionId}`"
              >
                {{ sec.title }}
                <span class="text-gray-400 font-mono">{{ sec.sectionId }}</span>
              </span>
            </div>
            <p v-else class="mt-2 text-xs text-gray-400">该合集下暂无小节</p>
          </div>
        </div>
      </div>
    </Modal>
  </div>
</template>
