import { describe, it, expect } from "bun:test"
import { makeCtx } from "../helpers.ts"
import { handleMessageUpdated, handleMessagePartUpdated } from "../../src/handlers/message.ts"
import { handleSessionCreated } from "../../src/handlers/session.ts"
import { SpanStatusCode } from "@opentelemetry/api"
import { SPAN_KIND_ATTR } from "../../src/util.ts"
import type { EventMessageUpdated, EventMessagePartUpdated, EventSessionCreated } from "@opencode-ai/sdk"

function sessionCreatedEvent(id = "sess_1", createdAt = 1000): EventSessionCreated {
  return {
    type: "session.created",
    properties: {
      info: {
        id,
        projectID: "proj_test",
        directory: "/tmp",
        title: "test",
        version: 1,
        time: { created: createdAt, updated: createdAt },
      },
    },
  } as unknown as EventSessionCreated
}

function assistantMessageEvent(opts: {
  sessionID?: string
  messageID?: string
  modelID?: string
  providerID?: string
  created?: number
  completed?: number
  cost?: number
  error?: unknown
} = {}): EventMessageUpdated {
  const {
    sessionID = "sess_1",
    messageID = "msg_1",
    modelID = "claude-sonnet-4-20250514",
    providerID = "anthropic",
    created = 1000,
    completed = 2000,
    cost = 0.01,
    error,
  } = opts
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        modelID,
        providerID,
        parentID: "parent_1",
        mode: "chat",
        path: { cwd: "/tmp", root: "/tmp" },
        cost,
        time: { created, completed },
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 3 } },
        summary: true,
        ...(error ? { error } : {}),
      },
    },
  } as unknown as EventMessageUpdated
}

function textPartEvent(opts: {
  sessionID?: string
  messageID?: string
  partID?: string
  text?: string
  /** When set, part gets `time.start` so the LLM span opens immediately; omit to simulate streaming without timestamps. */
  timeStart?: number
} = {}): EventMessagePartUpdated {
  const {
    sessionID = "sess_1",
    messageID = "msg_1",
    partID = "text_1",
    text = "Hello world",
    timeStart,
  } = opts
  const part: Record<string, unknown> = {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text,
  }
  if (timeStart !== undefined) part.time = { start: timeStart }
  return {
    type: "message.part.updated",
    properties: { part },
  } as unknown as EventMessagePartUpdated
}

function toolPartEvent(opts: {
  sessionID?: string
  messageID?: string
  callID?: string
  tool?: string
  status?: string
  start?: number
  end?: number
  input?: string
  output?: string
  error?: string
} = {}): EventMessagePartUpdated {
  const {
    sessionID = "sess_1",
    messageID = "msg_1",
    callID = "call_1",
    tool = "bash",
    status = "running",
    start = 1500,
    end: endTime,
    input = '{"cmd":"ls"}',
    output = "file1\nfile2",
    error,
  } = opts

  const state: Record<string, unknown> = { status, input, time: { start, end: endTime } }
  if (status === "completed") state.output = output
  if (status === "error") state.error = error ?? "tool failed"

  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part_1",
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state,
      },
    },
  } as unknown as EventMessagePartUpdated
}

