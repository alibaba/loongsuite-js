#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# opentelemetry-instrumentation-openclaw one-line installer
#
# Usage:
#   curl -fsSL https://<oss-host>/install.sh | bash -s -- \
#     --endpoint "https://..." \
#     --x-arms-license-key "xxx" \
#     --x-arms-project "xxx" \
#     --x-cms-workspace "xxx" \
#     --serviceName "my-service"
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_NAME="opentelemetry-instrumentation-openclaw"
DIAG_PLUGIN_NAME="diagnostics-otel"
# ── Replace with your actual OSS URL after uploading ──
DEFAULT_PLUGIN_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-openclaw/opentelemetry-instrumentation-openclaw.tar.gz"

# ── Defaults ──
ENDPOINT=""
LICENSE_KEY=""
ARMS_PROJECT=""
CMS_WORKSPACE=""
SERVICE_NAME="${openclaw_identity:-}"
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
    --endpoint)           need_value "$@"; ENDPOINT="$2";       shift 2 ;;
    --x-arms-license-key) need_value "$@"; LICENSE_KEY="$2";    shift 2 ;;
    --x-arms-project)     need_value "$@"; ARMS_PROJECT="$2";   shift 2 ;;
    --x-cms-workspace)    need_value "$@"; CMS_WORKSPACE="$2";  shift 2 ;;
    --serviceName)        need_value "$@"; [[ -z "${openclaw_identity:-}" ]] && SERVICE_NAME="$2"; shift 2 ;;
    --plugin-url)         need_value "$@"; PLUGIN_URL="$2";     shift 2 ;;
    --install-dir)        need_value "$@"; INSTALL_DIR="$2";    shift 2 ;;
    --disable-metrics)    ENABLE_METRICS=false; shift ;;
    --semconv-dialect)    need_value "$@"; SEMCONV_DIALECT="$2"; shift 2 ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Auto-detect semconv dialect from endpoint ──
# Sunfire endpoints are Alibaba-internal and always require ALIBABA_GROUP.
if [[ "$SEMCONV_DIALECT" == "ALIBABA_CLOUD" ]] && echo "$ENDPOINT" | grep -qi "sunfire"; then
  SEMCONV_DIALECT="ALIBABA_GROUP"
  info "Sunfire endpoint detected — defaulting semconv dialect to ALIBABA_GROUP"
fi

# ── Validate required parameters ──
MISSING=()
[[ -z "$ENDPOINT" ]]    && MISSING+=("--endpoint")
[[ -z "$SERVICE_NAME" ]] && MISSING+=("--serviceName (or set openclaw_identity env var)")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing required parameters: ${MISSING[*]}"
  echo ""
  echo "Usage:"
  echo "  curl -fsSL https://<host>/install.sh | bash -s -- \\"
  echo "    --endpoint \"https://...\" \\"
  echo "    --serviceName \"my-service\""
  echo ""
  echo "Or set openclaw_identity env var to skip --serviceName:"
  echo "  export openclaw_identity=\"my-service\""
  echo "  curl -fsSL https://<host>/install.sh | bash -s -- --endpoint \"https://...\""
  echo ""
  echo "Optional:"
  echo "    --x-arms-license-key \"xxx\" \\"
  echo "    --x-arms-project \"xxx\" \\"
  echo "    --x-cms-workspace \"xxx\""
  exit 1
fi

# ── Check prerequisites ──
info "Checking prerequisites..."
if [[ -n "${openclaw_identity:-}" ]]; then
  info "openclaw_identity is set — using '${openclaw_identity}' as service.name (--serviceName ignored)"
fi

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

OPENCLAW_CMD="openclaw"
if ! command -v "$OPENCLAW_CMD" &>/dev/null; then
  error "OpenClaw CLI not found. Please install OpenClaw first before installing this plugin."
  exit 1
fi
ok "OpenClaw CLI found"

# ── Detect OpenClaw version for hooks compatibility ──
OPENCLAW_VERSION=$("$OPENCLAW_CMD" --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
NEEDS_HOOKS=false
if [[ -n "$OPENCLAW_VERSION" ]]; then
  OC_MAJOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f1)
  OC_MINOR=$(echo "$OPENCLAW_VERSION" | cut -d. -f2)
  OC_PATCH=$(echo "$OPENCLAW_VERSION" | cut -d. -f3)
  OC_NUM=$((OC_MAJOR * 10000 + OC_MINOR * 100 + OC_PATCH))
  if [[ $OC_NUM -ge 20260425 ]]; then
    NEEDS_HOOKS=true
  fi
  ok "OpenClaw $OPENCLAW_VERSION (hooks.allowConversationAccess: $([ "$NEEDS_HOOKS" = true ] && echo 'supported' || echo 'not supported, skipping'))"
