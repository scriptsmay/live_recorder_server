<script setup lang="ts">
/**
 * 投稿管理 - CRUD 投稿模板
 * 从 templates.ejs 迁移
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import type { UploadTemplate, BiliupAccount, SeasonOption } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()

const templates = ref<UploadTemplate[]>([])
const loading = ref(true)

// Modal state
const modalVisible = ref(false)
const modalTitle = ref('新增投稿模板')
const editId = ref<number | null>(null)

const form = reactive({
  name: '',
  cookies_path: '',
  title_template: '{room_name} 直播录像 {date}',
  desc_template: '',
  tags: '',
  source: '{room_url}',
  tid: 171,
  copyright: 2,
  is_only_self: 0,
  cover: '',
  dtime: 0,
  after_upload: 'none',
  use_room_cover: false,
  season_id: '',
  season_title: '',
  section_id: '',
  season_auto_add: false,
})

// ===== 合集级联（账号 / cookie 文件 → 合集 → 小节）=====

const accounts = ref<BiliupAccount[]>([])
const selectedAccountId = ref<number | ''>('')
const seasonOptions = ref<SeasonOption[]>([])
const seasonLoading = ref(false)
const seasonError = ref('')
const seasonHint = ref('')
const seasonSource = ref('')
const seasonStale = ref(false)
const savedCookiesPath = ref('')

const seasonsFromSavedPath = computed(
  () =>
    selectedAccountId.value === '' &&
    !!editId.value &&
    form.cookies_path !== savedCookiesPath.value,
)

/** 合集数据源：优先登记账号，其次已保存模板的 cookie 路径（新增且无账号时不可用） */
function seasonEndpoint(): { url: string; label: string } | null {
  if (selectedAccountId.value !== '') {
    const account = accounts.value.find((a) => a.id === selectedAccountId.value)
    return {
      url: `/api/biliup_accounts/${selectedAccountId.value}/seasons`,
      label: account ? `账号「${account.name}」` : '登记账号',
    }
  }
  if (editId.value) {
    return {
      url: `/api/upload_templates/${editId.value}/seasons`,
      label: '模板已保存的 cookie 文件',
    }
  }
  return null
}

const canLoadSeasons = computed(() => seasonEndpoint() !== null)

function currentSeason(): SeasonOption | undefined {
  return seasonOptions.value.find((s) => String(s.seasonId) === form.season_id)
}

function sectionOptions(): SeasonOption['sections'] {
  const season = currentSeason()
  return season ? season.sections : []
}

/** 列表到手后对齐已选值：合集不在列表内时保留原值并给出警示，交由后端归属校验兜底 */
function alignSelectionToOptions() {
  if (!form.season_id) {
    seasonStale.value = false
    return
  }
  const hit = currentSeason()
  if (!hit) {
    seasonStale.value = true
    return
  }
  seasonStale.value = false
  form.season_title = hit.title || form.season_title
  if (form.section_id && !hit.sections.some((item) => String(item.sectionId) === form.section_id)) {
    form.section_id = ''
  }
}

async function loadSeasons(force = false) {
  const target = seasonEndpoint()
  seasonError.value = ''
  if (!target) {
    seasonOptions.value = []
    seasonSource.value = ''
    seasonHint.value = '新增模板需先选择登记账号；也可先保存模板，再在编辑中配置合集'
    return
  }
  seasonLoading.value = true
  seasonHint.value = ''
  try {
    const res = await apiGet<{ seasons: SeasonOption[] }>(target.url + (force ? '?force=1' : ''))
    seasonOptions.value = res.data?.seasons ?? []
    seasonSource.value = target.label
    alignSelectionToOptions()
    if (!seasonOptions.value.length) seasonHint.value = '该账号下暂无合集，请先到 B 站创作中心创建'
  } catch (err) {
    seasonOptions.value = []
    seasonSource.value = ''
    seasonError.value = err instanceof ApiError ? err.message : '合集列表加载失败'
  } finally {
    seasonLoading.value = false
  }
}

async function loadAccounts() {
  try {
    const res = await apiGet<BiliupAccount[] | { rows: BiliupAccount[] }>('/api/biliup_accounts')
    accounts.value = Array.isArray(res.data) ? res.data : (res.data.rows ?? [])
  } catch {
    accounts.value = []
  }
}

function onAccountChange() {
  const account = accounts.value.find((a) => a.id === selectedAccountId.value)
  if (account) form.cookies_path = account.cookies_path
  loadSeasons()
}

function accountLabel(account: BiliupAccount) {
  if (account.login_status === 'ok') return account.name
  return `${account.name}（${account.login_status === 'expired' ? '登录已失效' : '登录态未知'}）`
}

function onSeasonChange() {
  const hit = currentSeason()
  form.season_title = hit ? hit.title : ''
  form.section_id = ''
  form.season_auto_add = false
}

