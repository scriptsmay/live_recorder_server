<script setup lang="ts">
import { reactive, ref } from 'vue'
import { apiPost, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'

const toast = useToast()

const pwForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const pwSaving = ref(false)
const pwError = ref('')

async function handleChangePassword() {
  pwError.value = ''
  if (!pwForm.currentPassword || !pwForm.newPassword) {
    pwError.value = '请填写当前密码和新密码'
    return
  }
  if (pwForm.newPassword.length < 6) {
    pwError.value = '新密码至少 6 位'
    return
  }
  if (pwForm.newPassword !== pwForm.confirmPassword) {
    pwError.value = '两次输入的新密码不一致'
    return
  }

  pwSaving.value = true
  try {
    await apiPost('/api/auth/change-password', {
      current_password: pwForm.currentPassword,
      new_password: pwForm.newPassword,
    })
    toast.success('密码修改成功，请重新登录')
    pwForm.currentPassword = ''
    pwForm.newPassword = ''
    pwForm.confirmPassword = ''
  } catch (err) {
    pwError.value = err instanceof ApiError ? err.message : '修改密码失败'
  } finally {
    pwSaving.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">修改密码</h1>

    <div class="max-w-md bg-white rounded-xl border border-gray-200 shadow-sm">
      <div class="p-6 space-y-4">
        <div>
          <label for="pw_current" class="block text-sm font-medium text-gray-700 mb-1">当前密码</label>
          <input
            id="pw_current"
            v-model="pwForm.currentPassword"
            type="password"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
            placeholder="输入当前密码"
          />
        </div>
        <div>
          <label for="pw_new" class="block text-sm font-medium text-gray-700 mb-1">新密码</label>
          <input
            id="pw_new"
            v-model="pwForm.newPassword"
            type="password"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
            placeholder="至少 6 位"
          />
        </div>
        <div>
          <label for="pw_confirm" class="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
          <input
            id="pw_confirm"
            v-model="pwForm.confirmPassword"
            type="password"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
            placeholder="再次输入新密码"
            @keyup.enter="handleChangePassword"
          />
        </div>
        <p v-if="pwError" class="text-sm text-red-600">{{ pwError }}</p>
        <button
          class="w-full px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="pwSaving"
          @click="handleChangePassword"
        >
          {{ pwSaving ? '修改中...' : '确认修改' }}
        </button>
      </div>
    </div>
  </div>
</template>
