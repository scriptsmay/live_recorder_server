import { createApp } from 'vue'
import { createPinia } from 'pinia'
import formatPlugin from './plugins/format'

import router from './router'
import App from './App.vue'
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(formatPlugin)

app.mount('#app')
