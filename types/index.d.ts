export type ParkCount = number

declare module 'claude-code' {
  interface PluginState {
    park: { count: ParkCount }
  }
}
