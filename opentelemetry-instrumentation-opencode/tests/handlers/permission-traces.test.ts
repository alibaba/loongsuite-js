import { describe, it, expect } from "bun:test"
import { makeCtx, type SpySpan } from "../helpers.ts"
import { handlePermissionUpdated, handlePermissionReplied } from "../../src/handlers/permission.ts"
import { handleSessionCreated } from "../../src/handlers/session.ts"
import { handleMessagePartUpdated } from "../../src/handlers/message.ts"
import { SPAN_KIND_ATTR } from "../../src/util.ts"
import type { EventPermissionUpdated, EventPermissionReplied, EventSessionCreated, EventMessagePartUpdated } from "@opencode-ai/sdk"

function sessionCreatedEvent(id = "sess_1"): EventSessionCreated {
  return {
    type: "session.created",
    properties: {
      info: {
        id,
        projectID: "proj_test",
        directory: "/tmp",
        title: "test",
        version: 1,
        time: { created: 1000, updated: 1000 },
      },
    },
  } as unknown as EventSessionCreated
}

function toolRunningEvent(sessionID = "sess_1", callID = "call_1"): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_1",
        sessionID,
        messageID: "msg_1",
        type: "tool",
        callID,
        tool: "bash",
        state: { status: "running", input: '{"cmd":"rm -rf"}', time: { start: 1500 } },
      },
    },
  } as unknown as EventMessagePartUpdated
}

function permUpdatedEvent(opts: { id?: string; sessionID?: string; callID?: string } = {}): EventPermissionUpdated {
  return {
    type: "permission.updated",
    properties: {
      id: opts.id ?? "perm_1",
      type: "tool",
      title: "bash: rm -rf",
      sessionID: opts.sessionID ?? "sess_1",
      callID: opts.callID ?? "call_1",
      time: { created: 1600 },
    },
  } as unknown as EventPermissionUpdated
}

function permRepliedEvent(opts: { permissionID?: string; sessionID?: string; response?: string } = {}): EventPermissionReplied {
  return {
    type: "permission.replied",
    properties: {
      permissionID: opts.permissionID ?? "perm_1",
      sessionID: opts.sessionID ?? "sess_1",
      response: opts.response ?? "allow",
    },
  } as EventPermissionReplied
}

describe("permission traces", () => {
  it("adds span event on tool span when permission is replied", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(toolRunningEvent(), ctx)

    handlePermissionUpdated(permUpdatedEvent(), ctx)
    handlePermissionReplied(permRepliedEvent({ response: "allow" }), ctx)

    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(toolSpan.events).toHaveLength(1)
    expect(toolSpan.events[0]!.name).toBe("permission.decision")
    expect(toolSpan.events[0]!.attributes?.decision).toBe("accept")
    expect(toolSpan.events[0]!.attributes?.tool_name).toBe("bash: rm -rf")
  })

  it("records reject decision", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(toolRunningEvent(), ctx)

    handlePermissionUpdated(permUpdatedEvent(), ctx)
    handlePermissionReplied(permRepliedEvent({ response: "deny" }), ctx)

    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(toolSpan.events[0]!.attributes?.decision).toBe("reject")
  })

  it("does not add span event when no active tool span found", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    // no tool running

    handlePermissionUpdated(permUpdatedEvent({ callID: "call_unknown" }), ctx)
    handlePermissionReplied(permRepliedEvent(), ctx)

    expect(spyTracer!.spans.every(s => s.events.length === 0)).toBe(true)
  })
})
