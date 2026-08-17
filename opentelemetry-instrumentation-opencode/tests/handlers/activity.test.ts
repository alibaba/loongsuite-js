import { describe, test, expect } from "bun:test"
import { handleSessionDiff, handleCommandExecuted } from "../../src/handlers/activity.ts"
import { makeCtx } from "../helpers.ts"
import type { EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"

function makeSessionDiff(
  sessionID: string,
  diffs: Array<{ file: string; additions: number; deletions: number }>,
): EventSessionDiff {
  return {
    type: "session.diff",
    properties: {
      sessionID,
      diff: diffs.map((d) => ({ before: "", after: "", additions: d.additions, deletions: d.deletions, file: d.file })),
    },
  } as unknown as EventSessionDiff
}

function makeCommandExecuted(name: string, args: string, sessionID = "ses_1"): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: { name, arguments: args, sessionID, messageID: "msg_1" },
  } as unknown as EventCommandExecuted
}

describe("handleSessionDiff", () => {
  test("increments linesCounter for additions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 10, deletions: 0 }]), ctx)
    expect(counters.lines.calls).toHaveLength(1)
    expect(counters.lines.calls.at(0)!.value).toBe(10)
    expect(counters.lines.calls.at(0)!.attrs["type"]).toBe("added")
  })

  test("increments linesCounter for deletions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 0, deletions: 5 }]), ctx)
    expect(counters.lines.calls).toHaveLength(1)
    expect(counters.lines.calls.at(0)!.value).toBe(5)
    expect(counters.lines.calls.at(0)!.attrs["type"]).toBe("removed")
  })

  test("increments both added and removed for mixed diffs", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 8, deletions: 3 }]), ctx)
    expect(counters.lines.calls).toHaveLength(2)
    const types = counters.lines.calls.map((c) => c.attrs["type"])
    expect(types).toContain("added")
    expect(types).toContain("removed")
  })

  test("handles multiple files", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(
      makeSessionDiff("ses_1", [
        { file: "a.ts", additions: 5, deletions: 0 },
        { file: "b.ts", additions: 3, deletions: 2 },
      ]),
      ctx,
    )
    const totalAdded = counters.lines.calls
      .filter((c) => c.attrs["type"] === "added")
      .reduce((sum, c) => sum + c.value, 0)
    expect(totalAdded).toBe(8)
  })

  test("skips zero additions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 0, deletions: 0 }]), ctx)
    expect(counters.lines.calls).toHaveLength(0)
  })
})

describe("handleCommandExecuted", () => {
  test("increments commit counter for git commit", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", 'git commit -m "feat: add thing"'), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("emits commit log record", () => {
    const { ctx, logger } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "git commit -m 'fix: bug'"), ctx)
    expect(logger.records).toHaveLength(1)
    expect(logger.records.at(0)!.body).toBe("commit")
    expect(logger.records.at(0)!.attributes?.["session.id"]).toBe("ses_1")
  })

  test("ignores non-bash commands", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("python", "git commit -m foo"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("ignores bash commands without git commit", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "npm install"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not match git commit-graph", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "git commit-graph write"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not match string containing 'git commit' in echo", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", 'echo "run git commit to save"'), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("matches git commit with --amend", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "git commit --amend --no-edit"), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })
})