/** 小节是加入合集的必要条件（自动与手动都一样），清掉小节就不留自动加入的假开关 */
function onSectionChange() {
  if (!form.section_id) form.season_auto_add = false
}

function onCookiesPathInput() {
  const account = accounts.value.find((a) => a.id === selectedAccountId.value)
  if (selectedAccountId.value !== '' && (!account || account.cookies_path !== form.cookies_path)) {
    selectedAccountId.value = ''
  }
}

function resetForm() {
  editId.value = null
  modalTitle.value = '新增投稿模板'
  form.name = ''
  form.cookies_path = ''
  form.title_template = '{room_name} 直播录像 {date}'
  form.desc_template = ''
  form.tags = ''
  form.source = '{room_url}'
  form.tid = 171
  form.copyright = 2
  form.is_only_self = 0
  form.cover = ''
  form.dtime = 0
  form.after_upload = 'none'
  form.use_room_cover = false
  form.season_id = ''
  form.season_title = ''
  form.section_id = ''
  form.season_auto_add = false
  selectedAccountId.value = ''
  seasonOptions.value = []
  seasonSource.value = ''
  seasonStale.value = false
  savedCookiesPath.value = ''
}

function openCreate() {
  resetForm()
  modalVisible.value = true
  loadSeasons()
}

function openEdit(t: UploadTemplate) {
  editId.value = t.id
  modalTitle.value = '编辑投稿模板'
  form.name = t.name
  form.cookies_path = t.cookies_path || ''
  form.title_template = t.title_template || '{room_name} 直播录像 {date}'
  form.desc_template = t.desc_template || ''
  form.tags = t.tags || ''
  form.source = t.source || '{room_url}'
  form.tid = t.tid ?? 171
  form.copyright = t.copyright ?? 2
  form.is_only_self = t.is_only_self ?? 0
  form.cover = t.cover || ''
  form.dtime = t.dtime ?? 0
  form.after_upload = t.after_upload || 'none'
  form.use_room_cover = t.use_room_cover ?? false
  form.season_id = t.season_id || ''
  form.season_title = t.season_title || ''
  form.section_id = t.section_id || ''
  form.season_auto_add = t.season_auto_add ?? false
  savedCookiesPath.value = t.cookies_path || ''
  const matched = accounts.value.find((a) => a.cookies_path === (t.cookies_path || ''))
  selectedAccountId.value = matched ? matched.id : ''
  modalVisible.value = true
  loadSeasons()
}

function getFormBody() {
  return {
    name: form.name.trim() || '未命名',
    title_template: form.title_template.trim(),
    desc_template: form.desc_template.trim(),
    cookies_path: form.cookies_path.trim(),
    tid: form.tid || 171,
    copyright: form.copyright || 2,
    source: form.source.trim() || '{room_url}',
    is_only_self: form.is_only_self || 0,
    tags: form.tags.trim(),
    cover: form.cover.trim(),
    dtime: form.dtime || 0,
    after_upload: form.after_upload || 'none',
    use_room_cover: form.use_room_cover,
    season_id: form.season_id || null,
    season_title: form.season_id ? form.season_title.trim() || null : null,
    section_id: form.season_id && form.section_id ? form.section_id : null,
    season_auto_add: form.season_auto_add && !!form.season_id && !!form.section_id,
  }
}

async function handleSave() {
  try {
    if (editId.value) {
      await apiPut(`/api/upload_templates/${editId.value}`, getFormBody())
    } else {
      await apiPost('/api/upload_templates', getFormBody())
    }
    modalVisible.value = false
    resetForm()
    toast.success(editId.value ? '模板已更新' : '模板已创建')
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '保存失败')
  }
}

async function handleCopy(t: UploadTemplate) {
  try {
    await apiPost('/api/upload_templates', {
      name: (t.name || '未命名') + ' (副本)',
      title_template: t.title_template || '{room_name} 直播录像 {date}',
      desc_template: t.desc_template || '',
      cookies_path: t.cookies_path || '',
      tid: t.tid || 171,
      copyright: t.copyright ?? 2,
      source: t.source || '{room_url}',
      is_only_self: t.is_only_self ?? 0,
      tags: t.tags || '',
      cover: t.cover || '',
      dtime: t.dtime || 0,
      after_upload: t.after_upload || 'none',
      use_room_cover: t.use_room_cover ?? false,
      season_id: t.season_id || null,
      season_title: t.season_id ? t.season_title || null : null,
      section_id: t.season_id && t.section_id ? t.section_id : null,
      season_auto_add: (t.season_auto_add ?? false) && !!t.season_id && !!t.section_id,
    })
    toast.success('模板已复制')
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '复制失败')
  }
}

