import { findTerminalSessions, listTerminalSessions } from "@/tool/terminal-sessions"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const terminalSessionsHandlers = HttpApiBuilder.group(InstanceHttpApi, "terminal-sessions", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "list",
        Effect.fn("TerminalSessionsHttpApi.list")(function* () {
          return listTerminalSessions()
            .flatMap((store) => store.snapshot())
            .toSorted((a, b) => a.createdAt - b.createdAt)
        }),
      )
      .handle(
        "close",
        Effect.fn("TerminalSessionsHttpApi.close")(function* (ctx: { params: { sessionID: string } }) {
          const store = findTerminalSessions(ctx.params.sessionID)
          return store ? yield* store.close(ctx.params.sessionID) : false
        }),
      )
      .handle(
        "send",
        Effect.fn("TerminalSessionsHttpApi.send")(function* (ctx: {
          params: { sessionID: string }
          payload: { input: string }
        }) {
          const store = findTerminalSessions(ctx.params.sessionID)
          return store ? yield* store.send(ctx.params.sessionID, ctx.payload.input) : false
        }),
      )
  }),
)
