import { InstanceState } from "@/effect/instance-state"
import { getTerminalSessions } from "@/tool/terminal-sessions"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const terminalSessionsHandlers = HttpApiBuilder.group(InstanceHttpApi, "terminal-sessions", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "list",
        Effect.fn("TerminalSessionsHttpApi.list")(function* () {
          const store = getTerminalSessions((yield* InstanceState.context).directory)
          return store ? store.snapshot() : []
        }),
      )
      .handle(
        "close",
        Effect.fn("TerminalSessionsHttpApi.close")(function* (ctx: { params: { sessionID: string } }) {
          const store = getTerminalSessions((yield* InstanceState.context).directory)
          return store ? yield* store.close(ctx.params.sessionID) : false
        }),
      )
      .handle(
        "send",
        Effect.fn("TerminalSessionsHttpApi.send")(function* (ctx: {
          params: { sessionID: string }
          payload: { input: string }
        }) {
          const store = getTerminalSessions((yield* InstanceState.context).directory)
          return store ? yield* store.send(ctx.params.sessionID, ctx.payload.input) : false
        }),
      )
  }),
)
