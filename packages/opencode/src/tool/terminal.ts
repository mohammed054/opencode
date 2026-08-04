import path from "path"
import stripAnsi from "strip-ansi"
import * as Tool from "./tool"
import DESCRIPTION from "./terminal.txt"
import { Shell } from "@opencode-ai/core/shell"
import { Pty } from "@opencode-ai/core/pty"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ID as PtyID } from "@opencode-ai/schema/pty"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import * as Truncate from "./truncate"
import { InstanceState } from "@/effect/instance-state"
import {
  registerTerminalSessions,
  unregisterTerminalSessions,
  type TerminalSessionsStore,
} from "./terminal-sessions"
import { Effect, Deferred, Schema } from "effect"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Sentinel for exit code detection
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = "__OPENCODE_EXIT_"
const MAX_SESSIONS = 20
const SESSION_BUFFER_LIMIT = 1024 * 1024
const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_METADATA_LENGTH = 30_000

// Sessions are persisted to disk (one JSON file per instance directory) so
// they survive process restarts.
const PERSIST_VERSION = 1
const PERSIST_DIR = path.join(Global.Path.data, "terminal-sessions")

// Transcript tail included in monitor snapshots.
const SNAPSHOT_BUFFER_LIMIT = 60_000

/**
 * Windows console (conpty/PSReadLine) requires CR to submit a line; bare LF
 * leaves PowerShell stuck in continuation mode. POSIX PTYs translate CR to LF.
 */
const LINE_END = process.platform === "win32" ? "\r\n" : "\n"

// ---------------------------------------------------------------------------
// Session state for persistent PTY sessions
// ---------------------------------------------------------------------------

type SessionState = {
  ptyId: PtyID
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
  detach: () => void
}

/** Debounced disk persistence for one instance's session map. */
type SessionPersist = {
  schedule: () => void
  stop: () => void
}

// ---------------------------------------------------------------------------
// Sentinel command helper (shell-aware)
// ---------------------------------------------------------------------------

/**
 * Returns the shell-appropriate sentinel command for exit code detection.
 * - Windows PowerShell: $([int]$LASTEXITCODE) — plain $LASTEXITCODE is $null
 *   in a fresh shell until a native command has run, which would print an
 *   empty marker. The [int] cast yields 0 instead.
 * - cmd.exe: %ERRORLEVEL%
 * - POSIX shells: $? (always numeric)
 */
export function sentinelCommand(ps: boolean, shell: string): string {
  if (ps) return `echo "${SENTINEL_PREFIX}$([int]$LASTEXITCODE)"`
  if (shell === "cmd") return `echo ${SENTINEL_PREFIX}%ERRORLEVEL%`
  return `echo "${SENTINEL_PREFIX}$?"`
}

// ---------------------------------------------------------------------------
// Parameters — discriminated union on "action"
// ---------------------------------------------------------------------------

