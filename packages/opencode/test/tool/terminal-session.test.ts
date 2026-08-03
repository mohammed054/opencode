import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { TerminalTool } from "../../src/tool/terminal"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-terminal-session"),
  messageID: MessageID.make("msg_test-terminal"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

const layer = LayerNode.compile(
  LayerNode.group([
    locationServiceMapNode,
    LSP.node,
    FSUtil.node,
    Format.node,
    EventV2Bridge.node,
    Truncate.node,
    Agent.node,
  ]),
)

const it = testEffect(layer)

// Mirrors production: the registry initializes the tool once and reuses the
// same def (and its persistent session state) for every tool call.
const initTool = Effect.fn("TerminalToolTest.init")(function* () {
  const info = yield* TerminalTool
  return yield* info.init()
})

describe("tool.terminal (live PTY)", () => {
  it.instance("run executes a command and reports its exit code", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = yield* initTool()
      const result = yield* tool.execute(
        {
          action: "run",
          command: "echo hello",
          description: "test echo",
          workdir: test.directory,
          timeout: 20_000,
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("hello")
    }),
  )

  it.instance("run reports a non-zero exit code", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = yield* initTool()
      const result = yield* tool.execute(
        {
          action: "run",
          command: "exit 42",
          description: "test exit code",
          workdir: test.directory,
          timeout: 20_000,
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(42)
    }),
  )

  it.instance("run always settles on timeout", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = yield* initTool()
      const started = Date.now()
      const result = yield* tool.execute(
        {
          action: "run",
          command: "sleep 30",
          description: "test timeout",
          workdir: test.directory,
          timeout: 3_000,
        },
        ctx,
      )
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(20_000)
      expect(result.output).toContain("terminal tool terminated command after exceeding timeout")
    }),
  )

  it.instance("create/send/read/close interactive session round-trip", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = yield* initTool()
      const created = yield* tool.execute(
        {
          action: "create",
          workdir: test.directory,
          description: "interactive test",
        },
        ctx,
      )
      const sessionId = (created.metadata as { sessionId?: string }).sessionId
      expect(typeof sessionId).toBe("string")

      const sent = yield* tool.execute(
        { action: "send", sessionId: sessionId!, input: "echo hello", description: "send echo" },
        ctx,
      )
      expect(sent.output).toContain("sent")

      // Poll the session buffer until the echoed output shows up
      let found = false
      for (let i = 0; i < 20; i++) {
        yield* Effect.sleep("250 millis")
        const read = yield* tool.execute(
          { action: "read", sessionId: sessionId!, description: "read output" },
          ctx,
        )
        if (read.output.includes("hello")) {
          found = true
          break
        }
      }
      expect(found).toBe(true)

      const closed = yield* tool.execute({ action: "close", sessionId: sessionId! }, ctx)
      expect(closed.output).toContain("closed")

      const missing = yield* tool.execute(
        { action: "send", sessionId: sessionId!, input: "echo again", description: "send closed" },
        ctx,
      )
      expect(missing.output).toContain("not found")
    }),
  )

  it.instance("send Ctrl+C aborts a running command and the session survives", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = yield* initTool()
      const created = yield* tool.execute(
        {
          action: "create",
          workdir: test.directory,
          description: "abort test",
        },
        ctx,
      )
      const sessionId = (created.metadata as { sessionId?: string }).sessionId!
      expect(typeof sessionId).toBe("string")

      // Infinite loop — will only stop when interrupted
      const loopCommand = process.platform === "win32" ? "ping -t 127.0.0.1" : "sleep 1000"
      const sent = yield* tool.execute(
        {
          action: "send",
          sessionId,
          input: loopCommand,
          description: "start infinite loop",
        },
        ctx,
      )
      expect(sent.output).toContain("sent")

      yield* Effect.sleep("1 second")
      const before = yield* tool.execute(
        { action: "read", sessionId, description: "read running output" },
        ctx,
      )
      expect(before.output).not.toContain("not found")
      expect(before.output).not.toBe("(no new output)")

      // Abort with Ctrl+C
      yield* tool.execute({ action: "send", sessionId, input: "\x03", description: "interrupt with ctrl+c" }, ctx)
      yield* Effect.sleep("1 second")

      // The session should still be alive and reachable; read returns without
      // the "not found" error and close works.
      const after = yield* tool.execute({ action: "read", sessionId, description: "read after abort" }, ctx)
      expect(after.output).not.toContain("not found")

      const closed = yield* tool.execute({ action: "close", sessionId }, ctx)
      expect(closed.output).toContain("closed")
    }),
  )
})
