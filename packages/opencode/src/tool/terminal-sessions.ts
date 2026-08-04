import { Effect } from "effect"

/**
 * Shared registry of the terminal tool's per-instance session stores.
 *
 * The terminal tool registers a store when its session state initializes for
 * an instance directory and unregisters it when that state is disposed. The
 * HTTP API handlers (and anything else in-process) read the same store to
 * observe and control the agent's terminal sessions, so the TUI can show a
 * live monitor.
 */

export type TerminalSessionSnapshot = {
  id: string
  /** False for sessions restored from disk — their PTY no longer exists. */
  live: boolean
  buffer: string
  trimmed: number
  reported: number
  exitCode: number | null
  description: string
  shell: string
  cwd: string
  createdAt: number
}

export type TerminalSessionsStore = {
  snapshot: () => TerminalSessionSnapshot[]
  subscribe: (listener: () => void) => () => void
  close: (id: string) => Effect.Effect<boolean>
  send: (id: string, input: string) => Effect.Effect<boolean>
}

const stores = new Map<string, TerminalSessionsStore>()

export function registerTerminalSessions(directory: string, store: TerminalSessionsStore) {
  stores.set(directory, store)
}

export function unregisterTerminalSessions(directory: string) {
  stores.delete(directory)
}

export function getTerminalSessions(directory: string): TerminalSessionsStore | undefined {
  return stores.get(directory)
}
