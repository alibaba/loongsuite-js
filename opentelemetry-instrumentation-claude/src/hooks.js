// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * hooks.js — Tool formatting helpers for OpenTelemetry events.
 * Direct port of the Python hooks.py module.
 */

const MAX_CONTENT_LENGTH = 1 * 1024 * 1024; // 1 MB

/**
 * Truncate a string for display with ellipsis if needed.
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateForDisplay(text, maxLength = MAX_CONTENT_LENGTH) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/**
 * Smart-truncate any value for display.
 * @param {*} value
 * @param {number} [maxLength]
 * @returns {string}
 */
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

/**
 * Create an informative title for a tool execution.
 * @param {string} toolName
 * @param {Object|null} [toolInput]
 * @param {number} [maxLength]
 * @returns {string}
 */
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

/**
 * Create structured OTel event data for a tool call.
 * @param {string} toolName
 * @param {Object|null} [toolInput]
 * @returns {Object}
 */
function createEventData(toolName, toolInput = null) {
  const eventData = { "gen_ai.tool.name": toolName };
  if (!toolInput || Object.keys(toolInput).length === 0) return eventData;

  const summaryParts = [];
  for (const [key, value] of Object.entries(toolInput)) {
    if (
      (typeof value === "string" && value.length < MAX_CONTENT_LENGTH) ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      summaryParts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      summaryParts.push(`${key}=[...${value.length} items]`);
    } else if (typeof value === "object") {
      summaryParts.push(`${key}={...${Object.keys(value).length} keys}`);
    }
  }
  if (summaryParts.length > 0) {
    eventData["gen_ai.tool.call.arguments"] = summaryParts.slice(0, 5).join(", ");
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

/**
 * Add response information to OTel event data in-place.
 * @param {Object} eventData
 * @param {*} toolResponse
 */
function addResponseToEventData(eventData, toolResponse) {
  if (toolResponse === null || toolResponse === undefined) {
    eventData["status"] = "success";
    eventData["gen_ai.tool.call.result"] = "null";
    return;
  }

  eventData["response_type"] = typeof toolResponse === "object"
    ? (Array.isArray(toolResponse) ? "list" : "dict")
    : typeof toolResponse;

  if (toolResponse !== null && typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
    const hasError =
      (toolResponse["error"] !== undefined && toolResponse["error"]) ||
      (toolResponse["isError"] !== undefined && toolResponse["isError"]);
    eventData["status"] = hasError ? "error" : "success";

    if (hasError) {
      const errorMsg = String(toolResponse["error"] || "Unknown error").slice(0, MAX_CONTENT_LENGTH);
      eventData["gen_ai.tool.call.result"] = `Error: ${errorMsg}`;
    } else {
      const summaryParts = [];
      for (const key of ["result", "content", "message", "output", "stdout"]) {
        if (key in toolResponse) {
          const raw = toolResponse[key];
          let val;
          if (Array.isArray(raw)) {
            // Extract text from content blocks [{type:"text",text:"..."}]
            const texts = raw
              .filter(item => item && typeof item === "object" && item.type === "text" && item.text)
              .map(item => item.text);
            val = texts.length > 0 ? texts.join("") : JSON.stringify(raw);
          } else if (raw !== null && typeof raw === "object") {
            val = JSON.stringify(raw);
          } else {
            val = String(raw);
          }
          summaryParts.push(
            val.length < MAX_CONTENT_LENGTH ? `${key}=${val}` : `${key}=...(${val.length} chars)`
          );
        }
      }
      if (summaryParts.length > 0) {
        eventData["gen_ai.tool.call.result"] = summaryParts.slice(0, 3).join(", ");
      } else {
        const keys = Object.keys(toolResponse);
        eventData["gen_ai.tool.call.result"] = `${keys.length} fields: [${keys.slice(0, 5).join(", ")}]`;
      }
    }

    for (const [key, value] of Object.entries(toolResponse)) {
      let strVal;
      if (Array.isArray(value)) {
        const texts = value
          .filter(item => item && typeof item === "object" && item.type === "text" && item.text)
          .map(item => item.text);
        strVal = texts.length > 0 ? texts.join("") : JSON.stringify(value);
      } else if (value !== null && typeof value === "object") {
        strVal = JSON.stringify(value);
      } else {
        strVal = String(value);
      }
      if (strVal.length < MAX_CONTENT_LENGTH) {
        eventData[`response.${key}`] = strVal;
      } else {
        eventData[`response.${key}`] =
          strVal.slice(0, MAX_CONTENT_LENGTH) + `... (truncated, full size: ${strVal.length} chars)`;
      }
    }
  } else if (Array.isArray(toolResponse)) {
    eventData["status"] = "success";
    eventData["gen_ai.tool.call.result"] = `List with ${toolResponse.length} item${toolResponse.length !== 1 ? "s" : ""}`;
    eventData["response.count"] = toolResponse.length;
    if (toolResponse.length > 0) {
      eventData["response.first_item"] = String(toolResponse[0]).slice(0, MAX_CONTENT_LENGTH);
    }
  } else if (typeof toolResponse === "string") {
    eventData["status"] = "success";
    if (toolResponse.length < MAX_CONTENT_LENGTH) {
      eventData["gen_ai.tool.call.result"] = toolResponse;
      eventData["response"] = toolResponse;
    } else {
      eventData["gen_ai.tool.call.result"] = toolResponse.slice(0, MAX_CONTENT_LENGTH) + "...";
      eventData["response"] = toolResponse.slice(0, MAX_CONTENT_LENGTH);
    }
  } else {
    eventData["status"] = "success";
    const strVal = String(toolResponse);
    eventData["gen_ai.tool.call.result"] = strVal.slice(0, MAX_CONTENT_LENGTH);
    eventData["response"] = strVal.length > MAX_CONTENT_LENGTH
      ? strVal.slice(0, MAX_CONTENT_LENGTH)
      : strVal;
  }
}

/**
 * Extract a clean result value from Claude Code's tool response for `toolCallResult`.
 * @param {*} toolResponse
 * @returns {string|object|null}
 */
function extractToolResult(toolResponse) {
  if (toolResponse == null) return null;
  if (typeof toolResponse === "string") return toolResponse;
  if (typeof toolResponse !== "object" || Array.isArray(toolResponse)) return toolResponse;

  if (toolResponse.error || toolResponse.isError) {
    return `Error: ${toolResponse.error || "Unknown error"}`;
  }

  for (const key of ["result", "content", "message", "output", "stdout"]) {
    if (!(key in toolResponse)) continue;
    const raw = toolResponse[key];
    if (Array.isArray(raw)) {
      const texts = raw
        .filter(item => item && typeof item === "object" && item.type === "text" && item.text)
        .map(item => item.text);
      if (texts.length > 0) return texts.join("");
    }
    return raw;
  }

  return toolResponse;
}

/**
 * Detect if a tool response indicates an error.
 * @param {*} toolResponse
 * @returns {{ message: string, type: string } | null}
 */
function extractToolError(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) return null;
  if (!toolResponse.error && !toolResponse.isError) return null;
  return {
    message: String(toolResponse.error || "Unknown error"),
    type: "ToolError",
  };
}

module.exports = {
  createToolTitle,
  createEventData,
  addResponseToEventData,
  truncateForDisplay,
  smartTruncateValue,
  extractToolResult,
  extractToolError,
  MAX_CONTENT_LENGTH,
};
