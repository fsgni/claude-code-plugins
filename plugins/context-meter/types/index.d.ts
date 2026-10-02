// The meter as drawn at the end of the hint line; null draws nothing there.
export type MeterLine = string | null

// The model and its effort as drawn after the footer's mode labels; null draws
// nothing there.
export type ModelLabel = string | null

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { line: MeterLine; model: ModelLabel }
  }
}
