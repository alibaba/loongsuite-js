// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// ─── Constitution C3: enable content capture by default ───────────────────────
// Must run BEFORE any util-genai code reads these env vars.
process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] ??= "gen_ai_latest_experimental";
process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] ??= "SPAN_ONLY";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";

import { configureTelemetry, shutdownTelemetry } from "./telemetry.js";
import {
  HOOK_EVENT_NAMES,
  createEventData,
  readStdinJson,
} from "./hooks.js";
import {
  appendEvent,
  clearState,
  loadState,
  newSessionState,
  saveStateAtomic,
  splitIntoTurns,
  type SessionState,
} from "./state.js";
import {
  getSubagentTranscriptPath,
  getTranscriptPath,
  parseTranscript,
} from "./transcript.js";
import { replayTurn, attachOutOfBandEventsToSpan } from "./replay.js";

const PROGRAM_NAME = "otel-qodercli-hook";
const PLUGIN_VERSION = "0.1.0";

/* ─── Stdin → SessionState helpers ───────────────────────────────────── */

function getSessionId(raw: Record<string, unknown>): string {
  const v = raw["session_id"];
  return typeof v === "string" && v.length > 0 ? v : "unknown-session";
}

function getCwd(raw: Record<string, unknown>): string {
  const v = raw["cwd"];
  return typeof v === "string" && v.length > 0 ? v : process.cwd();
}

function loadOrCreateState(
  sessionId: string,
  cwd: string,
): SessionState {
  return loadState(sessionId) ?? newSessionState(sessionId, cwd);
}

function appendStdinEvent(eventName: string): void {
  try {
    const raw = readStdinJson();
    const sessionId = getSessionId(raw);
    const cwd = getCwd(raw);
    const ev = createEventData(eventName, raw);
    if (!ev) {
      stderr(`[${PROGRAM_NAME}] unknown event: ${eventName}`);
      return;
    }
    const state = loadOrCreateState(sessionId, cwd);
    appendEvent(state, ev);
    saveStateAtomic(state);
  } catch (err) {
    stderr(`[${PROGRAM_NAME}] ${eventName} failed: ${(err as Error).message}`);
  }
}

function stderr(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* ignore */
  }
}

/* ─── Main replay (Stop hook) ────────────────────────────────────────── */

async function cmdStop(): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    raw = readStdinJson();
  } catch {
    raw = {};
  }
  const sessionId = getSessionId(raw);
  const cwd = getCwd(raw);
  const state = loadOrCreateState(sessionId, cwd);
  const stopEvent = createEventData("Stop", raw);
  if (stopEvent) appendEvent(state, stopEvent);
  saveStateAtomic(state);

  try {
    await replaySessionState(state);
  } catch (err) {
    stderr(`[${PROGRAM_NAME}] stop replay failed: ${(err as Error).message}`);
  }
}

async function cmdSessionEnd(): Promise<void> {
  // SessionEnd may arrive after Stop, or instead of it. Replay any unexported turns.
  let raw: Record<string, unknown>;
  try {
    raw = readStdinJson();
  } catch {
    raw = {};
  }
  const sessionId = getSessionId(raw);
  const cwd = getCwd(raw);
  const state = loadOrCreateState(sessionId, cwd);
  const endEvent = createEventData("SessionEnd", raw);
  if (endEvent) appendEvent(state, endEvent);
  saveStateAtomic(state);

  try {
    await replaySessionState(state);
  } catch (err) {
    stderr(
      `[${PROGRAM_NAME}] session-end replay failed: ${(err as Error).message}`,
    );
  }
}

async function replaySessionState(state: SessionState): Promise<void> {
  const turns = splitIntoTurns(state);
  if (turns.length === 0) return;

  const transcriptPath = getTranscriptPath(state.sessionId, state.cwd);
  const transcript = parseTranscript(transcriptPath);

  const { tracer, provider } = configureTelemetry();

  const subagentReplays = collectSubagentReplays(state, tracer);

  let exportedAny = false;
  for (let i = 0; i < turns.length; i++) {
    if (state.exportedTurnIndices.includes(i)) continue;
    const turn = turns[i]!;
    if (!turn.closed) continue; // wait for next stop / session-end

    replayTurn({
      turn,
      transcript,
      tracer,
      sessionId: state.sessionId,
      turnIndex: i,
      subagentReplays:
        i === turns.length - 1
          ? subagentReplays.replayArgs.slice()
          : undefined,
    });
    state.exportedTurnIndices.push(i);
    exportedAny = true;
  }

  if (exportedAny) {
    saveStateAtomic(state);
  }

  await provider.forceFlush().catch(() => {});
  await shutdownTelemetry();
}