else
  NEEDS_HOOKS=true
  warn "Could not detect OpenClaw version, assuming hooks.allowConversationAccess is supported"
fi

# ── Check endpoint connectivity ──
info "Checking endpoint connectivity: ${ENDPOINT}"
ENDPOINT_HTTP_CODE=$(curl -o /dev/null -s -w "%{http_code}" "$ENDPOINT" -m 10 2>/dev/null || echo "000")
if [[ "$ENDPOINT_HTTP_CODE" == "000" ]]; then
  if echo "$ENDPOINT" | grep -q -- '-intranet\.'; then
    error "Endpoint is unreachable (HTTP code: 000)."
    error "The endpoint appears to be an intranet address."
    error "Please go to the CMS 2.0 console → Integration Center to obtain the public endpoint, then re-run the install command."
    exit 1
  else
    error "Endpoint is unreachable (HTTP code: 000)."
    error "Please check your network connectivity to: ${ENDPOINT}"
    error "Data will not be reported if the endpoint is not reachable."
    exit 1
  fi
else
  ok "Endpoint reachable (HTTP ${ENDPOINT_HTTP_CODE})"
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

# ── Install npm dependencies for opentelemetry-instrumentation-openclaw ──
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

  # 1) OPENCLAW_BUNDLED_PLUGINS_DIR env
  if [[ -n "${OPENCLAW_BUNDLED_PLUGINS_DIR:-}" ]]; then
    find_diag_otel "${OPENCLAW_BUNDLED_PLUGINS_DIR}/${DIAG_PLUGIN_NAME}" || true
  fi

  # 2) Sibling of openclaw executable
  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v openclaw &>/dev/null; then
    OPENCLAW_BIN=$(command -v openclaw)
    # macOS readlink has no -f; use realpath or fall back to the raw path
    OPENCLAW_BIN_REAL=$(realpath "$OPENCLAW_BIN" 2>/dev/null || readlink -f "$OPENCLAW_BIN" 2>/dev/null || echo "$OPENCLAW_BIN")
    OPENCLAW_BIN_DIR=$(dirname "$OPENCLAW_BIN_REAL")
    find_diag_otel "${OPENCLAW_BIN_DIR}/extensions/${DIAG_PLUGIN_NAME}" || true
    # Also check parent dir (npm global: .../bin/../lib/...)
    if [[ -z "$DIAG_OTEL_DIR" ]]; then
      OPENCLAW_PARENT=$(dirname "$OPENCLAW_BIN_DIR")
      find_diag_otel "${OPENCLAW_PARENT}/extensions/${DIAG_PLUGIN_NAME}" || true
      find_diag_otel "${OPENCLAW_PARENT}/lib/node_modules/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  # 3) npm global root
  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v npm &>/dev/null; then
    NPM_GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
    if [[ -n "$NPM_GLOBAL_ROOT" ]]; then
      find_diag_otel "${NPM_GLOBAL_ROOT}/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  # 4) OPENCLAW_STATE_DIR / ~/.openclaw
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

    # Install dependencies if node_modules is missing
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

# ── Update openclaw.json using inline Node.js ──
DIAG_CHANGES=$(node -e "
const fs = require('fs');
const configPath     = process.argv[1];
const pluginName     = process.argv[2];
const installDir     = process.argv[3];
const endpoint       = process.argv[4];
const licenseKey     = process.argv[5];
const armsProject    = process.argv[6];
const cmsWorkspace   = process.argv[7];
const serviceName    = process.argv[8];
const enableMetrics  = process.argv[9] === 'true';
const diagPluginName = process.argv[10];
const needsHooks     = process.argv[11] === 'true';

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

if (!config.plugins) config.plugins = {};

// ── opentelemetry-instrumentation-openclaw: plugins.allow ──
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginName)) {
  config.plugins.allow.push(pluginName);
}

