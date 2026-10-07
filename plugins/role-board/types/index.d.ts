// How a turn ended, as `turn.complete` says it.
export type BoardOutcome = 'answer' | 'aborted' | 'refusal' | 'error'

// One conversation as its own session reports it, written for the other
// sessions to read: `<config>/role-board/cards/<sessionId>.json`.
export type BoardCard = {
  sessionId: string
  cwd: string
  // When the session last wrote it, in ms; 0 until written.
  beatAt: number
  // The first line of the person's latest prompt, and when they sent it.
  task: { text: string; at: number } | null
  // The main loop's newest tool call still running, in words ("改 player.gd").
  doing: { tool: string; text: string; at: number } | null
  // When the running turn started; null between turns.
  turnAt: number | null
  // The first line of the last turn's answer, when and how the turn ended.
  done: { text: string; at: number; outcome: BoardOutcome } | null
}

export type BoardState = 'working' | 'waiting' | 'idle'

// One conversation of this folder as the pane draws it.
export type BoardRow = {
  sessionId: string
  name: string
  // False while the name is the one Claude Code made up (`mygame-64`).
  isNamed: boolean
  isSelf: boolean
  state: BoardState
  // Idle after a turn that answered.
  isDone: boolean
  // What it does now, what it waits for, or how its last turn ended.
  status: string
  task: string | null
  // How long it has been in its state ("4m").
  since: string
}

// A conversation in another folder: one dim line.
export type BoardOther = { sessionId: string; name: string; folder: string; state: BoardState }

// What the pane draws; null until the first reading.
export type BoardView = { folder: string; rows: readonly BoardRow[]; others: readonly BoardOther[] } | null

declare module 'claude-code' {
  interface PluginState {
    'role-board': {
      card: BoardCard | null
      board: BoardView
      // The person closed the pane: it stays closed until /board.
      isDismissed: boolean
      // The pane was opened once this session, unasked or by /board.
      hasOpened: boolean
    }
  }
}
