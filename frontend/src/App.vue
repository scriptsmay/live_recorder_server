<script setup lang="ts">
import { RouterView } from 'vue-router'
import Layout from '@/components/Layout.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
</script>

<template>
  <Layout>
    <RouterView />
  </Layout>
  <ToastContainer />
  <ConfirmDialog />
</template>
