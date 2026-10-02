// The meter as drawn at the end of the hint line; null draws nothing there.
export type MeterLine = string | null

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { line: MeterLine }
  }
}
