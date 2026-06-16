#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# opentelemetry-instrumentation-openclaw — container image build installer
#
# Designed for Dockerfile / CI image builds where runtime config (endpoint,
# credentials, service name) is NOT available at build time. The plugin is
# installed with only structural config (enabled + hooks); all connection
# parameters are resolved from environment variables at container startup.
#
# Usage (Dockerfile):
#   RUN curl -fsSL https://<oss-host>/install-ack.sh | bash
#   # or with optional overrides:
#   RUN curl -fsSL https://<oss-host>/install-ack.sh | bash -s -- \
#         --plugin-url "https://..." \
#         --install-dir "/opt/openclaw-plugin" \
#         --disable-metrics \
#         --semconv-dialect "ALIBABA_GROUP"
#
# Required env vars at container startup:
#   ARMS_OTLP_ENDPOINT              OTLP endpoint URL
#
# Optional env vars at container startup:
#   ARMS_LICENSE_KEY                 x-arms-license-key header
#   ARMS_PROJECT                    x-arms-project header
#   ARMS_CMS_WORKSPACE              x-cms-workspace header
#   ARMS_SERVICE_NAME                Service name (also reads OTEL_SERVICE_NAME)
#   ARMS_TRACE_DEBUG                 Enable debug logging (true/1)
#   ARMS_ENABLE_TRACE_PROPAGATION    Enable W3C propagation (true/1)
#   OTEL_RESOURCE_ATTRIBUTES         Custom resource attrs (key=val,key=val)
#   OTEL_SPAN_ATTRIBUTES             Custom span attrs (key=val,key=val)
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_NAME="opentelemetry-instrumentation-openclaw"
DIAG_PLUGIN_NAME="diagnostics-otel"
DEFAULT_PLUGIN_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-openclaw/opentelemetry-instrumentation-openclaw-ack.tar.gz"

# ── Defaults ──
PLUGIN_URL="${DEFAULT_PLUGIN_URL}"
INSTALL_DIR=""
ENABLE_METRICS=true
SEMCONV_DIALECT="ALIBABA_CLOUD"

# ── Color helpers ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }

# ── Parse arguments ──
need_value() {
  if [[ $# -lt 2 ]] || [[ "$2" == --* ]]; then
    error "Option $1 requires a value"
    exit 1
  fi
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin-url)         need_value "$@"; PLUGIN_URL="$2";     shift 2 ;;
    --install-dir)        need_value "$@"; INSTALL_DIR="$2";    shift 2 ;;
    --disable-metrics)    ENABLE_METRICS=false; shift ;;
    --semconv-dialect)    need_value "$@"; SEMCONV_DIALECT="$2"; shift 2 ;;
    *)
      error "Unknown option: $1"
      echo ""
      echo "Usage:"
      echo "  curl -fsSL https://<host>/install-ack.sh | bash -s -- [OPTIONS]"
      echo ""
      echo "Options:"
      echo "    --plugin-url URL        Custom tarball download URL"
      echo "    --install-dir DIR       Override install directory"
      echo "    --disable-metrics       Skip diagnostics-otel metrics setup"
      echo "    --semconv-dialect NAME  ALIBABA_CLOUD (default) or ALIBABA_GROUP"
      exit 1
      ;;
  esac
done

info "Container image build mode — no endpoint/credentials required at install time"
info "All connection parameters will be resolved from environment variables at runtime"
echo ""

# ── Check prerequisites ──
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js >= 18 first."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  error "Node.js >= 18 is required (current: $(node --version))"
  exit 1
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  error "npm is not installed."
  exit 1
fi
ok "npm $(npm --version)"

# OpenClaw CLI is optional in image build — it may be installed later
OPENCLAW_CMD="openclaw"
NEEDS_HOOKS=true
if command -v "$OPENCLAW_CMD" &>/dev/null; then
  ok "OpenClaw CLI found"

  OPENCLAW_VERSION=$("$OPENCLAW_CMD" --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
  if [[ -n "$OPENCLAW_VERSION" ]]; then
    OC_MAJOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f1)
    OC_MINOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f2)
    OC_PATCH=$(echo "$OPENCLAW_VERSION" | cut -d. -f3)
    OC_NUM=$((OC_MAJOR * 10000 + OC_MINOR * 100 + OC_PATCH))
    if [[ $OC_NUM -lt 20260425 ]]; then
      NEEDS_HOOKS=false
    fi
    ok "OpenClaw $OPENCLAW_VERSION (hooks.allowConversationAccess: $([ "$NEEDS_HOOKS" = true ] && echo 'enabled' || echo 'skipped'))"
  else
    warn "Could not detect OpenClaw version, assuming hooks.allowConversationAccess is supported"
  fi
else
  warn "OpenClaw CLI not found — assuming hooks.allowConversationAccess is supported (will be validated at runtime)"
