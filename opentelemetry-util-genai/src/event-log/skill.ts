// Copyright The OpenTelemetry Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  GEN_AI_SKILL_DESCRIPTION,
  GEN_AI_SKILL_ID,
  GEN_AI_SKILL_NAME,
  GEN_AI_SKILL_VERSION,
} from "../semconv/gen-ai-extended-attributes.js";
import type {
  EventLogRecord,
  SkillDetectionConfig,
  SkillDetectionOptions,
  SkillInfo,
} from "./types.js";

export const DEFAULT_SKILL_TOOL_NAMES = [
  "Skill",
  "load_skill",
  "read_skill",
  "skill_view",
  "skill_manage",
] as const;

const PATH_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filepath",
  "path",
  "argv",
  "args",
  "script",
] as const;

const SKILL_PATH_PATTERN =
  /(?:^|[/\\])skills(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?[/\\](?:\.system[/\\])?([^/\\"'\s]+)(?=[/\\]|["'\s]|$)/;

interface NormalizedSkillDetection {
  enabled: boolean;
  toolNames: ReadonlySet<string>;
  pathHeuristic: boolean;
  detect?: SkillDetectionOptions["detect"];
}

const DEFAULT_NORMALIZED: NormalizedSkillDetection = {
  enabled: true,
  toolNames: new Set(DEFAULT_SKILL_TOOL_NAMES.map((name) => name.toLowerCase())),
  pathHeuristic: true,
};

const DISABLED_NORMALIZED: NormalizedSkillDetection = {
  enabled: false,
  toolNames: new Set(),
  pathHeuristic: false,
};

function normalizeConfig(
  config: SkillDetectionConfig | undefined,
): NormalizedSkillDetection {
  if (config === false) return DISABLED_NORMALIZED;
  if (config == null || config === true) return DEFAULT_NORMALIZED;
  return {
    enabled: true,
    toolNames: new Set(
      (config.toolNames ?? DEFAULT_SKILL_TOOL_NAMES)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
    pathHeuristic: config.pathHeuristic ?? true,
    detect: config.detect,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function metadataInfo(
  value: Record<string, unknown> | undefined,
): SkillInfo | undefined {
  if (!value) return undefined;
  const metadata = parseObject(value.metadata);
  const hermes = parseObject(metadata?.hermes);
  const info: SkillInfo = {
    name: nonEmptyString(value.skill) ?? nonEmptyString(value.name),
    id:
      nonEmptyString(value.id) ??
      nonEmptyString(metadata?.id) ??
      nonEmptyString(hermes?.id),
    version:
      nonEmptyString(value.version) ??
      nonEmptyString(metadata?.version) ??
      nonEmptyString(hermes?.version),
    description: nonEmptyString(value.description),
  };
  return hasSkillInfo(info) ? info : undefined;
}

function explicitInfo(record?: EventLogRecord): SkillInfo | undefined {
  if (!record) return undefined;
  const info: SkillInfo = {
    name: nonEmptyString(record[GEN_AI_SKILL_NAME]),
    id: nonEmptyString(record[GEN_AI_SKILL_ID]),
    version: nonEmptyString(record[GEN_AI_SKILL_VERSION]),
    description: nonEmptyString(record[GEN_AI_SKILL_DESCRIPTION]),
  };
  return hasSkillInfo(info) ? info : undefined;
}

function hasSkillInfo(info: SkillInfo): boolean {
  return (
    info.name != null ||
    info.id != null ||
    info.version != null ||
    info.description != null
  );
}

/** Fill only missing fields; values already present in target stay authoritative. */
function fillSkillInfo(target: SkillInfo, source?: SkillInfo): void {
  if (!source) return;
  const name = nonEmptyString(source.name);
  const id = nonEmptyString(source.id);
  const version = nonEmptyString(source.version);
  const description = nonEmptyString(source.description);
  if (target.name == null && name != null) target.name = name;
  if (target.id == null && id != null) target.id = id;
  if (target.version == null && version != null) target.version = version;
  if (target.description == null) {
    if (description != null) target.description = description;
  }
}

function firstClassToolInfo(
  call: EventLogRecord | undefined,
  result: EventLogRecord | undefined,
  toolNames: ReadonlySet<string>,
): SkillInfo | undefined {
  const toolName =
    nonEmptyString(call?.["gen_ai.tool.name"]) ??
    nonEmptyString(result?.["gen_ai.tool.name"]);
  if (!toolName || !toolNames.has(toolName.toLowerCase())) return undefined;

  const args = parseObject(call?.["gen_ai.tool.call.arguments"]);
  const resultValue = parseObject(result?.["gen_ai.tool.call.result"]);
  const successfulResult =
    resultValue?.success === false ? undefined : metadataInfo(resultValue);

  const info: SkillInfo = {};
  // A successful structured result normally has the most accurate metadata.
  fillSkillInfo(info, successfulResult);
  fillSkillInfo(info, metadataInfo(args));
  return hasSkillInfo(info) ? info : undefined;
}

function collectArgumentStrings(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseObject(value) ?? value : value;
  if (typeof parsed === "string") return [parsed];
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => collectArgumentStrings(item));
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const output: string[] = [];
  const visited = new Set<string>();

  // Inspect common path-bearing fields first so multi-path commands remain
  // deterministic and favor the tool's actual target.
  for (const key of PATH_KEYS) {
    if (!(key in record)) continue;
    visited.add(key);
    output.push(...collectArgumentStrings(record[key]));
  }
  for (const [key, child] of Object.entries(record)) {
    if (visited.has(key)) continue;
    output.push(...collectArgumentStrings(child));
  }
  return output;
}

function pathSkillInfo(call?: EventLogRecord): SkillInfo | undefined {
  const args = call?.["gen_ai.tool.call.arguments"];
  for (const text of collectArgumentStrings(args)) {
    const match = text.match(SKILL_PATH_PATTERN);
    const name = nonEmptyString(match?.[1]);
    if (name) return { name };
  }
  return undefined;
}

/**
 * Resolve Skill metadata for one paired tool.call/tool.result.
 *
 * Precedence is field-by-field:
 *   explicit result > explicit call > custom detector > first-class tool
 *   detector > argument-path heuristic > id fallback to name.
 *
 * Explicit event fields are preserved even when automatic detection is
 * disabled. Path detection intentionally scans call arguments only, never
 * arbitrary result/stdout content.
 */
export function resolveSkill(
  call?: EventLogRecord,
  result?: EventLogRecord,
  config?: SkillDetectionConfig,
): SkillInfo | undefined {
  const info: SkillInfo = {};
  fillSkillInfo(info, explicitInfo(result));
  fillSkillInfo(info, explicitInfo(call));

  const normalized = normalizeConfig(config);
  if (normalized.enabled) {
    fillSkillInfo(info, normalized.detect?.(call, result));
    fillSkillInfo(
      info,
      firstClassToolInfo(call, result, normalized.toolNames),
    );
    if (normalized.pathHeuristic && info.name == null) {
      fillSkillInfo(info, pathSkillInfo(call));
    }
  }

  if (info.id == null && info.name != null) info.id = info.name;
  return hasSkillInfo(info) ? info : undefined;
}