// ── opentelemetry-instrumentation-openclaw: plugins.load.paths ──
if (!config.plugins.load) config.plugins.load = {};
if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
const paths = config.plugins.load.paths;
const idx = paths.findIndex(p => p.includes(pluginName));
if (idx >= 0) paths[idx] = installDir;
else paths.push(installDir);

// ── opentelemetry-instrumentation-openclaw: plugins.entries ──
if (!config.plugins.entries) config.plugins.entries = {};
const pluginHeaders = {};
if (licenseKey) pluginHeaders['x-arms-license-key'] = licenseKey;
if (armsProject) pluginHeaders['x-arms-project'] = armsProject;
if (cmsWorkspace) pluginHeaders['x-cms-workspace'] = cmsWorkspace;
const entry = {
  enabled: true,
  config: {
    endpoint,
    headers: pluginHeaders,
    serviceName
  }
};
if (needsHooks) {
  entry.hooks = { allowConversationAccess: true };
}
config.plugins.entries[pluginName] = entry;

// ── diagnostics-otel ──
const diagChanges = [];
if (enableMetrics) {
  // plugins.allow
  if (!config.plugins.allow.includes(diagPluginName)) {
    config.plugins.allow.push(diagPluginName);
    diagChanges.push('added to plugins.allow');
  }

  // plugins.entries
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

  // diagnostics section
  if (!config.diagnostics) config.diagnostics = {};
  const prevDiagEnabled = config.diagnostics.enabled;
  config.diagnostics.enabled = true;
  if (!prevDiagEnabled) diagChanges.push('diagnostics.enabled -> true');

  if (!config.diagnostics.otel) config.diagnostics.otel = {};
  const otel = config.diagnostics.otel;

  const prevOtelEnabled = otel.enabled;
  otel.enabled = true;
  if (!prevOtelEnabled) diagChanges.push('diagnostics.otel.enabled -> true');

  // endpoint & headers: always update to match ARMS config
  const prevEndpoint = otel.endpoint;
  otel.endpoint = endpoint;
  if (prevEndpoint && prevEndpoint !== endpoint) diagChanges.push('diagnostics.otel.endpoint updated');

  if (!otel.protocol) otel.protocol = 'http/protobuf';

  const prevHeaders = JSON.stringify(otel.headers || {});
  const diagHeaders = {};
  if (licenseKey) diagHeaders['x-arms-license-key'] = licenseKey;
  if (armsProject) diagHeaders['x-arms-project'] = armsProject;
  if (cmsWorkspace) diagHeaders['x-cms-workspace'] = cmsWorkspace;
  otel.headers = diagHeaders;
  if (prevHeaders !== '{}' && prevHeaders !== JSON.stringify(otel.headers)) {
    diagChanges.push('diagnostics.otel.headers updated');
  }

  const prevServiceName = otel.serviceName;
  otel.serviceName = serviceName;
  if (prevServiceName && prevServiceName !== serviceName) diagChanges.push('diagnostics.otel.serviceName updated');

  // metrics: always enable
  const prevMetrics = otel.metrics;
  otel.metrics = true;
  if (prevMetrics === false) diagChanges.push('diagnostics.otel.metrics -> true');

  // traces & logs: only set defaults if not previously configured
  if (otel.traces === undefined) otel.traces = false;
  if (otel.logs === undefined) otel.logs = false;

  if (diagChanges.length === 0) diagChanges.push('no changes needed');
}

// ── Migration: remove legacy 'openclaw-cms-plugin' entries ──
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
  "$ENDPOINT" \
  "$LICENSE_KEY" \
  "$ARMS_PROJECT" \
  "$CMS_WORKSPACE" \
  "$SERVICE_NAME" \
  "$ENABLE_METRICS" \
  "$DIAG_PLUGIN_NAME" \
  "$NEEDS_HOOKS"
)

ok "Config updated"

# ── Helper: write/update an env block in a shell profile ──
# Usage: _upsert_env_block <file> <marker> <marker_end> <env_line>
# - Creates the file if it doesn't exist
# - Removes existing block (cross-platform sed via temp file)
# - Appends new block
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

# ── Write Delta temporality env var to shell profiles ──
_DELTA_MARKER='# BEGIN opentelemetry-instrumentation-openclaw-delta-temporality'
_DELTA_MARKER_END='# END opentelemetry-instrumentation-openclaw-delta-temporality'
_DELTA_ENV_LINE='export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta'
for _f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  _upsert_env_block "$_f" "$_DELTA_MARKER" "$_DELTA_MARKER_END" "$_DELTA_ENV_LINE"
done