interface SubagentBundle {
  replayArgs: ReplayArgsLite[];
}

type ReplayArgsLite = Parameters<typeof replayTurn>[0];

function collectSubagentReplays(
  state: SessionState,
  tracer: ReturnType<typeof configureTelemetry>["tracer"],
): SubagentBundle {
  // Pair each subagent_start with its subagent_stop (by agent_id) and read the child transcript.
  const startedAt = new Map<string, number>();
  const stoppedAt = new Map<string, number>();
  for (const ev of state.events) {
    if (ev.type === "subagent_start") {
      startedAt.set(ev.agentId, ev.timestampSec);
    } else if (ev.type === "subagent_stop") {
      stoppedAt.set(ev.agentId, ev.timestampSec);
    }
  }

  const replayArgs: ReplayArgsLite[] = [];
  for (const [agentId, startSec] of startedAt) {
    const stopSec = stoppedAt.get(agentId);
    const transcriptPath = getSubagentTranscriptPath(
      state.sessionId,
      state.cwd,
      agentId,
    );
    if (!fs.existsSync(transcriptPath)) continue;
    const transcript = parseTranscript(transcriptPath);
    if (transcript.tokenEvents.length === 0) continue;

    // Synthesize a single-turn wrapper for the subagent.
    const fakeTurn = {
      startIdx: 0,
      userPromptIdx: 0,
      promptId: agentId,
      userPromptText: `subagent ${agentId}`,
      events: [],
      startedAt: startSec,
      endedAt: stopSec ?? null,
      closed: stopSec !== undefined,
    };
    replayArgs.push({
      turn: fakeTurn,
      transcript,
      tracer,
      sessionId: `${state.sessionId}::${agentId}`,
      turnIndex: 0,
    });
  }
  return { replayArgs };
}

/* ─── Hook event subcommand registration (T03 + T14-T19) ─────────────── */

const program = new Command()
  .name(PROGRAM_NAME)
  .description("OpenTelemetry instrumentation hooks for Qoder CLI")
  .version(PLUGIN_VERSION);

program
  .command("session-start")
  .description("hook: SessionStart")
  .action(() => appendStdinEvent("SessionStart"));

program
  .command("user-prompt-submit")
  .description("hook: UserPromptSubmit")
  .action(() => appendStdinEvent("UserPromptSubmit"));

program
  .command("pre-tool-use")
  .description("hook: PreToolUse")
  .action(() => appendStdinEvent("PreToolUse"));

program
  .command("post-tool-use")
  .description("hook: PostToolUse")
  .action(() => appendStdinEvent("PostToolUse"));

program
  .command("post-tool-use-failure")
  .description("hook: PostToolUseFailure")
  .action(() => appendStdinEvent("PostToolUseFailure"));

program
  .command("stop")
  .description("hook: Stop — replays this session's turns and exports trace")
  .action(async () => {
    await cmdStop();
  });

program
  .command("subagent-start")
  .description("hook: SubagentStart")
  .action(() => appendStdinEvent("SubagentStart"));

program
  .command("subagent-stop")
  .description("hook: SubagentStop")
  .action(() => appendStdinEvent("SubagentStop"));

program
  .command("pre-compact")
  .description("hook: PreCompact")
  .action(() => appendStdinEvent("PreCompact"));

program
  .command("notification")
  .description("hook: Notification")
  .action(() => appendStdinEvent("Notification"));

program
  .command("session-end")
  .description("hook: SessionEnd — flushes any remaining turns")
  .action(async () => {
    await cmdSessionEnd();
  });

/* ─── Install / Uninstall (T22-T23) ──────────────────────────────────── */

interface SettingsJson {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>
  >;
  [k: string]: unknown;
}

function settingsPath(opts: { user?: boolean; project?: boolean }): string {
  if (opts.project) {
    return path.join(process.cwd(), ".qoder", "settings.json");
  }
  return path.join(os.homedir(), ".qoder", "settings.json");
}

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    const t = fs.readFileSync(p, "utf-8");
    if (!t.trim()) return fallback;
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}

function getHookCommandName(): string {
  return process.env["OTEL_QODERCLI_HOOK_CMD"] || PROGRAM_NAME;
}

