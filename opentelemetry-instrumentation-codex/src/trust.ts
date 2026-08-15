import * as crypto from "node:crypto";
import * as fs from "node:fs";

const EVENT_KEY_MAP: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Stop: "stop",
};

// Recursive key-sorted JSON — replicates canonical_json() from
// codex-rs/config/src/fingerprint.rs
function canonicalJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Replicates version_for_toml() from codex-rs/config/src/fingerprint.rs
function versionForToml(obj: unknown): string {
  const canonical = canonicalJson(obj);
  const serialized = JSON.stringify(canonical);
  const hex = crypto
    .createHash("sha256")
    .update(serialized, "utf-8")
    .digest("hex");
  return `sha256:${hex}`;
}

// Replicates command_hook_hash() from codex-rs/hooks/src/engine/discovery.rs
// NormalizedHookIdentity { event_name, #[flatten] group: MatcherGroup }
// MatcherGroup { matcher: Option<String>, hooks: Vec<HookHandlerConfig> }
// When matcher is None, TOML serialization omits the field entirely.
export function computeHookTrustHash(
  eventName: string,
  command: string,
): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);

  const identity: Record<string, unknown> = {
    event_name: eventKey,
    // matcher: None → absent (TOML has no null, serde skips None)
    hooks: [
      {
        type: "command",
        command,
        timeout: 600,
        async: false,
        // status_message: None → absent
      },
    ],
  };

  return versionForToml(identity);
}

export function hookStateKey(
  hooksJsonAbsPath: string,
  eventName: string,
): string {
  const eventKey = EVENT_KEY_MAP[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
  return `${hooksJsonAbsPath}:${eventKey}:0:0`;
}

const TRUST_BEGIN = "# BEGIN otel-codex-hook trust";
const TRUST_END = "# END otel-codex-hook trust";

// Remove "naked" [hooks.state."<hooksJsonAbsPath>:<event>:0:0"] sections that
// were left by older versions of this plugin (which did not wrap their trust
// state in BEGIN/END markers). Without this, the new BEGIN/END block would
// contain table headers that duplicate the leftover ones, and codex would
// fail to load config.toml with "duplicate key".
//
// Ownership rationale: the hooks.json is owned by this plugin, so any
// [hooks.state] entry whose key prefix is `<our hooks.json>:<one of our
// events>:0:0` must have been written by us at some point. We do not touch
// rows with a different group/handler index (e.g. `:1:0`) — those belong to
// other hooks the user may have appended to the same hooks.json.
function removeStaleTrustState(
  content: string,
  hooksJsonAbsPath: string,
  hookEvents: readonly string[],
): string {
  const ownedEventKeys = new Set(
    hookEvents.map((event) => {
      const eventKey = EVENT_KEY_MAP[event];
      if (!eventKey) throw new Error(`Unknown hook event: ${event}`);
      return eventKey;
    }),
  );

  const lines = content.split("\n");
  const out: string[] = [];
  let skipping = false;

  // Match `[hooks.state."<key>"]` and capture <key>.
  const sectionHeader = /^\s*\[hooks\.state\."([^"]+)"\]\s*$/;
  // Match any other top-level / sub-table header.
  const anyHeader = /^\s*\[/;

  const isOwnedKey = (key: string): boolean => {
    // key format: "<path>:<event>:<group>:<handler>"
    const lastColon = key.lastIndexOf(":");
    if (lastColon === -1) return false;
    const handlerPart = key.slice(lastColon + 1);
    const rest = key.slice(0, lastColon);
    const groupColon = rest.lastIndexOf(":");
    if (groupColon === -1) return false;
    const groupPart = rest.slice(groupColon + 1);
    const eventStart = rest.slice(0, groupColon);
    const eventColon = eventStart.lastIndexOf(":");
    if (eventColon === -1) return false;
    const eventKey = eventStart.slice(eventColon + 1);
    const pathPart = eventStart.slice(0, eventColon);

    return (
      pathPart === hooksJsonAbsPath &&
      ownedEventKeys.has(eventKey) &&
      groupPart === "0" &&
      handlerPart === "0"
    );
  };

  for (const line of lines) {
    const headerMatch = line.match(sectionHeader);
    if (headerMatch) {
      skipping = isOwnedKey(headerMatch[1]!);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (anyHeader.test(line)) {
      // Any other table header ends the skip region.
      skipping = false;
      out.push(line);
      continue;
    }
    if (skipping) {
      // Inside an owned [hooks.state.xxx] section: drop key/value and blank
      // lines. Comments are also dropped — they were section-local.
      continue;
    }
    out.push(line);
  }

  let result = out.join("\n");
  // Collapse the holes left by removed sections.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}

export function writeTrustedHashes(
  configPath: string,
  hooksJsonAbsPath: string,
  entryPath: string,
  hookEvents: readonly string[],
  eventToSubcommand: Record<string, string>,
): void {
  let content = "";
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, "utf-8");
  }

  // Step 1: remove existing BEGIN/END trust block (idempotent re-install).
  const beginIdx = content.indexOf(TRUST_BEGIN);
  const endIdx = content.indexOf(TRUST_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    let cutEnd = endIdx + TRUST_END.length;
    while (cutEnd < content.length && content[cutEnd] === "\n") cutEnd++;
    content = content.slice(0, beginIdx) + content.slice(cutEnd);
  }

  // Step 2: remove naked stale trust state left by older plugin versions.
  content = removeStaleTrustState(content, hooksJsonAbsPath, hookEvents);

  // Step 3: write the new BEGIN/END trust block.
  const lines: string[] = [TRUST_BEGIN];
  for (const event of hookEvents) {
    const sub = eventToSubcommand[event]!;
    const command = `bash ${entryPath} ${sub}`;
    const hash = computeHookTrustHash(event, command);
    const key = hookStateKey(hooksJsonAbsPath, event);
    lines.push(`[hooks.state."${key}"]`);
    lines.push(`trusted_hash = "${hash}"`);
    lines.push("");
  }
  lines.push(TRUST_END);

  const separator = content.endsWith("\n") || !content ? "" : "\n";
  content += separator + "\n" + lines.join("\n") + "\n";
  content = content.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, content, "utf-8");
}

export function removeTrustBlock(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  let content = fs.readFileSync(configPath, "utf-8");
  const beginIdx = content.indexOf(TRUST_BEGIN);
  const endIdx = content.indexOf(TRUST_END);
  if (beginIdx === -1 || endIdx === -1) return false;

  let cutEnd = endIdx + TRUST_END.length;
  while (cutEnd < content.length && content[cutEnd] === "\n") cutEnd++;
  content = content.slice(0, beginIdx) + content.slice(cutEnd);
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.writeFileSync(configPath, content, "utf-8");
  return true;
}