# ── Write semconv dialect env var to shell profiles ──
_SEMCONV_MARKER='# BEGIN opentelemetry-instrumentation-openclaw-semconv-dialect'
_SEMCONV_MARKER_END='# END opentelemetry-instrumentation-openclaw-semconv-dialect'
_SEMCONV_ENV_LINE="export LOONGSUITE_SEMCONV_DIALECT_NAME=${SEMCONV_DIALECT}"
for _f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  _upsert_env_block "$_f" "$_SEMCONV_MARKER" "$_SEMCONV_MARKER_END" "$_SEMCONV_ENV_LINE"
done

# ── Inject env vars into systemd user session (systemd installs only) ──
# shell profile writes don't reach the gateway process; systemctl set-environment does.
if command -v systemctl &>/dev/null && systemctl --user is-active openclaw-gateway.service &>/dev/null 2>&1; then
  info "Injecting env vars into systemd user session..."
  systemctl --user set-environment \
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta \
    LOONGSUITE_SEMCONV_DIALECT_NAME="${SEMCONV_DIALECT}"
  ok "Env vars set in systemd"
fi

# ── Restart gateway ──
info "Restarting OpenClaw gateway..."
if $OPENCLAW_CMD gateway restart 2>&1; then
  ok "Gateway restarted"
else
  echo ""
  echo -e "${YELLOW}  ⚠  Gateway restart failed.${NC}"
  echo -e "     Please restart manually: ${CYAN}openclaw gateway restart${NC}"
  echo ""
  echo -e "     If the issue persists, run: ${RED}openclaw doctor${NC}"
  echo -e "     This command will diagnose and report common configuration issues."
  echo ""
fi

# ── Summary ──
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ opentelemetry-instrumentation-openclaw installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Install dir:   ${TARGET_DIR}"
echo "  Config file:   ${CONFIG_PATH}"
echo "  Endpoint:      ${ENDPOINT}"
echo "  Service name:  ${SERVICE_NAME}"
echo "  Metric tempo:  Delta (OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta)"
echo "  Semconv:       ${SEMCONV_DIALECT} (LOONGSUITE_SEMCONV_DIALECT_NAME=${SEMCONV_DIALECT})"
echo ""

if [[ "$ENABLE_METRICS" == true ]]; then
  echo -e "${CYAN}  ── diagnostics-otel (metrics) ──${NC}"
  case "$DIAG_OTEL_STATUS" in
    fresh_install)
      echo -e "  Status:        ${GREEN}Newly installed${NC} (npm dependencies installed)"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    already_installed)
      echo -e "  Status:        ${GREEN}Already installed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    npm_failed)
      echo -e "  Status:        ${YELLOW}Dependencies install failed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      echo "                 Please run manually: cd ${DIAG_OTEL_DIR} && npm install --omit=dev"
      ;;
    not_found)
      echo -e "  Status:        ${YELLOW}Plugin directory not found${NC}"
      echo "                 Config written; will activate when OpenClaw is installed."
      ;;
  esac

  # Show config changes
  if [[ -n "$DIAG_CHANGES" ]] && [[ "$DIAG_CHANGES" != "no changes needed" ]]; then
    echo -e "  Config changes: ${YELLOW}${DIAG_CHANGES//|/, }${NC}"
  else
    echo -e "  Config changes: ${GREEN}No changes needed (already configured)${NC}"
  fi

  # Warn about traces conflict
  CURRENT_TRACES=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
      process.stdout.write(String(c.diagnostics?.otel?.traces ?? false));
    } catch { process.stdout.write('false'); }
  " "$CONFIG_PATH")
  if [[ "$CURRENT_TRACES" == "true" ]]; then
    echo ""
    echo -e "  ${YELLOW}⚠ diagnostics.otel.traces is enabled.${NC}"
    echo -e "  ${YELLOW}  opentelemetry-instrumentation-openclaw already handles trace reporting to ARMS.${NC}"
    echo -e "  ${YELLOW}  Having both enabled may cause duplicate traces.${NC}"
  fi
  echo ""
else
  echo "  Metrics:       Skipped (--disable-metrics)"
  echo ""
fi
