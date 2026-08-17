// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * hooks.js — Tool formatting helpers for OpenTelemetry events.
 */

const MAX_CONTENT_LENGTH = 1 * 1024 * 1024; // 1 MB

function truncateForDisplay(text, maxLength = MAX_CONTENT_LENGTH) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function smartTruncateValue(value, maxLength = MAX_CONTENT_LENGTH) {
  if (typeof value === "string") {
    return value.length <= maxLength ? value : value.slice(0, maxLength) + "...";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) {
      const items = value.map((v) => smartTruncateValue(v, Math.floor(maxLength / 3)));
      const joined = items.join(", ");
      if (joined.length <= maxLength) return `[${joined}]`;
    }
    const first = value.slice(0, 2).map((v) => smartTruncateValue(v, Math.floor(maxLength / 4)));
    return `[${first.join(", ")}, ... (${value.length} items)]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const parts = [];
    for (let i = 0; i < Math.min(2, keys.length); i++) {
      const k = keys[i];
      parts.push(`${k}: ${smartTruncateValue(value[k], Math.floor(maxLength / 3))}`);
    }
    if (keys.length > 2) parts.push(`... (${keys.length} keys)`);
    return "{" + parts.join(", ") + "}";
  }
  return String(value);
}

function createToolTitle(toolName, toolInput = null, maxLength = MAX_CONTENT_LENGTH) {
  if (!toolInput || Object.keys(toolInput).length === 0) return toolName;

  const summaryParts = [];
  for (const [key, value] of Object.entries(toolInput)) {
    if (summaryParts.length >= 3) break;
    if (typeof value === "string") {
      if (value.length < maxLength) {
        if (value.includes("/") || value.startsWith("-") || value.includes(" ")) {
          summaryParts.push(`"${value}"`);
        } else {
          summaryParts.push(`${key}=${value}`);
        }
      } else {
        summaryParts.push(`${key}="${value.slice(0, maxLength)}..."`);
      }
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      summaryParts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      summaryParts.push(`${key}=[...${value.length}]`);
    } else if (typeof value === "object") {
      summaryParts.push(`${key}={...${Object.keys(value).length}}`);
    }
  }

  if (summaryParts.length === 0) return toolName;
  const title = `${toolName} - ${summaryParts.join(", ")}`;
  return title.length > maxLength ? title.slice(0, maxLength - 3) + "..." : title;
}

function createEventData(toolName, toolInput = null) {
  const eventData = { "gen_ai.tool.name": toolName };
  if (!toolInput || Object.keys(toolInput).length === 0) return eventData;

  try {
    let serialized = JSON.stringify(toolInput);
    if (serialized.length > MAX_CONTENT_LENGTH) serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
    eventData["gen_ai.tool.call.arguments"] = serialized;
  } catch {
    eventData["gen_ai.tool.call.arguments"] = String(toolInput);
  }

  for (const [key, value] of Object.entries(toolInput)) {
    const strVal = String(value);
    if (strVal.length < MAX_CONTENT_LENGTH) {
      eventData[`input.${key}`] = strVal;
    } else {
      eventData[`input.${key}`] =
        strVal.slice(0, MAX_CONTENT_LENGTH) +
        `... (truncated, full size: ${strVal.length} chars)`;
    }
  }

  return eventData;
}

function addResponseToEventData(eventData, toolResponse) {
  if (toolResponse === null || toolResponse === undefined) {
    eventData["status"] = "success";
    eventData["gen_ai.tool.call.result"] = "null";
    return;
  }

  if (toolResponse !== null && typeof toolResponse === "object") {
    const hasError = !Array.isArray(toolResponse) && (
      (toolResponse["error"] !== undefined && toolResponse["error"]) ||
      (toolResponse["isError"] !== undefined && toolResponse["isError"])
    );
    eventData["status"] = hasError ? "error" : "success";
  } else {
    eventData["status"] = "success";
  }

  try {
    let serialized = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
    if (serialized.length > MAX_CONTENT_LENGTH) serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
    eventData["gen_ai.tool.call.result"] = serialized;
  } catch {
    eventData["gen_ai.tool.call.result"] = String(toolResponse);
  }
}

module.exports = {
  createToolTitle,
  createEventData,
  addResponseToEventData,
  truncateForDisplay,
  smartTruncateValue,
  MAX_CONTENT_LENGTH,
};
