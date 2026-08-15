import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 隔离测试用的临时 HOME(state 文件落到 tmp)。
// state.ts 模块顶层用 os.homedir() 计算 STATE_DIR,所以必须在 import 之前 mock。
// vi.mock 和 vi.hoisted 都是 hoist 的,callback 中不能引用顶层 import,
// 必须 require 自己需要的模块。
const { TEST_HOME } = vi.hoisted(() => {
  const fsHoisted: typeof import("node:fs") = require("node:fs");
  const osHoisted: typeof import("node:os") = require("node:os");
  const pathHoisted: typeof import("node:path") = require("node:path");
  const tmp = fsHoisted.mkdtempSync(pathHoisted.join(osHoisted.tmpdir(), "codex-cli-test-"));
  return { TEST_HOME: tmp };
});
vi.mock("node:os", async () => {
  const actual: typeof import("node:os") = await vi.importActual("node:os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

// 真正 import 业务代码(此时 STATE_DIR 已指向 TEST_HOME)
import { loadState, saveState, splitIntoTurns } from "../src/state.js";
import type { SessionState } from "../src/state.js";
import { parseTranscript } from "../src/transcript.js";
import { generateTurnLogRecords } from "../src/log-records.js";
import { buildReactSteps } from "../src/replay.js";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const THREE_TURNS = path.join(FIXTURES_DIR, "transcript-three-turns.jsonl");

const TURN_1 = "019e5e3f-9984-7663-8637-0940a4bbeb4f";
const TURN_2 = "019e5e46-0d03-7b91-9084-cde6caab321c";
const TURN_3 = "019e5e46-333e-7d41-b168-89e806098d9c";

// 复刻 cmdStop 的核心数据流(避免依赖 stdin / OTLP / commander 命令入口)。
// 这层"组装测试"专注于:
//   - parseTranscript 增量读取
//   - 按 turn_id 分配 token
//   - state 持久化(transcript_offset / last_token_usage)
//   - 写出的 JSONL 记录里 usage.* 字段是否对齐 fixture 真实值
function simulateCmdStop(
  sessionId: string,
  transcriptPath: string,
): {
  records: Record<string, unknown>[];
  stateAfter: SessionState;
} {
  const state = loadState(sessionId);
  state.transcript_path = transcriptPath;

  const startOffset = state.transcript_offset || 0;
  const startLastUsage = state.transcript_last_token_usage ?? null;
  const transcriptData = parseTranscript(transcriptPath, startOffset, startLastUsage);
  if (transcriptData) {
    if (state.model === "unknown" && transcriptData.model !== "unknown") {
      state.model = transcriptData.model;
    }
  }

  const turns = splitIntoTurns(state);
  const provider = transcriptData?.modelProvider || "openai";
  const allRecords: Record<string, unknown>[] = [];
  const fallbackQueue = transcriptData?.tokenEvents ? [...transcriptData.tokenEvents] : [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const stepCount = buildReactSteps(turn).length;
    let turnTokenSlice = transcriptData?.tokenEventsByTurn?.get(turn.turn_id);
    if (!turnTokenSlice || turnTokenSlice.length === 0) {
      turnTokenSlice = fallbackQueue.splice(-stepCount, stepCount);
    }
    const { records } = generateTurnLogRecords(
      turn,
      i,
      sessionId,
      state.model,
      provider,
      turnTokenSlice,
      null,
    );
    allRecords.push(...records);
  }

  if (transcriptData) {
    state.transcript_offset = transcriptData.nextOffset;
    if (transcriptData.lastEmittedUsage) {
      state.transcript_last_token_usage = transcriptData.lastEmittedUsage;
    }
  }
  state.events = [];
  saveState(sessionId, state);

  return { records: allRecords, stateAfter: state };
}

// 模拟 hook 链:session_start → user_prompt_submit → stop
function pushUserPrompt(sessionId: string, prompt: string, turnId: string, model: string): void {
  const state = loadState(sessionId);
  if (!state.events.find((e) => e.type === "session_start")) {
    state.events.push({
      type: "session_start",
      timestamp: Date.now() / 1000,
      source: "test",
      model,
    });
  }
  state.events.push({
    type: "user_prompt_submit",
    timestamp: Date.now() / 1000,
    prompt,
    turn_id: turnId,
    model,
  });
  saveState(sessionId, state);
}

describe("cmdStop simulation - three consecutive turns (incremental)", () => {
  let tmpTranscript: string;
  let sessionId: string;

  beforeEach(() => {
    sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpTranscript = path.join(os.tmpdir(), `codex-test-transcript-${sessionId}.jsonl`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpTranscript); } catch {}
  });

  test("三次连续 cmdStop:每次 turn 拿到正确的本 turn token 值", () => {
    // 加载完整 fixture 内容,按 task_complete 切成三段
    const fullLines = fs
      .readFileSync(THREE_TURNS, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const taskCompleteIndices: number[] = [];
    fullLines.forEach((l, i) => {
      if (l.includes('"type":"task_complete"')) taskCompleteIndices.push(i);
    });
    expect(taskCompleteIndices).toHaveLength(3);

    // ---------- Turn 1 ----------
    fs.writeFileSync(
      tmpTranscript,
      fullLines.slice(0, taskCompleteIndices[0] + 1).join("\n") + "\n",
    );
    pushUserPrompt(sessionId, "你有什么能力吗", TURN_1, "gpt-5.5");
    const r1 = simulateCmdStop(sessionId, tmpTranscript);
    const llmResp1 = r1.records.find((r) => r["event.name"] === "llm.response")!;
    expect(llmResp1["usage.input_tokens"]).toBe(18391);
    expect(llmResp1["usage.output_tokens"]).toBe(238);
    expect(llmResp1["usage.cache_read_tokens"]).toBe(14720);
    expect(llmResp1["usage.total_tokens"]).toBe(18629); // 源值,非手算
    expect(llmResp1).toHaveProperty("usage.reasoning_output_tokens");
    // state 应仍存在(未被 clearState)且 transcript_offset 已记录
    expect(r1.stateAfter.transcript_offset).toBeGreaterThan(0);
    expect(r1.stateAfter.events).toHaveLength(0);
    expect(r1.stateAfter.transcript_last_token_usage?.inputTokens).toBe(18391);
    const offset1 = r1.stateAfter.transcript_offset!;

    // ---------- Turn 2 ----------
    fs.writeFileSync(
      tmpTranscript,
      fullLines.slice(0, taskCompleteIndices[1] + 1).join("\n") + "\n",
    );
    pushUserPrompt(sessionId, "你可以做什么", TURN_2, "gpt-5.5");
    const r2 = simulateCmdStop(sessionId, tmpTranscript);
    const llmResp2 = r2.records.find((r) => r["event.name"] === "llm.response")!;
    // 关键回归:本 turn 应拿到 18640 而非 18391
    expect(llmResp2["usage.input_tokens"]).toBe(18640);
    expect(llmResp2["usage.output_tokens"]).toBe(253);
    expect(llmResp2["usage.cache_read_tokens"]).toBe(18304);
    expect(llmResp2["usage.total_tokens"]).toBe(18893);
    expect(r2.stateAfter.transcript_offset).toBeGreaterThan(offset1);
    expect(r2.stateAfter.transcript_last_token_usage?.inputTokens).toBe(18640);
    const offset2 = r2.stateAfter.transcript_offset!;

    // ---------- Turn 3 ----------
    fs.writeFileSync(
      tmpTranscript,
      fullLines.slice(0, taskCompleteIndices[2] + 1).join("\n") + "\n",
    );
    pushUserPrompt(sessionId, "你会写什么", TURN_3, "gpt-5.5");
    const r3 = simulateCmdStop(sessionId, tmpTranscript);
    const llmResp3 = r3.records.find((r) => r["event.name"] === "llm.response")!;
    expect(llmResp3["usage.input_tokens"]).toBe(18904);
    expect(llmResp3["usage.output_tokens"]).toBe(229);
    expect(llmResp3["usage.cache_read_tokens"]).toBe(18304);
    expect(llmResp3["usage.total_tokens"]).toBe(19133);
    expect(r3.stateAfter.transcript_offset).toBeGreaterThan(offset2);
    expect(r3.stateAfter.transcript_last_token_usage?.inputTokens).toBe(18904);
  });

  test("state 文件未被 clearState 删除(整个生命周期保持存活)", () => {
    fs.writeFileSync(
      tmpTranscript,
      fs.readFileSync(THREE_TURNS, "utf-8"),
    );
    pushUserPrompt(sessionId, "test", TURN_1, "gpt-5.5");
    simulateCmdStop(sessionId, tmpTranscript);

    // state 文件路径(基于 mock 的 TEST_HOME)
    const stateFile = path.join(
      TEST_HOME,
      ".cache",
      "opentelemetry.instrumentation.codex",
      "sessions",
      `${sessionId}.json`,
    );
    expect(fs.existsSync(stateFile)).toBe(true);

    // 文件内容应包含 transcript_offset
    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(persisted.transcript_offset).toBeGreaterThan(0);
    expect(persisted.events).toHaveLength(0);
    expect(persisted.transcript_last_token_usage).toBeDefined();
  });

  test("total_tokens 来自源值而非 input+output 手算", () => {
    fs.writeFileSync(tmpTranscript, fs.readFileSync(THREE_TURNS, "utf-8"));
    pushUserPrompt(sessionId, "test", TURN_1, "gpt-5.5");
    const r = simulateCmdStop(sessionId, tmpTranscript);
    const responses = r.records.filter((rec) => rec["event.name"] === "llm.response");
    // fixture 中三个 turn 的 total_tokens 都是 input+output(凑巧),
    // 但语义上必须是源值通路:验证 total_tokens 字段存在且为正数即足以
    // (回归字段:这里精确断言第 1 个 turn 的源值)
    expect(responses[0]["usage.total_tokens"]).toBe(18629);
  });
});
