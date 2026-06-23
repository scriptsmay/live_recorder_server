<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { marked } from 'marked'
// import 'github-markdown-css/github-markdown.css'
// 浅色主题样式
import 'github-markdown-css/github-markdown-light.css'

interface TocItem {
  id: string
  text: string
  depth: number
}

const renderedHtml = ref<string>('')
const toc = ref<TocItem[]>([])
const loading = ref<boolean>(true)
const error = ref<string | null>(null)

const generateTOC = (html: string) => {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const headings = doc.querySelectorAll('h1, h2, h3')

  const tocList: TocItem[] = []

  headings.forEach((heading, index) => {
    const text = heading.textContent || ''
    const id =
      heading.id ||
      text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .trim() ||
      `heading-${index}`
    heading.id = id

    tocList.push({
      id,
      text,
      depth: parseInt(heading.tagName.replace('H', ''), 10),
    })
  })

  toc.value = tocList
  return doc.body.innerHTML
}

onMounted(async () => {
  try {
    loading.value = true
    error.value = null

    const response = await fetch('/api/api-doc')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()
    const rawHtml = await marked(data.content)
    renderedHtml.value = generateTOC(rawHtml)
  } catch (err) {
    console.error('获取文档失败:', err)
    error.value = err instanceof Error ? err.message : '获取文档失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="api-container flex max-w-7xl mx-auto gap-6">
    <!-- 目录侧边栏 -->
    <aside
      class="toc-sidebar hidden lg:block w-80 sticky top-0 h-fit max-h-[calc(100vh-3rem)] overflow-y-auto border-r border-gray-200 pr-6"
    >
      <h3 class="text-sm font-semibold text-gray-900 mb-3">目录</h3>
      <nav v-if="toc.length" class="space-y-1">
        <a
          v-for="item in toc"
          :key="item.id"
          :href="`#${item.id}`"
          class="block text-sm text-gray-600 hover:text-brand-600 hover:bg-gray-50 px-2 py-1 rounded transition-colors"
          :class="{
            'pl-2': item.depth === 1,
            'pl-6': item.depth === 2,
            'pl-10': item.depth === 3,
          }"
        >
          {{ item.text }}
        </a>
      </nav>
      <p v-else class="text-sm text-gray-400">暂无目录</p>
    </aside>

    <!-- 文档内容 -->
    <main data-theme="light" class="markdown-content flex-1 min-w-0">
      <div v-if="loading" class="py-12 text-center text-gray-500">
        <svg
          class="animate-spin h-8 w-8 mx-auto mb-2 text-gray-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        加载文档中...
      </div>

      <div v-else-if="error" class="py-12 text-center">
        <div class="text-red-500 mb-2">
          <svg class="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <p class="text-red-600 font-medium">{{ error }}</p>
      </div>

      <article
        v-else
        class="markdown-body markdown-light prose prose-slate max-w-none"
        v-html="renderedHtml"
      ></article>
    </main>
  </div>
</template>

<style scoped>
.api-container {
  padding-bottom: 3rem;
  color: #1f2937;
}
/* 这里的 60px 换成你顶部导航栏的实际高度 */
:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3) {
  scroll-margin-top: 70px; /* 导航栏高度 + 10px 边距，体验最好 */
}

:deep(.markdown-body) {
  background: transparent !important;
}

:deep(.markdown-body a) {
  color: #ea580c !important;
}

:deep(.markdown-body a:hover) {
  color: #c2410c !important;
  text-decoration: underline;
}

:deep(.markdown-body code) {
  background-color: #fef3c7 !important;
  color: #92400e !important;
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-size: 0.875em;
}

:deep(.markdown-body pre) {
  background-color: #1f2937 !important;
  border-radius: 8px;
  padding: 1rem;
  overflow-x: auto;
}

:deep(.markdown-body pre code) {
  background-color: transparent !important;
  color: #e5e7eb !important;
  padding: 0;
}

:deep(.markdown-body table) {
  display: block;
  width: 100%;
  overflow-x: auto;
}

:deep(.markdown-body th),
:deep(.markdown-body td) {
  border: 1px solid #d1d5db !important;
  padding: 0.5rem 1rem;
}

:deep(.markdown-body th) {
  background-color: #f9fafb !important;
  color: #111827 !important;
}

:deep(.markdown-body strong) {
  color: #111827 !important;
}

:deep(.markdown-body blockquote) {
  border-left-color: #d1d5db !important;
  color: #4b5563 !important;
}
</style>
