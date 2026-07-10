import { readString } from "./env.js";
import { logger } from "./logger.js";

export interface SecurityHeaders {
  "X-Content-Type-Options": string;
  "X-Frame-Options": string;
  "X-XSS-Protection": string;
  "Referrer-Policy": string;
  "Permissions-Policy": string;
  "Strict-Transport-Security"?: string;
  "Content-Security-Policy"?: string;
}

export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};

export function createSecurityHeaders(
  options?: {
    hsts?: boolean;
    csp?: boolean;
    custom?: Record<string, string>;
  }
): Record<string, string> {
  const headers = { ...DEFAULT_SECURITY_HEADERS };

  if (options?.hsts || readString("NODE_ENV") === "production") {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains; preload";
  }

  if (options?.csp) {
    headers["Content-Security-Policy"] =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' ws: wss:; media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';";
  }

  if (options?.custom) {
    Object.assign(headers, options.custom);
  }

  return headers;
}

export function sanitizeRequestBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const sensitiveFields = [
    "password",
    "token",
    "secret",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "credit_card",
    "ssn",
  ];

  const sanitized = { ...body } as Record<string, unknown>;

  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some((field) => lowerKey.includes(field))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof sanitized[key] === "object" && sanitized[key] !== null) {
      sanitized[key] = sanitizeRequestBody(sanitized[key]);
    }
  }

  return sanitized;
}

export function validateContentType(
  contentType: string | null,
  allowedTypes: string[] = ["application/json"]
): boolean {
  if (!contentType) return false;
  return allowedTypes.some((type) => contentType.toLowerCase().includes(type));
}

export function createCorsHeaders(
  origin?: string,
  options?: {
    allowedOrigins?: string[];
    allowedMethods?: string[];
    allowedHeaders?: string[];
    maxAge?: number;
    allowCredentials?: boolean;
  }
): Record<string, string> {
  const {
    allowedOrigins = ["*"],
    allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders = ["Content-Type", "Authorization", "X-Request-ID"],
    maxAge = 86400,
    allowCredentials = false,
  } = options || {};

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Headers": allowedHeaders.join(", "),
    "Access-Control-Max-Age": String(maxAge),
  };

  // Validate origin
  const requestOrigin = origin || "";
  if (allowedOrigins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (allowedOrigins.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    if (allowCredentials) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }

  return headers;
}

const rateLimitStore = new Map<string, { timestamps: number[] }>();

export function checkRateLimit(
  identifier: string,
  options?: {
    windowMs?: number;
    maxRequests?: number;
  }
): { allowed: boolean; remaining: number; resetTime: number } {
  const windowMs = options?.windowMs || 60000;
  const maxRequests = options?.maxRequests || 100;
  const now = Date.now();
  const windowStart = now - windowMs;

  let entry = rateLimitStore.get(identifier);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(identifier, entry);
  }

  entry.timestamps = entry.timestamps.filter(t => t > windowStart);
  entry.timestamps.push(now);

  const allowed = entry.timestamps.length <= maxRequests;
  const remaining = Math.max(0, maxRequests - entry.timestamps.length);
  const resetTime = entry.timestamps.length > 0 ? entry.timestamps[0] + windowMs : now + windowMs;

  if (!allowed) {
    logger.warn(`Rate limit exceeded for ${identifier}: ${entry.timestamps.length}/${windowMs}ms`);
  }

  return { allowed, remaining, resetTime };
}
