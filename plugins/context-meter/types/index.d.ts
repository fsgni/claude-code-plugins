// One usage gauge in the row above the prompt: the context window's fill or a
// plan usage window, as a whole percentage.
export type MeterGauge = {
  // `context`, or the usage window's kind (`five_hour`, `seven_day`, ...).
  kind: string
  percent: number
  isEstimate: boolean
  // The context window's tokens, used/window (`245k/1M`); null for a usage window.
  detail: string | null
}

// The gauges drawn on the left of the row; null draws none.
export type MeterGauges = readonly MeterGauge[] | null

// The main loop's model and its effort (null until a request names it), drawn
// on the right of the row; null draws neither.
export type MeterModel = { model: string; effort: string | null } | null

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { gauges: MeterGauges; modelEffort: MeterModel }
  }
}