fi

# ── Remove legacy install directory ──
LEGACY_DIR="${HOME}/.openclaw/extensions/openclaw-cms-plugin"
if [[ -d "$LEGACY_DIR" ]]; then
  info "Removing legacy openclaw-cms-plugin directory..."
  rm -rf "$LEGACY_DIR"
fi

# ── Determine install directory ──
if [[ -n "$INSTALL_DIR" ]]; then
  TARGET_DIR="$INSTALL_DIR"
elif [[ -n "${OPENCLAW_STATE_DIR:-}" ]] && [[ -d "$OPENCLAW_STATE_DIR" ]]; then
  TARGET_DIR="${OPENCLAW_STATE_DIR}/extensions/${PLUGIN_NAME}"
elif [[ -d "$HOME/.openclaw" ]]; then
  TARGET_DIR="$HOME/.openclaw/extensions/${PLUGIN_NAME}"
else
  TARGET_DIR="/opt/${PLUGIN_NAME}"
fi

info "Install directory: ${TARGET_DIR}"

# ── Clean previous installation ──
if [[ -d "$TARGET_DIR" ]]; then
  if [[ -z "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
    info "Target directory exists but is empty, skipping cleanup."
  elif [[ -f "$TARGET_DIR/package.json" ]] || [[ -f "$TARGET_DIR/openclaw.plugin.json" ]]; then
    info "Removing previous installation..."
    rm -rf "$TARGET_DIR"
  else
    info "Target directory exists but does not look like a plugin installation, removing..."
    rm -rf "$TARGET_DIR"
  fi
fi
mkdir -p "$TARGET_DIR"

# ── Download and extract ──
info "Downloading plugin from ${PLUGIN_URL}..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v curl &>/dev/null; then
  curl -fsSL -H "Cache-Control: no-cache" "$PLUGIN_URL" -o "$TMP_DIR/plugin.tar.gz"
elif command -v wget &>/dev/null; then
  wget -q --no-cache "$PLUGIN_URL" -O "$TMP_DIR/plugin.tar.gz"
else
  error "Neither curl nor wget is available."
  exit 1
fi
ok "Downloaded"

info "Extracting to ${TARGET_DIR}..."
tar -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR"
EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)
if [[ -n "$EXTRACTED_DIR" ]]; then
  cp -rf "$EXTRACTED_DIR/." "$TARGET_DIR/"
else
  error "Failed to extract plugin archive"
  exit 1
fi
ok "Extracted"

# ── Install npm dependencies ──
info "Installing npm dependencies (production only)..."
cd "$TARGET_DIR"
if ! npm install --omit=dev --ignore-scripts 2>&1; then
  error "npm install failed in ${TARGET_DIR}"
  exit 1
fi
ok "Dependencies installed"

# ══════════════════════════════════════════════════════
# ── diagnostics-otel: locate, install deps, configure ──
# ══════════════════════════════════════════════════════
DIAG_OTEL_DIR=""
DIAG_OTEL_STATUS="skipped"

if [[ "$ENABLE_METRICS" == true ]]; then
  info "Locating ${DIAG_PLUGIN_NAME} extension..."

  find_diag_otel() {
    local candidate="$1"
    if [[ -d "$candidate" ]] && [[ -f "$candidate/package.json" ]]; then
      DIAG_OTEL_DIR="$candidate"
      return 0
    fi
    return 1
  }

  if [[ -n "${OPENCLAW_BUNDLED_PLUGINS_DIR:-}" ]]; then
    find_diag_otel "${OPENCLAW_BUNDLED_PLUGINS_DIR}/${DIAG_PLUGIN_NAME}" || true
  fi

  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v openclaw &>/dev/null; then
    OPENCLAW_BIN=$(command -v openclaw)
    OPENCLAW_BIN_REAL=$(realpath "$OPENCLAW_BIN" 2>/dev/null || readlink -f "$OPENCLAW_BIN" 2>/dev/null || echo "$OPENCLAW_BIN")
    OPENCLAW_BIN_DIR=$(dirname "$OPENCLAW_BIN_REAL")
    find_diag_otel "${OPENCLAW_BIN_DIR}/extensions/${DIAG_PLUGIN_NAME}" || true
    if [[ -z "$DIAG_OTEL_DIR" ]]; then
      OPENCLAW_PARENT=$(dirname "$OPENCLAW_BIN_DIR")
      find_diag_otel "${OPENCLAW_PARENT}/extensions/${DIAG_PLUGIN_NAME}" || true
      find_diag_otel "${OPENCLAW_PARENT}/lib/node_modules/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v npm &>/dev/null; then
    NPM_GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
    if [[ -n "$NPM_GLOBAL_ROOT" ]]; then
      find_diag_otel "${NPM_GLOBAL_ROOT}/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  if [[ -z "$DIAG_OTEL_DIR" ]]; then
    if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
      find_diag_otel "${OPENCLAW_STATE_DIR}/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
    if [[ -z "$DIAG_OTEL_DIR" ]]; then
      find_diag_otel "$HOME/.openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  if [[ -n "$DIAG_OTEL_DIR" ]]; then
    ok "Found ${DIAG_PLUGIN_NAME} at: ${DIAG_OTEL_DIR}"
    if [[ ! -d "${DIAG_OTEL_DIR}/node_modules" ]]; then
      info "Installing ${DIAG_PLUGIN_NAME} dependencies (first-time setup)..."
      if ! (cd "$DIAG_OTEL_DIR" && npm install --omit=dev --ignore-scripts 2>&1); then
        warn "${DIAG_PLUGIN_NAME} npm install failed. You may need to install manually: cd ${DIAG_OTEL_DIR} && npm install --omit=dev"
        DIAG_OTEL_STATUS="npm_failed"
      else
        ok "${DIAG_PLUGIN_NAME} dependencies installed"
        DIAG_OTEL_STATUS="fresh_install"
      fi
    else
      ok "${DIAG_PLUGIN_NAME} dependencies already present"
      DIAG_OTEL_STATUS="already_installed"
    fi
  else
    warn "${DIAG_PLUGIN_NAME} not found. Metrics configuration will be written but the plugin may not load until OpenClaw is properly installed."
    DIAG_OTEL_STATUS="not_found"
  fi
fi

# ── Determine openclaw.json path ──
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
elif [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
else
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
  mkdir -p "$(dirname "$CONFIG_PATH")"
fi

info "Updating config: ${CONFIG_PATH}"

# ── Update openclaw.json — structural config only, no connection params ──
DIAG_CHANGES=$(node -e "
const fs = require('fs');
const configPath     = process.argv[1];
const pluginName     = process.argv[2];
const installDir     = process.argv[3];
const enableMetrics  = process.argv[4] === 'true';
const diagPluginName = process.argv[5];
const needsHooks     = process.argv[6] === 'true';

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

if (!config.plugins) config.plugins = {};

// plugins.allow
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginName)) {
  config.plugins.allow.push(pluginName);
}

// plugins.load.paths
if (!config.plugins.load) config.plugins.load = {};
if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
const paths = config.plugins.load.paths;
const idx = paths.findIndex(p => p.includes(pluginName));
if (idx >= 0) paths[idx] = installDir;
else paths.push(installDir);

// plugins.entries — enabled + hooks only, NO config block
if (!config.plugins.entries) config.plugins.entries = {};
const entry = { enabled: true };
if (needsHooks) {
  entry.hooks = { allowConversationAccess: true };
}
config.plugins.entries[pluginName] = entry;

// diagnostics-otel — structural config only, no endpoint/headers/serviceName
const diagChanges = [];
if (enableMetrics) {
  if (!config.plugins.allow.includes(diagPluginName)) {
    config.plugins.allow.push(diagPluginName);
    diagChanges.push('added to plugins.allow');
  }

  const existingEntry = config.plugins.entries[diagPluginName];
  if (existingEntry) {
    if (!existingEntry.enabled) {
      existingEntry.enabled = true;
      diagChanges.push('enabled in plugins.entries');
    }
  } else {
    config.plugins.entries[diagPluginName] = { enabled: true };
    diagChanges.push('added to plugins.entries');
  }

  if (!config.diagnostics) config.diagnostics = {};
  const prevDiagEnabled = config.diagnostics.enabled;
  config.diagnostics.enabled = true;
  if (!prevDiagEnabled) diagChanges.push('diagnostics.enabled -> true');

  if (!config.diagnostics.otel) config.diagnostics.otel = {};
  const otel = config.diagnostics.otel;

  const prevOtelEnabled = otel.enabled;
  otel.enabled = true;
  if (!prevOtelEnabled) diagChanges.push('diagnostics.otel.enabled -> true');

  if (!otel.protocol) otel.protocol = 'http/protobuf';

  const prevMetrics = otel.metrics;
  otel.metrics = true;
  if (prevMetrics === false) diagChanges.push('diagnostics.otel.metrics -> true');

  if (otel.traces === undefined) otel.traces = false;
  if (otel.logs === undefined) otel.logs = false;

  if (diagChanges.length === 0) diagChanges.push('no changes needed');
}

// Migration: remove legacy 'openclaw-cms-plugin' entries
const LEGACY_PLUGIN_NAME = 'openclaw-cms-plugin';
if (config.plugins.allow && Array.isArray(config.plugins.allow)) {
  config.plugins.allow = config.plugins.allow.filter(id => id !== LEGACY_PLUGIN_NAME);
}
if (config.plugins.entries && config.plugins.entries[LEGACY_PLUGIN_NAME]) {
  delete config.plugins.entries[LEGACY_PLUGIN_NAME];
}
if (config.plugins.load && Array.isArray(config.plugins.load.paths)) {
  config.plugins.load.paths = config.plugins.load.paths.filter(p => !p.includes(LEGACY_PLUGIN_NAME));
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
process.stdout.write(diagChanges.join('|'));
" \
  "$CONFIG_PATH" \
  "$PLUGIN_NAME" \
  "$TARGET_DIR" \
  "$ENABLE_METRICS" \
  "$DIAG_PLUGIN_NAME" \
  "$NEEDS_HOOKS"
)

ok "Config updated"

# ── Write semconv dialect env var to shell profiles ──
_upsert_env_block() {
  local file="$1" marker="$2" marker_end="$3" env_line="$4"
  touch "$file" 2>/dev/null || { warn "Cannot write to $file (skipped)"; return; }
  if grep -q "$marker" "$file" 2>/dev/null; then
    local _tmp; _tmp=$(mktemp)
    grep -v -A0 "" "$file" | sed "/^${marker}$/,/^${marker_end}$/d" > "$_tmp" && mv "$_tmp" "$file" || rm -f "$_tmp"
  fi
  printf '\n%s\n%s\n%s\n' "$marker" "$env_line" "$marker_end" >> "$file"
  ok "Env written to $file"
}

_DELTA_MARKER='# BEGIN opentelemetry-instrumentation-openclaw-delta-temporality'
_DELTA_MARKER_END='# END opentelemetry-instrumentation-openclaw-delta-temporality'
_DELTA_ENV_LINE='export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta'
for _f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  _upsert_env_block "$_f" "$_DELTA_MARKER" "$_DELTA_MARKER_END" "$_DELTA_ENV_LINE"
done

_SEMCONV_MARKER='# BEGIN opentelemetry-instrumentation-openclaw-semconv-dialect'
_SEMCONV_MARKER_END='# END opentelemetry-instrumentation-openclaw-semconv-dialect'
_SEMCONV_ENV_LINE="export LOONGSUITE_SEMCONV_DIALECT_NAME=${SEMCONV_DIALECT}"
for _f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  _upsert_env_block "$_f" "$_SEMCONV_MARKER" "$_SEMCONV_MARKER_END" "$_SEMCONV_ENV_LINE"
done

# ── Summary ──
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Plugin installed (image build mode)${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Install dir:   ${TARGET_DIR}"
echo "  Config file:   ${CONFIG_PATH}"
echo "  Config mode:   env-var driven (no endpoint/credentials baked in)"
echo "  Semconv:       ${SEMCONV_DIALECT}"
echo ""

if [[ "$ENABLE_METRICS" == true ]]; then
  echo -e "${CYAN}  ── diagnostics-otel (metrics) ──${NC}"
  case "$DIAG_OTEL_STATUS" in
    fresh_install)
      echo -e "  Status:        ${GREEN}Newly installed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    already_installed)
      echo -e "  Status:        ${GREEN}Already installed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    npm_failed)
      echo -e "  Status:        ${YELLOW}Dependencies install failed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      echo "                 Run manually: cd ${DIAG_OTEL_DIR} && npm install --omit=dev"
      ;;
    not_found)
      echo -e "  Status:        ${YELLOW}Plugin directory not found${NC}"
      echo "                 Config written; will activate when OpenClaw is installed."
      ;;
  esac
  if [[ -n "$DIAG_CHANGES" ]] && [[ "$DIAG_CHANGES" != "no changes needed" ]]; then
    echo -e "  Config changes: ${YELLOW}${DIAG_CHANGES//|/, }${NC}"
  fi
  echo ""
fi

echo -e "${CYAN}  ── Required env vars at container startup ──${NC}"
echo "  ARMS_OTLP_ENDPOINT              OTLP endpoint URL (required)"
echo ""
echo -e "${CYAN}  ── Optional env vars at container startup ──${NC}"
echo "  ARMS_LICENSE_KEY                 x-arms-license-key"
echo "  ARMS_PROJECT                     x-arms-project"
echo "  ARMS_CMS_WORKSPACE              x-cms-workspace"
echo "  ARMS_SERVICE_NAME                Service name (default: openclaw-agent)"
echo "  OTEL_SERVICE_NAME                Service name (alternative)"
echo "  ARMS_TRACE_DEBUG                 Debug logging (true/1)"
echo "  ARMS_ENABLE_TRACE_PROPAGATION    W3C propagation (true/1)"
echo "  OTEL_RESOURCE_ATTRIBUTES         Resource attrs (key=val,key=val)"
echo "  OTEL_SPAN_ATTRIBUTES             Span attrs (key=val,key=val)"
echo ""
