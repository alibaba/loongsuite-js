import { isIP } from "node:net";

export const CONTENT_EXPORT_ACKNOWLEDGEMENT =
  "GENAI_DEMO_ALLOW_CONTENT_EXPORT";

const SAFE_ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export function enableDemoContentExport() {
  if (
    process.env[CONTENT_EXPORT_ACKNOWLEDGEMENT]?.trim().toLowerCase() !==
    "true"
  ) {
    throw new Error(
      `${CONTENT_EXPORT_ACKNOWLEDGEMENT}=true is required because this ` +
        "demo exports complete GenAI messages to the configured OTLP backend",
    );
  }

  process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
    "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    "SPAN_ONLY";
}

export function toSafeGenAIError(error, fallbackType, safeMessage) {
  const candidateType =
    error instanceof Error ? error.constructor?.name : null;
  const type =
    typeof candidateType === "string" &&
    SAFE_ERROR_TYPE_PATTERN.test(candidateType)
      ? candidateType
      : fallbackType;

  return { type, message: safeMessage };
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

export function validatePublicImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MULTIMODAL_IMAGE_URL must be a valid public HTTPS URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("MULTIMODAL_IMAGE_URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "MULTIMODAL_IMAGE_URL must not contain credentials, query parameters, " +
        "or fragments",
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("MULTIMODAL_IMAGE_URL must not reference a private host");
  }

  const addressType = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (
    (addressType === 4 && isPrivateIpv4(hostname)) ||
    (addressType === 6 && isPrivateIpv6(hostname))
  ) {
    throw new Error(
      "MULTIMODAL_IMAGE_URL must not reference a private IP address",
    );
  }

  return value;
}
