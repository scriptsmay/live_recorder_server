import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginPrettier from 'eslint-plugin-prettier'
import globals from 'globals'

export default [
  // 全局忽略
  { ignores: ['dist/**', 'node_modules/**'] },

  // 基础 JS 推荐规则
  js.configs.recommended,

  // TypeScript 推荐规则
  ...tseslint.configs.recommended,

  // Vue 推荐规则
  ...pluginVue.configs['flat/recommended'],

  // 浏览器环境全局变量
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Vue 文件的 TS 解析
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  // Prettier 集成（必须放最后）
  {
    plugins: { prettier: eslintPluginPrettier },
    rules: {
      'prettier/prettier': 'warn',
    },
  },
  eslintConfigPrettier,

  // 项目自定义规则
  {
    rules: {
      // 允许未使用的变量以 _ 开头
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 允许 require 类型导入（用于动态 import）
      '@typescript-eslint/no-require-imports': 'off',
      // 允许页面组件使用单词命名（Dashboard, Rooms 等）
      'vue/multi-word-component-names': 'off',
      // v-html 用于弹幕搜索关键词高亮（已做 HTML 转义）
      'vue/no-v-html': 'off',
    },
  },
]
