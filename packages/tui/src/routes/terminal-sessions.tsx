import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import type { TerminalSessionSnapshot } from "@opencode-ai/sdk/v2"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useTuiConfig } from "../config"
import { OPENCODE_BASE_MODE, useBindings } from "../keymap"

const POLL_INTERVAL = 1000
const BUFFER_TAIL = 4000

const terminalMonitorCommands = [
  "terminal.monitor.next",
  "terminal.monitor.previous",
  "terminal.monitor.close",
  "terminal.monitor.input",
  "terminal.monitor.refresh",
  "terminal.monitor.back",
] as const

function shortID(id: string) {
  return id.length > 12 ? id.slice(0, 12) : id
}

function formatTime(epoch: number) {
  return new Date(epoch).toLocaleTimeString()
}

export function TerminalSessions() {
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()

  const [sessions, setSessions] = createSignal<TerminalSessionSnapshot[]>([])
  const [selected, setSelected] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()
  let input: InputRenderable | undefined

  const inputFocused = () => input?.focused ?? false

  async function refresh() {
    const result = await sdk.client.terminalSessions.list()
    if (result.error) {
      setError(result.error.data?.message ?? "Failed to load terminal sessions")
      return
    }
    setError(undefined)
    const list = result.data ?? []
    setSessions(list)
    if (selected() >= list.length) setSelected(Math.max(0, list.length - 1))
  }

  onMount(() => {
    void refresh()
  })

  createEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  const current = () => sessions()[selected()]

  async function closeSelected() {
    const session = current()
    if (!session) return
    const result = await sdk.client.terminalSessions.close({ sessionID: session.id })
    if (result.error) {
      toast.show({
        variant: "error",
        message: result.error.data?.message ?? "Failed to close terminal session",
      })
      return
    }
    void refresh()
  }

  async function sendInput() {
    const session = current()
    if (!session || !input) return
    const value = input.value.trim()
    if (!value) return
    const result = await sdk.client.terminalSessions.send({
      sessionID: session.id,
      terminalSessionSendInput: { input: value },
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message: result.error.data?.message ?? "Failed to send input to terminal session",
      })
      return
    }
    input.value = ""
    input.blur()
  }

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => !inputFocused(),
    priority: 1,
    bindings: tuiConfig.keybinds.gather("terminal.monitor", terminalMonitorCommands),
    commands: [
      {
        name: "terminal.monitor.next",
        title: "Select next terminal session",
        category: "Terminal",
        hidden: true,
        run: () => setSelected((index) => Math.min(index + 1, Math.max(0, sessions().length - 1))),
      },
      {
        name: "terminal.monitor.previous",
        title: "Select previous terminal session",
        category: "Terminal",
        hidden: true,
        run: () => setSelected((index) => Math.max(0, index - 1)),
      },
      {
        name: "terminal.monitor.close",
        title: "Close selected terminal session",
        category: "Terminal",
        hidden: true,
        run: () => void closeSelected(),
      },
      {
        name: "terminal.monitor.input",
        title: "Send input to selected terminal session",
        category: "Terminal",
        hidden: true,
        run: () => {
          input?.focus()
        },
      },
      {
        name: "terminal.monitor.refresh",
        title: "Refresh terminal session list",
        category: "Terminal",
        hidden: true,
        run: () => void refresh(),
      },
      {
        name: "terminal.monitor.back",
        title: "Return from terminal session monitor",
        category: "Terminal",
        hidden: true,
        run: () => {
          if (inputFocused()) {
            input?.blur()
            return
          }
          route.navigate({ type: "home" })
        },
      },
    ],
  }))

  const buffer = () => current()?.buffer.slice(-BUFFER_TAIL) ?? ""

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Terminal Sessions
        </text>
        <text fg={theme.textMuted}>
          {sessions().filter((session) => session.live).length} live / {sessions().length} total
        </text>
      </box>
      <Show when={error()}>
        <text fg={theme.error} paddingLeft={1}>
          {error()}
        </text>
      </Show>
      <box flexGrow={1} minHeight={0} paddingTop={1}>
        <scrollbox scrollY stickyScroll stickyStart="bottom" flexGrow={1} minHeight={0}>
          <Show
            when={current()}
            fallback={<text fg={theme.textMuted} paddingLeft={1}>No terminal sessions</text>}
            keyed
          >
            {(session) => (
              <box flexDirection="column">
                <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
                  <text fg={session.live ? theme.success : theme.textMuted}>{session.live ? "●" : "○"}</text>
                  <text attributes={TextAttributes.BOLD} fg={theme.text}>
                    {session.shell}
                  </text>
                  <text fg={theme.textMuted}>{shortID(session.id)}</text>
                  <text fg={theme.textMuted}>{session.cwd}</text>
                  <Show when={session.exitCode !== null}>
                    <text fg={theme.warning}>exit {session.exitCode}</text>
                  </Show>
                </box>
                <Show when={session.description}>
                  <text fg={theme.textMuted} paddingLeft={1}>
                    {session.description}
                  </text>
                </Show>
                <text fg={theme.text} paddingLeft={1}>
                  {buffer() || " "}
                </text>
              </box>
            )}
          </Show>
        </scrollbox>
      </box>
      <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <box flexDirection="row" gap={2}>
          <For each={sessions()}>
            {(session, index) => (
              <box
                onMouseDown={() => setSelected(index())}
                backgroundColor={index() === selected() ? theme.backgroundElement : theme.background}
              >
                <text fg={index() === selected() ? theme.text : theme.textMuted}>
                  {index() + 1}:{shortID(session.id)}
                </text>
              </box>
            )}
          </For>
        </box>
        <Show when={current()}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>input</text>
            <input
              flexGrow={1}
              placeholder={current()?.live ? "Send input to selected session (enter)" : "Session ended"}
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              onSubmit={() => void sendInput()}
              ref={(value: InputRenderable) => {
                input = value
                setInputTarget(value)
              }}
            />
          </box>
        </Show>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>j/k navigate</text>
          <text fg={theme.textMuted}>i input</text>
          <text fg={theme.textMuted}>x close</text>
          <text fg={theme.textMuted}>r refresh</text>
          <text fg={theme.textMuted}>q back</text>
        </box>
      </box>
    </box>
  )
}