describe("message traces", () => {
  it("creates Entry/Agent/Step/LLM spans and finalizes LLM on message.updated", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(textPartEvent({ text: "Hello", timeStart: 900 }), ctx)
    expect(ctx.activeMessageSpans.size).toBe(1)
    expect(spyTracer!.spans).toHaveLength(3) // ENTRY + AGENT + LLM (no STEP)
    expect(spyTracer!.spans[0]!.attributes[SPAN_KIND_ATTR]).toBe("ENTRY")
    expect(spyTracer!.spans[1]!.attributes[SPAN_KIND_ATTR]).toBe("AGENT")
    const llmSpan = spyTracer!.spans[2]!
    expect(llmSpan.attributes[SPAN_KIND_ATTR]).toBe("LLM")
    handleMessageUpdated(assistantMessageEvent(), ctx)
    expect(llmSpan.name).toBe("chat claude-sonnet-4-20250514")
    expect(llmSpan.attributes["gen_ai.provider.name"]).toBe("anthropic")
    expect(llmSpan.attributes["gen_ai.usage.total_tokens"]).toBe(168)
    expect(llmSpan.status.code).toBe(SpanStatusCode.OK)
  })

  it("sets ERROR on LLM and STEP when assistant message fails", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessageUpdated(assistantMessageEvent({
      error: { name: "ApiError", data: { message: "rate limited" } },
    }), ctx)
    // stepSpan removed — finish_reason is now on the LLM span
    const llmSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "LLM")!
    expect(llmSpan.attributes["gen_ai.react.finish_reason"]).toBe("error")
    expect(llmSpan.status.code).toBe(SpanStatusCode.ERROR)
  })

  it("creates TOOL span with semantic attributes", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(toolPartEvent({ status: "running", start: 1500 }), ctx)
    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(toolSpan.name).toBe("execute_tool bash")
    expect(toolSpan.attributes["gen_ai.operation.name"]).toBe("execute_tool")
    expect(toolSpan.attributes["gen_ai.tool.name"]).toBe("bash")
    expect(toolSpan.attributes["gen_ai.tool.call.id"]).toBe("call_1")
    handleMessagePartUpdated(toolPartEvent({ status: "completed", start: 1500, end: 1800, output: "ok" }), ctx)
    expect(toolSpan.status.code).toBe(SpanStatusCode.OK)
    expect(toolSpan.attributes["gen_ai.tool.call.result"]).toBe("ok")
  })

  it("does not truncate gen_ai.tool.call.arguments", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    ctx.maxContentSize = 5
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(toolPartEvent({ status: "running", input: "{\"cmd\":\"very-long-command\"}" }), ctx)
    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(toolSpan.attributes["gen_ai.tool.call.arguments"]).toBe("{\"cmd\":\"very-long-command\"}")
  })

  it("defers text without time until tool running so LLM start is not after tool", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(textPartEvent({ text: "streaming…" }), ctx)
    expect(ctx.activeMessageSpans.size).toBe(0)
    expect(ctx.deferredMessageTextParts.size).toBe(1)
    handleMessagePartUpdated(toolPartEvent({ status: "running", start: 1500 }), ctx)
    const llmSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "LLM")!
    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(llmSpan.startTime).toBe(1500)
    expect(toolSpan.startTime).toBe(1500)
    handleMessagePartUpdated(toolPartEvent({ status: "completed", start: 1500, end: 1800, output: "ok" }), ctx)
    handleMessageUpdated(assistantMessageEvent({ messageID: "msg_1", created: 1200, completed: 2000 }), ctx)
    expect(llmSpan.attributes["gen_ai.output.messages"]).toContain("streaming")
  })

  it("uses tool start time to initialize same-round LLM start time", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    handleMessagePartUpdated(toolPartEvent({ status: "running", start: 1500 }), ctx)
    const llmSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "LLM")!
    const toolSpan = spyTracer!.spans.find(s => s.attributes[SPAN_KIND_ATTR] === "TOOL")!
    expect(llmSpan.startTime).toBe(1500)
    expect(toolSpan.startTime).toBe(1500)
  })

  it("writes gen_ai.input.messages and carries history to next round", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent(), ctx)
    ctx.pendingUserPrompts.set("sess_1", "fix the bug")
    handleMessagePartUpdated(textPartEvent({ messageID: "msg_1", text: "Let me read", timeStart: 1100 }), ctx)
    handleMessagePartUpdated(toolPartEvent({ messageID: "msg_1", status: "running", callID: "c1", tool: "Read", input: "{\"path\":\"a.ts\"}" }), ctx)
    handleMessagePartUpdated(toolPartEvent({ messageID: "msg_1", status: "completed", callID: "c1", tool: "Read", start: 1500, end: 1800, output: "file contents" }), ctx)
    handleMessageUpdated(assistantMessageEvent({ messageID: "msg_1" }), ctx)
    handleMessagePartUpdated(textPartEvent({ messageID: "msg_2", text: "I fixed it", timeStart: 2500 }), ctx)
    handleMessageUpdated(assistantMessageEvent({ messageID: "msg_2" }), ctx)
    const llmSpans = spyTracer!.spans.filter(s => s.attributes[SPAN_KIND_ATTR] === "LLM")
    const input = JSON.parse(llmSpans[1]!.attributes["gen_ai.input.messages"] as string)
    expect(input).toHaveLength(3)
    expect(input[0].role).toBe("user")
    expect(input[1].role).toBe("assistant")
    expect(input[2].role).toBe("tool")
  })
})

