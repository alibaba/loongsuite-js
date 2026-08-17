#!/usr/bin/env bash
# setup-alias.sh — Add a qwen alias that injects intercept.js via NODE_OPTIONS
# Copyright 2026 Alibaba Group Holding Limited
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

INTERCEPT_PATH="$HOME/.cache/opentelemetry.instrumentation.qwen/intercept.js"

if [ ! -f "$INTERCEPT_PATH" ]; then
  echo "⚠️  intercept.js not found at $INTERCEPT_PATH"
  echo "   Run 'otel-qwen-hook install' first."
  exit 1
fi

ALIAS_LINE="alias qwen='NODE_OPTIONS=\"--require $INTERCEPT_PATH \${NODE_OPTIONS:-}\" qwen'"
BEGIN_MARKER="# BEGIN otel-qwen-hook"
END_MARKER="# END otel-qwen-hook"

BLOCK="$BEGIN_MARKER
$ALIAS_LINE
$END_MARKER"

add_to_rc() {
  local rc="$1"
  if [ ! -f "$rc" ]; then
    return
  fi
  if grep -q "$BEGIN_MARKER" "$rc" 2>/dev/null; then
    echo "  ✅ alias already in $rc"
    return
  fi
  echo "" >> "$rc"
  echo "$BLOCK" >> "$rc"
  echo "  ✅ alias added to $rc"
}

echo "Setting up qwen alias with intercept.js..."

for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  add_to_rc "$rc"
done

echo ""
echo "Restart your shell or run: source ~/.zshrc"
