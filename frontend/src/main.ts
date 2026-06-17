import { createApp } from 'vue'
import { createPinia } from 'pinia'
import formatPlugin from './plugins/format'
import { setUnauthorizedHandler } from './utils/api'
import { useAuthStore } from './stores/auth'

import router from './router'
import App from './App.vue'
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(formatPlugin)

setUnauthorizedHandler(() => {
  const auth = useAuthStore()
  auth.clearLocal()
  const current = router.currentRoute.value.fullPath
  if (!current.startsWith('/login')) {
    router.push({ path: '/login', query: { redirect: current } })
  }
})

app.mount('#app')
