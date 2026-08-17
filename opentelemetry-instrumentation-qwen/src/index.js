// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * index.js — Library entry point for @loongsuite/opentelemetry-instrumentation-qwen
 *
 * Re-exports the public API surface for programmatic usage.
 */

const { configureTelemetry, shutdownTelemetry } = require("./telemetry");
const { loadState, saveState, clearState } = require("./state");
const { createToolTitle, createEventData, addResponseToEventData } = require("./hooks");

module.exports = {
  configureTelemetry,
  shutdownTelemetry,
  loadState,
  saveState,
  clearState,
  createToolTitle,
  createEventData,
  addResponseToEventData,
};
