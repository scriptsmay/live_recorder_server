import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { title: '仪表盘' },
  },
  {
    path: '/rooms',
    name: 'Rooms',
    component: () => import('@/views/Rooms.vue'),
    meta: { title: '直播间' },
  },
  {
    path: '/sessions',
    name: 'Sessions',
    component: () => import('@/views/Sessions.vue'),
    meta: { title: '录制会话' },
  },
  {
    path: '/sessions/:id/danmaku',
    name: 'SessionDanmaku',
    component: () => import('@/views/SessionDanmaku.vue'),
    meta: { title: '弹幕详情' },
  },
  {
    path: '/recordings',
    name: 'Recordings',
    component: () => import('@/views/Recordings.vue'),
    meta: { title: '录制文件' },
  },
  {
    path: '/transcode',
    name: 'Transcode',
    component: () => import('@/views/Transcode.vue'),
    meta: { title: '转码记录' },
  },
  {
    path: '/danmaku-toolbox',
    name: 'DanmakuToolbox',
    component: () => import('@/views/DanmakuToolbox.vue'),
    meta: { title: '弹幕工具箱' },
  },
  {
    path: '/replay-toolbox',
    name: 'ReplayToolbox',
    component: () => import('@/views/ReplayToolbox.vue'),
    meta: { title: '回放工具箱' },
  },
  {
    path: '/replay-toolbox/:principalId',
    component: () => import('@/views/replay-toolbox/PrincipalSpace.vue'),
    meta: { title: '回放工具箱' },
    children: [
      {
        path: '',
        redirect: (to) => `${to.path}/records`,
      },
      {
        path: 'records',
        name: 'replay-records',
        component: () => import('@/views/replay-toolbox/RecordsPage.vue'),
        meta: { title: '回放记录' },
      },
      {
        path: 'uploads',
        name: 'replay-uploads',
        component: () => import('@/views/replay-toolbox/UploadsPage.vue'),
        meta: { title: '投稿记录' },
      },
      {
        path: 'tasks',
        name: 'replay-tasks',
        component: () => import('@/views/replay-toolbox/TasksPage.vue'),
        meta: { title: '任务队列' },
      },
      {
        path: 'settings',
        name: 'replay-settings',
        component: () => import('@/views/replay-toolbox/SettingsPage.vue'),
        meta: { title: '配置' },
      },
    ],
  },
  {
    path: '/templates',
    name: 'Templates',
    component: () => import('@/views/Templates.vue'),
    meta: { title: '投稿管理' },
  },
  {
    path: '/upload-records',
    name: 'UploadRecords',
    component: () => import('@/views/UploadRecords.vue'),
    meta: { title: '投稿记录' },
  },
  // EJS 旧路径兼容重定向
  {
    path: '/upload_records',
    redirect: '/upload-records',
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
    meta: { title: '设置' },
  },
  {
    path: '/logs',
    name: 'Logs',
    component: () => import('@/views/Logs.vue'),
    meta: { title: '日志' },
  },
  {
    path: '/api-doc',
    name: 'ApiDoc',
    component: () => import('@/views/ApiDoc.vue'),
    meta: { title: 'API 文档' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 路由守卫：自动设置页面标题
router.beforeEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} - K-Recorder` : 'K-Recorder'
})

export default router
