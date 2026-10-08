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

// One conversation of this folder as the board shows it.
export type BoardRow = {
  sessionId: string
  name: string
  // False while the name is one Claude Code gave it (`mygame-64`, a title).
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

// What the board shows; null until the first reading.
export type BoardView = { folder: string; rows: readonly BoardRow[]; others: readonly BoardOther[] } | null

// How a run of text is drawn: the terminal's palette, or Claude's orange.
export type BoardTone = 'claude' | 'warning' | 'success' | 'muted' | 'accent' | 'strong'

export type BoardSpan = { text: string; tone?: BoardTone }

// One line of the board: its left part, and a part flush right.
export type BoardLine = { left: readonly BoardSpan[]; right?: readonly BoardSpan[] }

// The board as a Windows Terminal pane draws it, written by the session
// whose /board opened the pane: `<config>/role-board/screens/<boardId>.json`.
export type BoardScreen = {
  // When it was written; a pane that sees no write for a while says so.
  at: number
  // The conversation ended: the pane closes.
  ended: boolean
  lines: readonly BoardLine[]
  // The pane's bottom row, and what it says there once the screen goes quiet.
  hint: string
  staleNote: string
}

declare module 'claude-code' {
  interface PluginState {
    'role-board': {
      card: BoardCard | null
      board: BoardView
      // The screen this session writes for its terminal panes, once /board
      // opened one: kept across /clear, so the pane goes on showing it.
      boardId: string | null
    }
  }
}
