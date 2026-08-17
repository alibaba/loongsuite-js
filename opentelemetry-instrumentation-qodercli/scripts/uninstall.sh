#!/usr/bin/env bash
# uninstall.sh — Remove otel-qodercli-hook from settings.json and the system.
#
# Usage:
#   bash scripts/uninstall.sh           # remove user-level hooks + global bin
#   bash scripts/uninstall.sh --purge   # also wipe ~/.cache/opentelemetry.instrumentation.qodercli/

set -euo pipefail

PURGE=0
PROJECT=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --project) PROJECT=1 ;;
  esac
done

uninstall_args=(--user)
if [ "$PROJECT" -eq 1 ]; then uninstall_args=(--project); fi
if [ "$PURGE" -eq 1 ]; then uninstall_args+=(--purge); fi

echo "==> Removing hooks from settings.json..."
if command -v otel-qodercli-hook >/dev/null 2>&1; then
  otel-qodercli-hook uninstall "${uninstall_args[@]}" || true
else
  echo "    ⚠️  otel-qodercli-hook not on PATH; falling back to manual cleanup."
  SETTINGS="$HOME/.qoder/settings.json"
  if [ -f "$SETTINGS" ]; then
    # Simple grep to inform the user; full clean requires the installed binary.
    if grep -q "otel-qodercli-hook" "$SETTINGS" 2>/dev/null; then
      echo "    ⚠️  Stale entries detected in $SETTINGS — please edit manually."
    fi
  fi
fi
echo ""

echo "==> Unlinking global bin..."
npm uninstall -g @loongsuite/opentelemetry-instrumentation-qodercli 2>/dev/null || true
echo ""

if [ "$PURGE" -eq 1 ]; then
  echo "==> Purging session cache..."
  rm -rf "$HOME/.cache/opentelemetry.instrumentation.qodercli"
  echo "    ✅ Session cache deleted"
fi

echo "✅ Uninstall complete."
