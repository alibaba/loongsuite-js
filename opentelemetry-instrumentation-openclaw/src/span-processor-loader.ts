// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// Loads a user-provided custom SpanProcessor and makes it safe to run inside the
// plugin's dedicated TracerProvider.
//
// Design goals:
//   - Graceful degradation: any load/validation failure logs and returns null,
//     so the built-in BatchSpanProcessor keeps working on its own.
//   - Runtime isolation: every user callback is wrapped in try/catch so a faulty
//     processor can never break the built-in export pipeline.
//   - Duck typing (not instanceof): the user module may resolve a different copy
//     of @opentelemetry/sdk-trace-base, so we validate by shape, not identity.

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { OpenClawPluginApi } from "./types.js";

// `onEnding` is experimental in the OTel SDK and may be absent from the public
// SpanProcessor type. Declare the shape we rely on so we can wrap it safely.
type SpanProcessorWithEnding = SpanProcessor & {
  onEnding?: (span: Span) => void;
};

/**
 * Resolve the module path. Absolute paths are used as-is; relative paths are
 * resolved against OPENCLAW_HOME (defaulting to ~/.openclaw).
 */
function resolveModulePath(modulePath: string): string {
  if (isAbsolute(modulePath)) {
    return modulePath;
  }
  const home = process.env["OPENCLAW_HOME"] || resolve(homedir(), ".openclaw");
  return resolve(home, modulePath);
}

/** A value is treated as a SpanProcessor if it exposes an `onEnd` function. */
function isSpanProcessorLike(value: unknown): value is SpanProcessorWithEnding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { onEnd?: unknown }).onEnd === "function"
  );
}

/**
 * Wrap a user processor so every lifecycle callback is isolated: exceptions are
 * logged and swallowed, never propagated into the SDK's span pipeline.
 */
function wrapUserProcessor(
  proc: SpanProcessorWithEnding,
  api: OpenClawPluginApi,
): SpanProcessor {
  const warn = (method: string, err: unknown): void => {
    api.logger.warn(
      `[ArmsTrace] user SpanProcessor.${method} threw: ${String(err)}`,
    );
  };

  const wrapped: SpanProcessorWithEnding = {
    onStart(span: Span, parentContext: Context): void {
      try {
        proc.onStart?.(span, parentContext);
      } catch (err) {
        warn("onStart", err);
      }
    },
    onEnd(span: ReadableSpan): void {
      try {
        proc.onEnd?.(span);
      } catch (err) {
        warn("onEnd", err);
      }
    },
    forceFlush(): Promise<void> {
      return Promise.resolve()
        .then(() => proc.forceFlush?.())
        .then(() => undefined)
        .catch((err) => warn("forceFlush", err));
    },
    shutdown(): Promise<void> {
      return Promise.resolve()
        .then(() => proc.shutdown?.())
        .then(() => undefined)
        .catch((err) => warn("shutdown", err));
    },
  };

  // Only expose onEnding when the user actually implements it, so the SDK's
  // feature detection stays accurate.
  if (typeof proc.onEnding === "function") {
    wrapped.onEnding = (span: Span): void => {
      try {
        proc.onEnding?.(span);
      } catch (err) {
        warn("onEnding", err);
      }
    };
  }

  return wrapped;
}

/**
 * Dynamically import the user module and return an isolated SpanProcessor.
 * Returns null on any failure (missing file, bad export, import error) so the
 * caller can fall back to the built-in processor only.
 */
export async function loadUserSpanProcessor(
  modulePath: string,
  api: OpenClawPluginApi,
): Promise<SpanProcessor | null> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveModulePath(modulePath);
  } catch (err) {
    api.logger.error(
      `[ArmsTrace] Failed to resolve spanProcessorModule '${modulePath}': ${String(err)}`,
    );
    return null;
  }

  try {
    const mod = (await import(pathToFileURL(resolvedPath).href)) as {
      default?: unknown;
    };
    const exported = mod.default;

    if (!isSpanProcessorLike(exported)) {
      api.logger.error(
        `[ArmsTrace] spanProcessorModule '${modulePath}' has no valid default export ` +
          "(expected a SpanProcessor object with an onEnd method); " +
          "continuing with built-in processor only.",
      );
      return null;
    }

    api.logger.info(
      `[ArmsTrace] Loaded custom SpanProcessor from ${resolvedPath}`,
    );
    return wrapUserProcessor(exported, api);
  } catch (err) {
    api.logger.error(
      `[ArmsTrace] Failed to load spanProcessorModule '${modulePath}' (${resolvedPath}): ` +
        `${String(err)}. Continuing with built-in processor only.`,
    );
    return null;
  }
}
