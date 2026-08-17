import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  STATE_DIR,
  appendEvent,
  clearState,
  loadState,
  newSessionState,
  saveStateAtomic,
  splitIntoTurns,
} from "../../src/state.js";

const SID = "test-session-state";

describe("state", () => {
  beforeEach(() => clearState(SID));
  afterEach(() => clearState(SID));

  it("STATE_DIR resolves under home cache", () => {
    expect(STATE_DIR.startsWith(os.homedir())).toBe(true);
    expect(STATE_DIR.includes("opentelemetry.instrumentation.qodercli")).toBe(
      true,
    );
  });

  it("save + load roundtrips events atomically", () => {
    const s = newSessionState(SID, "/tmp/proj");
    appendEvent(s, {
      type: "user_prompt_submit",
      timestampSec: 1.5,
      prompt: "hi",
    });
    saveStateAtomic(s);

    const loaded = loadState(SID);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(SID);
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0]!.type).toBe("user_prompt_submit");
  });

  it("loadState returns null for unknown session", () => {
    expect(loadState("does-not-exist-xyz")).toBeNull();
  });

  it("splitIntoTurns groups events between user_prompt_submit boundaries", () => {
    const s = newSessionState(SID, "/tmp");
    appendEvent(s, {
      type: "session_start",
      timestampSec: 1,
    });
    appendEvent(s, {
      type: "user_prompt_submit",
      timestampSec: 2,
      prompt: "first",
    });
    appendEvent(s, {
      type: "pre_tool_use",
      timestampSec: 3,
      toolName: "Bash",
      toolUseId: "t1",
      toolInput: { command: "ls" },
    });
    appendEvent(s, {
      type: "user_prompt_submit",
      timestampSec: 4,
      prompt: "second",
    });
    appendEvent(s, { type: "stop", timestampSec: 5 });

    const turns = splitIntoTurns(s);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.userPromptText).toBe("first");
    expect(turns[0]!.events).toHaveLength(2); // user_prompt_submit + pre_tool_use
    expect(turns[1]!.userPromptText).toBe("second");
    expect(turns[1]!.closed).toBe(true);
  });

  it("atomic write does not leave tmp file on success", () => {
    const s = newSessionState(SID, "/tmp");
    saveStateAtomic(s);
    const dir = STATE_DIR;
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
