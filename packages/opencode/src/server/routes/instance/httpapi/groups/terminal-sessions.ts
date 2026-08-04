import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/terminal-sessions"

export const TerminalSessionSnapshot = Schema.Struct({
  id: Schema.String,
  live: Schema.Boolean,
  buffer: Schema.String,
  trimmed: Schema.Number,
  reported: Schema.Number,
  exitCode: Schema.NullOr(Schema.Number),
  description: Schema.String,
  shell: Schema.String,
  agent: Schema.String.annotate({ description: "Name of the agent that created the session" }),
  container: Schema.NullOr(Schema.String).annotate({
    description: "Container the session runs inside, when created with the container param",
  }),
  cwd: Schema.String,
  createdAt: Schema.Number,
}).annotate({ identifier: "TerminalSessionSnapshot" })

export const SessionIdParams = Schema.Struct({ sessionID: Schema.String })

export const SendInput = Schema.Struct({
  input: Schema.String.annotate({ description: "Text to write to the session's terminal" }),
}).annotate({ identifier: "TerminalSessionSendInput" })

export const TerminalSessionsPaths = {
  list: root,
  close: `${root}/:sessionID/close`,
  send: `${root}/:sessionID/send`,
} as const

export const TerminalSessionsApi = HttpApi.make("terminal-sessions")
  .add(
    HttpApiGroup.make("terminal-sessions")
      .add(
        HttpApiEndpoint.get("list", TerminalSessionsPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(TerminalSessionSnapshot), "List of terminal sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "terminal-sessions.list",
            summary: "List terminal sessions",
            description: "List the agent's terminal sessions for the instance, including ended ones.",
          }),
        ),
        HttpApiEndpoint.post("close", TerminalSessionsPaths.close, {
          params: SessionIdParams,
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Session closed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "terminal-sessions.close",
            summary: "Close terminal session",
            description: "Terminate a terminal session and free its resources.",
          }),
        ),
        HttpApiEndpoint.post("send", TerminalSessionsPaths.send, {
          params: SessionIdParams,
          query: WorkspaceRoutingQuery,
          payload: SendInput,
          success: described(Schema.Boolean, "Input sent"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "terminal-sessions.send",
            summary: "Send input to terminal session",
            description: "Write input to a running terminal session (commands are submitted with Enter).",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "terminal-sessions", description: "Terminal session monitor routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode instance HttpApi",
      version: "0.0.1",
      description: "Instance-scoped HttpApi surface for terminal session monitoring.",
    }),
  )
