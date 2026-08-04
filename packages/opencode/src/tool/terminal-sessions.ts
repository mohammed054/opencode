import { Effect } from "effect"

/**
 * Shared registry of the terminal tool's session stores.
 *
 * The terminal tool registers a store when its session state initializes for
 * an instance directory (main agent, persisted) or when a subagent session
 * first creates a terminal (in-memory, keyed by the subagent session ID), and
 * unregisters it when it is disposed. The HTTP API handlers (and anything
 * else in-process) read the same stores to observe and control terminal
 * sessions, so the TUI can show a live monitor.
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
  /** Name of the agent that created the session. */
  agent: string
  /** Container the session runs inside, when created with the container param. */
  container: string | null
  cwd: string
  createdAt: number
}

export type TerminalSessionsStore = {
  /** True for subagent-scoped stores; empty ones are swept from the registry. */
  subagent: boolean
  snapshot: () => TerminalSessionSnapshot[]
  subscribe: (listener: () => void) => () => void
  close: (id: string) => Effect.Effect<boolean>
  send: (id: string, input: string) => Effect.Effect<boolean>
}

const stores = new Map<string, TerminalSessionsStore>()

export function registerTerminalSessions(scope: string, store: TerminalSessionsStore) {
  stores.set(scope, store)
}

export function unregisterTerminalSessions(scope: string) {
  stores.delete(scope)
}

export function listTerminalSessions(): TerminalSessionsStore[] {
  for (const [scope, store] of stores) {
    if (store.subagent && store.snapshot().length === 0) stores.delete(scope)
  }
  return [...stores.values()]
}

export function findTerminalSessions(sessionID: string): TerminalSessionsStore | undefined {
  for (const store of stores.values()) {
    if (store.snapshot().some((session) => session.id === sessionID)) return store
  }
  return undefined
}