const RunAction = Schema.Struct({
  action: Schema.Literal("run"),
  command: Schema.String.annotate({ description: "The command to execute in a TTY-aware terminal session" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this command does in 5-10 words" }),
})

const CreateAction = Schema.Struct({
  action: Schema.Literal("create"),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory for the session" }),
  description: Schema.optional(Schema.String).annotate({ description: "Description for the terminal session" }),
})

const SendAction = Schema.Struct({
  action: Schema.Literal("send"),
  sessionId: Schema.String,
  input: Schema.String.annotate({
    description: "Text to send to the terminal. Use \\x03 for Ctrl+C, \\x04 for Ctrl+D. Commands are submitted with an Enter keypress",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this input does in 5-10 words" }),
})

const ReadAction = Schema.Struct({
  action: Schema.Literal("read"),
  sessionId: Schema.String,
  description: Schema.String.annotate({ description: "Clear, concise description of what you are reading" }),
})

const CloseAction = Schema.Struct({
  action: Schema.Literal("close"),
  sessionId: Schema.String,
})

export const Parameters = Schema.Union([RunAction, CreateAction, SendAction, ReadAction, CloseAction])

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Strips the echoed command from the beginning of PTY output.
 * PTYs always echo the typed command. After stripping ANSI, if the first line
 * matches the command (trimmed), we remove it.
 */
export function filterEcho(text: string, command: string): string {
  const lines = text.split("\n")
  if (lines.length === 0) return text
  const firstLine = lines[0].replace(/\r$/, "").trim()
  if (firstLine === command.trim()) {
    return lines.slice(1).join("\n")
  }
  return text
}

/**
 * Extracts the exit code from the sentinel line and removes that line.
 * The sentinel is: __OPENCODE_EXIT_<code>. The optional \r tolerates CRLF
 * line endings emitted by Windows consoles.
 */
export function extractExit(text: string): { exit: number | null; cleaned: string } {
  const regex = new RegExp(`^${SENTINEL_PREFIX}(\\d+)\\r?$`, "m")
  const match = regex.exec(text)
  if (!match) return { exit: null, cleaned: text }
  const exitCode = parseInt(match[1], 10)
  const cleaned = text
    .replace(match[0], "")
    .replace(/\n{2,}/, "\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "")
  return { exit: exitCode, cleaned }
}

/**
 * Chains stripAnsi → filterEcho → extractExit → trim
 */
export function cleanOutput(raw: string, command: string): { output: string; exit: number | null } {
  const stripped = stripAnsi(raw)
  const filtered = filterEcho(stripped, command)
  const { exit, cleaned } = extractExit(filtered)
  return { output: cleaned.trim(), exit }
}

function preview(text: string): string {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

/**
 * Appends a chunk to the session buffer, trimming from the front when it
 * exceeds the cap so unbounded sessions cannot accumulate memory forever.
 */
function appendBuffer(session: SessionState, chunk: string) {
  let { buffer, trimmed } = session
  if (buffer.length + chunk.length > SESSION_BUFFER_LIMIT) {
    const excess = buffer.length + chunk.length - SESSION_BUFFER_LIMIT
    buffer = buffer.slice(excess)
    trimmed += excess
  }
  session.buffer = buffer + chunk
  session.trimmed = trimmed
}

/**
 * Returns output produced since the last read and advances the cursor.
 */
function takeBuffer(session: SessionState): string {
  const start = Math.max(0, session.reported - session.trimmed)
  const out = session.buffer.slice(start)
  session.reported = session.trimmed + session.buffer.length
  return out
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const TerminalTool = Tool.define(
  "terminal",
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const trunc = yield* Truncate.Service
    const shell = Shell.name(Shell.acceptable())

    // The Pty service is location-scoped (it depends on Location), so it is
    // resolved per-instance through the LocationServiceMap like the HTTP PTY
    // handlers do. The map caches per-directory, so persistent sessions stay
    // reachable across tool calls of the same instance.
    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const instanceCtx = yield* InstanceState.context
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make(instanceCtx.directory) })),
        ),
      )
    })

    const sessionState = yield* InstanceState.make(
      Effect.fn("TerminalTool.state")(function* (ctx) {
        const file = path.join(PERSIST_DIR, Hash.fast(ctx.directory) + ".json")
        const sessions = new Map<string, SessionState>()

        let dirty = false
        let saveTimer: ReturnType<typeof setTimeout> | undefined

        const listeners = new Set<() => void>()
        const emit = () => {
          for (const listener of listeners) listener()
        }

        const flush = Effect.fn("TerminalTool.persist")(function* () {
          if (!dirty) return
          dirty = false
          if (sessions.size === 0) {
            yield* Effect.tryPromise(() => rm(file, { force: true })).pipe(Effect.orDie)
            return
          }
          const payload = {
            version: PERSIST_VERSION,
            sessions: [...sessions.entries()].map(([id, s]) => ({
              id,
              live: s.live,
              buffer: s.buffer,
              trimmed: s.trimmed,
              reported: s.reported,
              exitCode: s.exitCode,
              description: s.description,
              shell: s.shell,
              cwd: s.cwd,
              createdAt: s.createdAt,
            })),
          }
          yield* Effect.tryPromise(async () => {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(file, JSON.stringify(payload))
          }).pipe(Effect.orDie)
        })

        const schedule = () => {
          emit()
          if (saveTimer) return
          dirty = true
          saveTimer = setTimeout(() => {
            saveTimer = undefined
            Effect.runFork(flush())
          }, 500)
        }

        // Restore sessions persisted by a previous process. PTYs cannot
        // survive a restart, so restored sessions are marked ended but keep
        // their transcript, exit code and metadata; read works, send does not.
        const restored = yield* Effect.tryPromise(() => readFile(file, "utf8")).pipe(
          Effect.flatMap((text) => Effect.tryPromise(() => Promise.resolve(JSON.parse(text)))),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (restored && typeof restored === "object") {
          const entries = (restored as { sessions?: Array<Record<string, unknown>> }).sessions
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              if (!entry || typeof entry.id !== "string") continue
              sessions.set(entry.id, {
                ptyId: "" as PtyID,
                live: false,
                buffer: typeof entry.buffer === "string" ? entry.buffer : "",
                trimmed: typeof entry.trimmed === "number" ? entry.trimmed : 0,
                reported: typeof entry.reported === "number" ? entry.reported : 0,
                exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
                description: typeof entry.description === "string" ? entry.description : "",
                shell: typeof entry.shell === "string" ? entry.shell : "",
                cwd: typeof entry.cwd === "string" ? entry.cwd : "",
                createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
                detach: () => {},
              })
            }
          }
        }

        const store: TerminalSessionsStore = {
          snapshot: () =>
            [...sessions.entries()].map(([id, s]) => ({
              id,
              live: s.live,
              buffer: s.buffer.slice(-SNAPSHOT_BUFFER_LIMIT),
              trimmed: s.trimmed,
              reported: s.reported,
              exitCode: s.exitCode,
              description: s.description,
              shell: s.shell,
              cwd: s.cwd,
              createdAt: s.createdAt,
            })),
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          close: (id) =>
            Effect.gen(function* () {
              const session = sessions.get(id)
              if (!session) return false
              if (session.live) {
                session.detach()
                yield* pty(Pty.Service.use((s) => s.remove(session.ptyId))).pipe(Effect.catch(() => Effect.void))
              }
              sessions.delete(id)
              schedule()
              return true
            }),
          send: (id, input) =>
            Effect.gen(function* () {
              const session = sessions.get(id)
              if (!session || !session.live) return false
              const data = /^\x03|\x04|\x1a|\x1c$/.test(input) ? input : input + LINE_END
              yield* pty(Pty.Service.use((s) => s.write(session.ptyId, data))).pipe(Effect.catch(() => Effect.void))
              return true
            }),
        }
        registerTerminalSessions(ctx.directory, store)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Stop new saves, then tear down live PTYs (their onEnd no longer
            // schedules), then persist the final state, then drop the map.
            if (saveTimer) {
              clearTimeout(saveTimer)
              saveTimer = undefined
            }
            for (const session of sessions.values()) {
              if (!session.live) continue
              yield* pty(Pty.Service.use((s) => s.remove(session.ptyId))).pipe(Effect.orDie)
            }
            yield* flush()
            sessions.clear()
            listeners.clear()
            unregisterTerminalSessions(ctx.directory)
          }),
        )

        return { sessions, schedule }
      }),
    )

    // The instance directory is not known at boot (tools are initialized once
    // per process, before any instance exists), so the description uses a
    // generic reference; the tool resolves the real directory per call.
    const description = DESCRIPTION.replaceAll("${directory}", "the current working directory")
      .replaceAll("${shell}", shell)
      .replaceAll("${os}", process.platform)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))

    return {
      description,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // --- action: "run" (default, backward-compatible) ---
          if (params.action === "run" || params.action === undefined) {
            return yield* Effect.scoped(Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir ?? instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT

              yield* ctx.ask({
                permission: "terminal",
                patterns: [params.command],
                always: [],
                metadata: { command: params.command },
              })

              const info = yield* pty(Pty.Service.use((s) => s.create({
                cwd,
                title: `Agent: ${params.description.slice(0, 30)}`,
                env: {},
              })))
              const isPs = Shell.ps(info.command)

              yield* Effect.addFinalizer(() =>
                pty(Pty.Service.use((s) => s.remove(info.id))).pipe(Effect.catch(() => Effect.void)),
              )

              yield* ctx.metadata({
                metadata: {
                  output: "",
                  description: params.description,
                },
              })

              let buffer = ""

              const exitDeferred = yield* Deferred.make<
                | { kind: "sentinel"; code: number }
                | { kind: "exit"; code: number }
                | { kind: "timeout" }
                | { kind: "abort" }
              >()

              const conn = yield* pty(
                Pty.Service.use((s) =>
                  s.attach(info.id, {
                    cursor: 0,
                    onData: (chunk) => {
                      buffer += chunk
                      // The sentinel line is emitted by the shell after the
                      // command completes; it carries the command's exit code.
                      const { exit } = extractExit(stripAnsi(buffer))
                      if (exit !== null) {
                        Effect.runSync(Deferred.succeed(exitDeferred, { kind: "sentinel", code: exit }))
                      }
                      Effect.runFork(
                        ctx.metadata({
                          metadata: {
                            output: preview(buffer),
                            description: params.description,
                          },
                        }),
                      )
                    },
                    onEnd: ({ exitCode }) => {
                      Effect.runSync(Deferred.succeed(exitDeferred, { kind: "exit", code: exitCode ?? 0 }))
                    },
                  }),
                ),
              ).pipe(Effect.catch(() => Effect.succeed(undefined)))

              if (!conn) {
                return {
                  title: params.description,
                  metadata: {
                    output: "(failed to connect to PTY session)",
                    exit: null,
                    pty: true as const,
                    description: params.description,
                    truncated: false,
                  },
                  output: "(failed to connect to PTY session)",
                }
              }

              conn.activate()

              const sentinel = sentinelCommand(isPs, Shell.name(info.command))
              conn.write(params.command + LINE_END)
              // PSReadLine redraws the echoed line asynchronously; sending the
              // sentinel immediately after the command can interleave with that
              // redraw. A short gap keeps the sentinel on its own line.
              yield* Effect.sleep("250 millis")
              conn.write(sentinel + LINE_END)

              const abort = Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) {
                  resume(Effect.void)
                  return Effect.sync(() => {})
                }
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })

              const result = yield* Effect.raceAll([
                Deferred.await(exitDeferred),
                abort.pipe(Effect.map(() => ({ kind: "abort" as const }))),
                Effect.sleep(`${timeout + 100} millis`).pipe(Effect.map(() => ({ kind: "timeout" as const }))),
              ])

              conn.detach()
              // The shell stays alive after the command; remove the session to
              // tear the process down. This also fires onEnd, which is a no-op
              // because the deferred is already completed.
              yield* pty(Pty.Service.use((s) => s.remove(info.id))).pipe(Effect.catch(() => Effect.void))

              const { output } = cleanOutput(buffer, params.command)
              const exitCode = result.kind === "sentinel" || result.kind === "exit" ? result.code : null

              const meta: string[] = []
              if (result.kind === "timeout") {
                meta.push(
                  `terminal tool terminated command after exceeding timeout ${timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
                )
              }
              if (result.kind === "abort") {
                meta.push("User aborted the command")
              }

              const truncated = yield* trunc.output(output)

              let finalOutput = truncated.content
              if (!finalOutput) finalOutput = "(no output)"
              if (truncated.truncated && truncated.outputPath) {
                finalOutput = `...output truncated...\n\nFull output saved to: ${truncated.outputPath}\n\n` + finalOutput
              }
              if (meta.length > 0) {
                finalOutput += "\n\n<terminal_metadata>\n" + meta.join("\n") + "\n</terminal_metadata>"
              }

              return {
                title: params.description,
                metadata: {
                  output: preview(finalOutput),
                  exit: exitCode,
                  pty: true as const,
                  description: params.description,
                  truncated: truncated.truncated,
                  ...(truncated.truncated && truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
                },
                output: finalOutput,
              }
            }))
          }

          // --- action: "create" (persistent PTY session) ---
          if (params.action === "create") {
            const instanceCtx = yield* InstanceState.context
            const cwd = params.workdir ?? instanceCtx.directory
            const desc = params.description ?? "Terminal session"

            yield* ctx.ask({
              permission: "terminal",
              patterns: [desc],
              always: [],
              metadata: { description: desc },
            })

            const { sessions, schedule } = yield* InstanceState.get(sessionState)

            // FIFO eviction: if at max, remove oldest
            if (sessions.size >= MAX_SESSIONS) {
              const oldest = sessions.keys().next().value
              if (oldest) {
                const oldSession = sessions.get(oldest)!
                sessions.delete(oldest)
                oldSession.detach()
                yield* pty(Pty.Service.use((s) => s.remove(oldSession.ptyId))).pipe(Effect.catch(() => Effect.void))
                schedule()
              }
            }

            const info = yield* pty(Pty.Service.use((s) =>
              s.create({
                cwd,
                title: desc.slice(0, 30),
                env: {},
              }),
            ))

            const session: SessionState = {
              ptyId: info.id,
              live: true,
              buffer: "",
              trimmed: 0,
              reported: 0,
              exitCode: null,
              description: desc,
              shell: Shell.name(info.command),
              cwd,
              createdAt: Date.now(),
              detach: () => {},
            }

            const conn = yield* pty(
              Pty.Service.use((s) =>
                s.attach(info.id, {
                  cursor: -1,
                  onData: (chunk) => {
                    appendBuffer(session, chunk)
                    schedule()
                    Effect.runFork(
                      ctx.metadata({
                        metadata: {
                          output: preview(session.buffer),
                          description: desc,
                          pty: true as const,
                        },
                      }),
                    )
                  },
                  onEnd: ({ exitCode }) => {
                    if (exitCode !== undefined) {
                      session.exitCode = exitCode
                      schedule()
                    }
                  },
                }),
              ),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (conn) {
              conn.activate()
              session.detach = () => conn.detach()
            }

            sessions.set(info.id, session)
            schedule()

            return {
              title: desc,
              metadata: {
                output: "(session created)",
                exit: null,
                pty: true as const,
                description: desc,
                truncated: false,
                sessionId: info.id,
              },
              output: `Session created: ${info.id}\nShell: ${session.shell}\nWorkdir: ${cwd}`,
            }
          }

          // --- action: "send" (write to PTY stdin) ---
          if (params.action === "send") {
            const { sessions } = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: params.description ?? "Send input",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: params.description ?? "Send input",
                  truncated: false,
                },
                output: `Error: Session ${params.sessionId} not found. Use action="create" to start a new session.`,
              }
            }

            if (!session.live) {
              return {
                title: params.description ?? "Send input",
                metadata: {
                  output: `(session ${params.sessionId} not running)`,
                  exit: session.exitCode,
                  pty: true as const,
                  description: params.description ?? "Send input",
                  truncated: false,
                },
                output: `Error: Session ${params.sessionId} is not running (it was restored from before a restart and its terminal no longer exists). Use action="create" to start a new session.`,
              }
            }

            yield* ctx.ask({
              permission: "terminal",
              patterns: [params.input],
              always: [],
              metadata: { input: params.input },
            })

            // Send input to PTY — append a newline for commands (unless it's a control sequence)
            const data = /^\x03|\x04|\x1a|\x1c$/.test(params.input) ? params.input : params.input + LINE_END
            yield* pty(Pty.Service.use((s) => s.write(session.ptyId, data))).pipe(Effect.catch(() => Effect.void))

            return {
              title: params.description ?? "Send input",
              metadata: {
                output: "(input sent)",
                exit: null,
                pty: true as const,
                description: params.description ?? "Send input",
                truncated: false,
              },
              output: `(input sent to session ${params.sessionId})`,
            }
          }

          // --- action: "read" (cursor-based incremental output) ---
          if (params.action === "read") {
            const { sessions, schedule } = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: params.description ?? "Read output",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: params.description ?? "Read output",
                  truncated: false,
                  sessionId: params.sessionId,
                },
                output: `Error: Session ${params.sessionId} not found. Use action="create" to start a new session.`,
              }
            }

            const newOutput = takeBuffer(session)
            schedule()

            const cleaned = stripAnsi(newOutput).trim()

            const exitCode = session.exitCode

            let finalOutput = cleaned
            if (!session.live) {
              finalOutput = finalOutput
                ? finalOutput +
                  "\n\n(Note: this session was restored from before a restart and is no longer running. Create a new session to continue.)"
                : "(no new output — session restored from before a restart; it is no longer running)"
            } else if (!finalOutput) {
              finalOutput = "(no new output)"
            }

            const truncated = yield* trunc.output(finalOutput)

            return {
              title: params.description ?? "Read output",
              metadata: {
                output: preview(truncated.content),
                exit: exitCode,
                pty: true as const,
                description: params.description ?? "Read output",
                truncated: truncated.truncated,
                ...(truncated.truncated && truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
                sessionId: params.sessionId,
              },
              output: truncated.content || "(no new output)",
            }
          }

          // --- action: "close" (terminate session + cleanup) ---
          if (params.action === "close") {
            const { sessions, schedule } = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: "Close session",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: "Close session",
                  truncated: false,
                },
                output: `Error: Session ${params.sessionId} not found.`,
              }
            }

            if (session.live) {
              session.detach()
              yield* pty(Pty.Service.use((s) => s.remove(session.ptyId))).pipe(Effect.catch(() => Effect.void))
            }
            sessions.delete(params.sessionId)
            schedule()

            return {
              title: "Close session",
              metadata: {
                output: "(session closed)",
                exit: null,
                pty: true as const,
                description: `Closed session ${params.sessionId}`,
                truncated: false,
              },
              output: `(session ${params.sessionId} closed)`,
            }
          }

          // Should never reach here — Schema validates action
          throw new Error(`Unknown action: ${(params as { action?: string }).action}`)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
