export {}

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    $formatTime: (
      date: string | number | Date | null | undefined,
      options?: {
        format?: string
        omit?: string
      },
    ) => string

    $timeAgo: (date: string | number | Date) => string
  }
}