async function handleDelete(t: UploadTemplate) {
  const ok = await confirm(`确定删除模板「${t.name}」？`)
  if (!ok) return
  try {
    await apiDelete(`/api/upload_templates/${t.id}`)
    toast.success('已删除')
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

async function handleRenewCookie(t: UploadTemplate) {
  const ok = await confirm(`确定刷新「${t.name}」的 Cookie？将执行 biliup renew`)
  if (!ok) return
  try {
    const res = await apiPost<{ message?: string }>('/api/biliup/renew', {
      template_id: t.id,
    })
    toast.success(res.message || 'Cookie 刷新已启动')
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '刷新失败')
  }
}

async function loadData() {
  loading.value = true
  try {
    const res = await apiGet<UploadTemplate[] | { rows: UploadTemplate[] }>('/api/upload_templates')
    const data = res.data
    templates.value = Array.isArray(data) ? data : (data.rows ?? [])
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
  loadAccounts()
})
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">投稿模板</h1>
      <button
        class="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        @click="openCreate"
      >
        + 新增模板
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-14">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">名称</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">标题模板</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-20">分区</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-30">非公开</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500 w-72">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="templates.length === 0">
              <td colspan="6" class="px-4 py-12 text-center text-gray-400">暂无模板</td>
            </tr>
            <tr v-for="t in templates" :key="t.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 font-mono text-gray-400">{{ t.id }}</td>
              <td class="px-4 py-3 font-medium text-gray-900">{{ t.name }}</td>
              <td class="px-4 py-3">
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
                  {{ t.title_template || '-' }}
                </code>
              </td>
              <td class="px-4 py-3 text-gray-600">{{ t.tid || '-' }}</td>
              <td class="px-4 py-3 text-gray-600">{{ t.is_only_self ? '是' : '否' }}</td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <button
                    class="px-2.5 py-1 text-xs rounded border border-brand-300 text-brand-600 hover:bg-brand-50 transition-colors"
                    @click="openEdit(t)"
                  >
                    编辑
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs rounded border border-green-300 text-green-600 hover:bg-green-50 transition-colors"
                    @click="handleCopy(t)"
                  >
                    复制
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs rounded border border-amber-300 text-amber-600 hover:bg-amber-50 transition-colors"
                    @click="handleRenewCookie(t)"
                  >
                    刷新Cookie
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                    @click="handleDelete(t)"
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

    <!-- Template Form Modal -->
    <Teleport to="body">
      <div
        v-if="modalVisible"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      >
        <div class="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col">
          <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
            <h3 class="font-semibold text-gray-900">{{ modalTitle }}</h3>
            <button
              class="text-gray-400 hover:text-gray-600 transition-colors"
              @click="modalVisible = false"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div class="p-5 overflow-y-auto flex-1 space-y-4">
            <!-- Row 1: Name + Title -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  模板名称 <span class="text-red-500">*</span>
                </label>
                <input
                  v-model="form.name"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                  placeholder="默认模板"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">标题模板</label>
                <input
                  v-model="form.title_template"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                />
                <p class="text-xs text-gray-400 mt-1">支持模板变量同下</p>
              </div>
            </div>

            <!-- Desc -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                简介模板
                <span class="text-xs text-gray-400 font-normal">
                  支持: {room_name} {caption} {date} {datetime} {YYYY} {MM} {DD} {HH} {mm} {ss} {H}
                  {M} {D} {duration_mins}
                </span>
              </label>
              <textarea
                v-model="form.desc_template"
                rows="3"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none resize-y"
              />
            </div>

            <!-- Row 2: 账号 / Cookie / TID / Cover -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div class="md:col-span-2">
                <label class="block text-sm font-medium text-gray-700 mb-1">biliup 账号</label>
                <select
                  v-model="selectedAccountId"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white"
                  @change="onAccountChange"
                >
                  <option value="">不指定（手动填写账户文件路径）</option>
                  <option v-for="a in accounts" :key="a.id" :value="a.id">
                    {{ accountLabel(a) }}
                  </option>
                </select>
                <p class="text-xs text-gray-400 mt-1">
                  选中后自动带入该账号的 cookies 路径；账号在「biliup 账号」页登记
                </p>
              </div>
              <div class="md:col-span-2">
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  账户文件 (cookies.json) <span class="text-red-500">*</span>
                </label>
                <input
                  v-model="form.cookies_path"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                  placeholder="/path/to/cookies.json"
                  @input="onCookiesPathInput"
                />
                <p class="text-xs text-gray-400 mt-1">biliup 登录后生成的 cookies 文件绝对路径</p>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">分区 TID</label>
                <input
                  v-model.number="form.tid"
                  type="number"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                />
                <p class="text-xs text-gray-400 mt-1">171=电子竞技</p>
              </div>
              <div class="md:col-span-3">
                <label class="block text-sm font-medium text-gray-700 mb-1">封面路径</label>
                <input
                  v-model="form.cover"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                  placeholder="可选"
                />
                <label class="flex items-center gap-2 mt-2 text-sm text-gray-700">
                  <input
                    v-model="form.use_room_cover"
                    type="checkbox"
                    class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  优先使用直播间封面
                </label>
                <p class="text-xs text-gray-400 mt-1">
                  勾选后投稿优先取会话/回放封面，文件缺失时降级用上方固定封面
                </p>
              </div>
            </div>

            <!-- 合集级联：合集（season）→ 小节（section） -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 border-t border-gray-100 pt-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">合集</label>
                <select
                  v-model="form.season_id"
                  :disabled="seasonLoading || seasonOptions.length === 0"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white disabled:bg-gray-100 disabled:text-gray-400"
                  @change="onSeasonChange"
                >
                  <option value="">不加入合集</option>
                  <option v-for="s in seasonOptions" :key="s.seasonId" :value="String(s.seasonId)">
                    {{ s.title || `合集 ${s.seasonId}` }}
                  </option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">小节</label>
                <select
                  v-model="form.section_id"
                  :disabled="sectionOptions().length === 0"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white disabled:bg-gray-100 disabled:text-gray-400"
                  @change="onSectionChange"
                >
                  <option value="">不指定小节</option>
                  <option
                    v-for="sec in sectionOptions()"
                    :key="sec.sectionId"
                    :value="String(sec.sectionId)"
                  >
                    {{ sec.title || `小节 ${sec.sectionId}` }}
                  </option>
                </select>
              </div>
              <div class="md:col-span-2">
                <label class="block text-sm font-medium text-gray-700 mb-1"
                  >投稿后自动加入合集</label
                >
                <div class="flex items-center gap-2">
                  <input
                    v-model="form.season_auto_add"
                    type="checkbox"
                    :disabled="!form.season_id || !form.section_id"
                    class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                  />
                  <span class="text-sm text-gray-700">
                    {{
                      !form.season_id
                        ? '请先选择合集'
                        : !form.section_id
                          ? '请先选择小节'
                          : form.season_title || '已选合集'
                    }}
                  </span>
                  <button
                    type="button"
                    class="ml-auto px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                    :disabled="seasonLoading || !canLoadSeasons"
                    @click="loadSeasons(true)"
                  >
                    {{ seasonLoading ? '加载中…' : '刷新合集' }}
                  </button>
                </div>
                <p v-if="seasonLoading" class="text-xs text-gray-400 mt-2">
                  正在拉取该账号的合集列表…
                </p>
                <p v-else-if="seasonError" class="text-xs text-red-600 mt-2">
                  {{ seasonError }}
                </p>
                <p v-else-if="seasonStale" class="text-xs text-amber-600 mt-2">
                  已保存的合集不在{{ seasonSource }}的列表内，保存时会被拒绝，请重新选择
                </p>
                <p v-else-if="seasonsFromSavedPath" class="text-xs text-amber-600 mt-2">
                  账户文件已改动，合集仍按已保存的路径拉取；请先保存模板再刷新
                </p>
                <p v-else-if="seasonHint" class="text-xs text-gray-400 mt-2">{{ seasonHint }}</p>
                <p v-else class="text-xs text-gray-400 mt-2">来源：{{ seasonSource }}</p>
              </div>
            </div>

            <!-- Row 3: Copyright + Source + OnlySelf + Dtime -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">版权</label>
                <select
                  v-model.number="form.copyright"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white"
                >
                  <option :value="1">自制</option>
                  <option :value="2">转载</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">转载来源</label>
                <input
                  v-model="form.source"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                />
                <p class="text-xs text-gray-400 mt-1">默认 {room_url}</p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">仅自己可见</label>
                <select
                  v-model.number="form.is_only_self"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white"
                >
                  <option :value="0">关闭</option>
                  <option :value="1">开启</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">延迟发布 (dtime)</label>
                <input
                  v-model.number="form.dtime"
                  type="number"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                  placeholder="10位时间戳"
                />
                <p class="text-xs text-gray-400 mt-1">需大于当前时间 4 小时</p>
              </div>
            </div>

            <!-- Row 4: Tags + After Upload -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">标签（逗号分隔）</label>
                <input
                  v-model="form.tags"
                  type="text"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                  placeholder="直播,游戏"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">投稿后处理</label>
                <select
                  v-model="form.after_upload"
                  class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none bg-white"
                >
                  <option value="none">无操作</option>
                  <option value="delete">删除本地文件</option>
                </select>
                <p class="text-xs text-gray-400 mt-1">投稿成功后对视频文件的处理方式</p>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-200">
            <button
              class="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
              @click="modalVisible = false"
            >
              取消
            </button>
            <button
              class="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
              @click="handleSave"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