function buildHookConfig(): NonNullable<SettingsJson["hooks"]> {
  const cmd = getHookCommandName();
  const out: NonNullable<SettingsJson["hooks"]> = {};
  for (const { event, subcommand } of HOOK_EVENT_NAMES) {
    out[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${cmd} ${subcommand}`,
            timeout: 30,
          },
        ],
      },
    ];
  }
  return out;
}

/** Strip our previously-registered hook entries from a hooks block (idempotent). */
function stripOurHooks(
  hooks: NonNullable<SettingsJson["hooks"]>,
): NonNullable<SettingsJson["hooks"]> {
  const cmd = getHookCommandName();
  const cmdEsc = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subEsc = HOOK_EVENT_NAMES.map((h) =>
    h.subcommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|");
  const ourCmdRegex = new RegExp(`^${cmdEsc}\\s+(${subEsc})\\s*$`);

  const cleaned: NonNullable<SettingsJson["hooks"]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const remaining = (groups ?? [])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter(
          (h) => !ourCmdRegex.test((h.command ?? "").trim()),
        ),
      }))
      .filter((g) => (g.hooks ?? []).length > 0);
    if (remaining.length > 0) cleaned[event] = remaining;
  }
  return cleaned;
}

interface InstallOpts {
  user?: boolean;
  project?: boolean;
  quiet?: boolean;
}

function cmdInstall(opts: InstallOpts): void {
  const target = settingsPath({ user: opts.user, project: opts.project });
  const settings = readJsonSafe<SettingsJson>(target, {});

  const existingHooks = settings.hooks ?? {};
  // Strip stale entries (Constitution C5 — must not early-return on re-install).
  const cleaned = stripOurHooks(existingHooks);

  // Merge our config in. We replace the whole array per event since we own it.
  const ours = buildHookConfig();
  const merged: NonNullable<SettingsJson["hooks"]> = { ...cleaned };
  for (const [event, groups] of Object.entries(ours)) {
    const existing = merged[event] ?? [];
    merged[event] = [...existing, ...groups];
  }

  settings.hooks = merged;
  writeJsonAtomic(target, settings);

  if (!opts.quiet) {
    process.stdout.write(
      `[${PROGRAM_NAME}] installed ${HOOK_EVENT_NAMES.length} hooks → ${target}\n`,
    );
  }
}

interface UninstallOpts {
  user?: boolean;
  project?: boolean;
  purge?: boolean;
  quiet?: boolean;
}

function cmdUninstall(opts: UninstallOpts): void {
  const target = settingsPath({ user: opts.user, project: opts.project });
  const settings = readJsonSafe<SettingsJson>(target, {});
  const existingHooks = settings.hooks ?? {};
  const cleaned = stripOurHooks(existingHooks);
  if (Object.keys(cleaned).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = cleaned;
  }
  writeJsonAtomic(target, settings);

  if (opts.purge) {
    const sessionsDir = path.join(
      os.homedir(),
      ".cache",
      "opentelemetry.instrumentation.qodercli",
      "sessions",
    );
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (!opts.quiet) {
    process.stdout.write(
      `[${PROGRAM_NAME}] uninstalled hooks from ${target}\n`,
    );
  }
}

program
  .command("install")
  .description("Install hooks into ~/.qoder/settings.json")
  .option("--user", "user-level (default)", true)
  .option("--project", "project-level (./.qoder/settings.json)")
  .option("--quiet", "suppress non-error stdout")
  .action((opts: InstallOpts) => {
    if (opts.project) opts.user = false;
    cmdInstall(opts);
  });

program
  .command("uninstall")
  .description("Remove hooks from settings.json")
  .option("--user", "user-level (default)", true)
  .option("--project", "project-level")
  .option("--purge", "also delete session cache directory")
  .option("--quiet", "suppress non-error stdout")
  .action((opts: UninstallOpts) => {
    if (opts.project) opts.user = false;
    cmdUninstall(opts);
  });

program
  .command("show-config")
  .description("Print the hook config JSON snippet")
  .action(() => {
    const cfg = { hooks: buildHookConfig() };
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  });

program
  .command("check-env")
  .description("Print effective telemetry environment")
  .action(() => {
    const lines = [
      `OTEL_EXPORTER_OTLP_ENDPOINT=${process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? ""}`,
      `OTEL_EXPORTER_OTLP_HEADERS=${
        process.env["OTEL_EXPORTER_OTLP_HEADERS"] ? "(set)" : ""
      }`,
      `OTEL_SERVICE_NAME=${process.env["OTEL_SERVICE_NAME"] ?? "(default qodercli-agent)"}`,
      `QODERCLI_TELEMETRY_DEBUG=${process.env["QODERCLI_TELEMETRY_DEBUG"] ?? ""}`,
      `OTEL_SEMCONV_STABILITY_OPT_IN=${process.env["OTEL_SEMCONV_STABILITY_OPT_IN"]}`,
      `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=${
        process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"]
      }`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  stderr(`[${PROGRAM_NAME}] fatal: ${(err as Error).message}`);
  // Always exit 0 — hooks must not break qodercli.
  process.exit(0);
});
