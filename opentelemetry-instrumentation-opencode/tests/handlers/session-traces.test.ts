import { describe, it, expect } from "bun:test"
import { makeCtx } from "../helpers.ts"
import { handleSessionCreated, handleSessionIdle, handleSessionError } from "../../src/handlers/session.ts"
import { SpanStatusCode } from "@opentelemetry/api"
import type { EventSessionCreated, EventSessionIdle, EventSessionError } from "@opencode-ai/sdk"

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

function sessionIdleEvent(id = "sess_1"): EventSessionIdle {
  return {
    type: "session.idle",
    properties: { sessionID: id },
  } as EventSessionIdle
}

function sessionErrorEvent(id = "sess_1"): EventSessionError {
  return {
    type: "session.error",
    properties: {
      sessionID: id,
      error: { name: "UnknownError", data: { message: "something went wrong" } },
    },
  } as unknown as EventSessionError
}

describe("session traces", () => {
  it("does not create request spans on session.created", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent("sess_1", 1000), ctx)

    expect(spyTracer!.spans).toHaveLength(0)
    expect(ctx.activeInvocations.size).toBe(0)
  })

  it("sweeps invocation spans with OK on session.idle", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    const entry = spyTracer!.startSpan("enter")
    const agent = spyTracer!.startSpan("invoke_agent opencode-agent")
    ctx.activeInvocations.set("sess_1", {
      invocationID: "sess_1:1",
      sessionID: "sess_1",
      requestSeq: 1,
      entrySpan: entry as any,
      entryContext: entry.spanContext(),
      agentSpan: agent as any,
      agentContext: agent.spanContext(),
      nextStepRound: 1,
    })
    handleSessionIdle(sessionIdleEvent("sess_1"), ctx)

    expect(entry.ended).toBe(true)
    expect(agent.ended).toBe(true)
    expect(entry.status.code).toBe(SpanStatusCode.OK)
    expect(agent.status.code).toBe(SpanStatusCode.OK)
    expect(ctx.activeInvocations.size).toBe(0)
  })

  it("ends invocation spans with ERROR on session.error", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    const entry = spyTracer!.startSpan("enter")
    const agent = spyTracer!.startSpan("invoke_agent opencode-agent")
    ctx.activeInvocations.set("sess_1", {
      invocationID: "sess_1:1",
      sessionID: "sess_1",
      requestSeq: 1,
      entrySpan: entry as any,
      entryContext: entry.spanContext(),
      agentSpan: agent as any,
      agentContext: agent.spanContext(),
      nextStepRound: 1,
    })
    handleSessionError(sessionErrorEvent("sess_1"), ctx)

    expect(agent.ended).toBe(true)
    expect(entry.ended).toBe(true)
    expect(agent.status.code).toBe(SpanStatusCode.ERROR)
    expect(entry.status.code).toBe(SpanStatusCode.ERROR)
    // sweepSession now adds session.error event to both spans (moved from handleSessionError)
    expect(agent.events.length).toBe(1)
    expect(agent.events[0]!.name).toBe("session.error")
    expect(entry.events.length).toBe(1)
    expect(entry.events[0]!.name).toBe("session.error")
    expect(ctx.activeInvocations.size).toBe(0)
  })

  it("does not create invocation state when traces disabled", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [])
    handleSessionCreated(sessionCreatedEvent("sess_1", 1000), ctx)

    expect(spyTracer).toBeNull()
    expect(ctx.activeInvocations.size).toBe(0)
  })

  it("sweeps active tool and message spans on session.idle", () => {
    const { ctx, spyTracer } = makeCtx("proj_test", [], { tracesEnabled: true })
    handleSessionCreated(sessionCreatedEvent("sess_1", 1000), ctx)

    // simulate an orphaned tool span
    const toolSpan = spyTracer!.startSpan("execute_tool bash")
    const llmSpan = spyTracer!.startSpan("chat model")
    const stepSpan = spyTracer!.startSpan("react step")
    ctx.activeToolSpans.set("sess_1:call_1", { span: toolSpan as any, tool: "test", sessionID: "sess_1", startMs: 1000 })
    ctx.activeMessageSpans.set("sess_1:msg_1", {
      span: llmSpan as any,
      context: llmSpan.spanContext(),
      stepSpan: stepSpan as any,
      stepContext: stepSpan.spanContext(),
      stepRound: 1,
      invocationID: "sess_1:1",
      sessionID: "sess_1",
      messageID: "msg_1",
      textParts: new Map(),
      toolCalls: [],
      toolResults: [],
    })

    handleSessionIdle(sessionIdleEvent("sess_1"), ctx)

    expect(ctx.activeToolSpans.size).toBe(0)
    expect(ctx.activeMessageSpans.size).toBe(0)
  })
})
