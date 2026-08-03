import { describe, expect, test } from "bun:test"
import { cleanOutput, extractExit, filterEcho, sentinelCommand } from "../../src/tool/terminal"

describe("sentinelCommand", () => {
  test("uses [int] cast for PowerShell so a fresh shell reports 0", () => {
    expect(sentinelCommand(true, "powershell")).toBe('echo "__OPENCODE_EXIT_$([int]$LASTEXITCODE)"')
  })

  test("uses %ERRORLEVEL% for cmd.exe", () => {
    expect(sentinelCommand(false, "cmd")).toBe("echo __OPENCODE_EXIT_%ERRORLEVEL%")
  })

  test("uses $? for POSIX shells", () => {
    expect(sentinelCommand(false, "bash")).toBe('echo "__OPENCODE_EXIT_$?"')
  })
})

describe("filterEcho", () => {
  test("removes the echoed command line", () => {
    expect(filterEcho("echo hi\r\nhi\r\n", "echo hi")).toBe("hi\r\n")
  })

  test("leaves text untouched when the first line does not match", () => {
    const text = "PS> echo hi\r\nhi\r\n"
    expect(filterEcho(text, "echo hi")).toBe(text)
  })
})

describe("extractExit", () => {
  test("detects the sentinel with LF line endings", () => {
    const { exit, cleaned } = extractExit("out\n__OPENCODE_EXIT_42\n")
    expect(exit).toBe(42)
    expect(cleaned.trim()).toBe("out")
  })

  test("detects the sentinel with CRLF line endings (Windows)", () => {
    const { exit, cleaned } = extractExit("out\r\n__OPENCODE_EXIT_0\r\n")
    expect(exit).toBe(0)
    expect(cleaned.trim()).toBe("out")
  })

  test("returns null when no sentinel is present", () => {
    const text = "no marker here"
    expect(extractExit(text)).toEqual({ exit: null, cleaned: text })
  })
})

describe("cleanOutput", () => {
  test("strips ANSI, echo, and sentinel, returning output and exit code", () => {
    const raw = "\u001b[1mPS> echo hi\r\necho hi\r\nhi\r\n\u001b[0m__OPENCODE_EXIT_0\r\n"
    const { output, exit } = cleanOutput(raw, "echo hi")
    expect(exit).toBe(0)
    expect(output).toContain("hi")
    expect(output).not.toContain("__OPENCODE_EXIT")
  })

  test("detects the exit code even when the echo is garbled by PSReadLine redraws", () => {
    const raw = "e\u0008echo echo hi\r\nhi\r\n__OPENCODE_EXIT_0\r\n"
    const { output, exit } = cleanOutput(raw, "echo hi")
    expect(exit).toBe(0)
    expect(output).toContain("hi")
  })

  test("reports null exit when the sentinel never appears", () => {
    const { output, exit } = cleanOutput("some output", "echo hi")
    expect(exit).toBeNull()
    expect(output).toBe("some output")
  })
})
