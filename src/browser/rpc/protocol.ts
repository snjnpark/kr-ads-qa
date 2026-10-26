import { z } from "../../lib/validation";
import { csvText } from "../../lib/csv";
import { NAMES } from "../credentials";
import { PLATFORMS } from "../../domain/entities";
import { policyYaml } from "../../domain/policies/schema";
import type { Policy } from "../../contracts/policy";

export const MAX_BODY_BYTES = 2_000_000;
const COOKIE_NAME = "laya_browser_session";
export const SESSION_TTL = 12 * 60 * 60 * 1000;
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
const sensitiveKeys = new Set(
  [
    "authorization",
    "password",
    "secret",
    "token",
    "apikey",
    "secretkey",
    ...Object.values(NAMES).flat(),
  ].map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "")),
);
export function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))
          ? "[redacted]"
          : publicData(item),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(
        /([?&])([^=&#\s]+)=([^&#\s]*)/g,
        (match, separator: string, key: string) => {
          let decoded: string;
          try { decoded = decodeURIComponent(key); } catch { return match; }
          return sensitiveKeys.has(decoded.toLowerCase().replace(/[^a-z0-9]/g, ""))
            ? `${separator}${key}=[redacted]`
            : match;
        },
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  return value;
}
export function json(value: unknown, status = 200): Response {
  return Response.json(publicData(value), { status });
}
export function validateRequestOrigin(_request: Request): void { /* Local Worker RPC only; no HTTP listener. */ }
export function equalToken(first: string | null, second: string): boolean { return first !== null && first === second; }
export function cookieValue(request: Request): string | null {
  // Browser Request strips Cookie. This handler runs only inside the tab Worker;
  // use a local RPC header, never an HTTP authentication mechanism.
  const localSession = request.headers.get("x-laya-worker-session");
  if (localSession) return localSession;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return null;
}
export function headers(
  response: Response,
  request: Request,
  cookie?: string,
): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  if (cookie)
    response.headers.set("X-Laya-Worker-Session", cookie);
  if (cookie)
    response.headers.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
    );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  )
    throw new ApiError(
      /^\d+$/.test(declared) ? 413 : 400,
      "요청 크기와 형식을 확인해 주세요.",
    );
  const type = request.headers.get("content-type");
  if (type && !/^application\/json(?:\s*;|$)/i.test(type))
    throw new ApiError(415, "JSON 형식으로 요청해 주세요.");
  const reader = request.body?.getReader();
  if (!reader) return {};
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(
          413,
          "요청이 너무 큽니다. 범위를 줄여 다시 시도해 주세요.",
        );
      }
      parts.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) return {};
  try {
    const source = new Uint8Array(length);
    let offset = 0; for (const part of parts) { source.set(part, offset); offset += part.length; }
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    );
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error();
    return data;
  } catch {
    throw new ApiError(400, "JSON 입력 형식을 확인해 주세요.");
  }
}
export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(422, "입력값을 확인해 주세요.");
  return result.data;
}
export const accountId = z
  .string()
  .min(1)
  .max(250)
  .refine((value) => !!value.trim() && !/[\r\n\0]/.test(value));
export const scopeShape = {
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).optional(),
  accounts: z.array(accountId).max(500).optional(),
  products: z.array(z.string().regex(/^(?:naver|kakao|kakao_keyword|google):[A-Z][A-Z0-9_]*$/)).max(100).optional(),
};
export const scopeSchema = z.strictObject(scopeShape);
export const syncSchema = z.strictObject({
  ...scopeShape,
  force: z.boolean().default(false),
});
export const policyText = z.strictObject({ yaml: z.string().min(1).max(1_000_000) });
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const settingsSchema = z.strictObject({
  mode: z.literal("live").optional(),
  ai_mode: z.literal("laya").optional(),
  mock_dataset: z.never().optional(),
  cache_ttl_seconds: z.number().int().min(0).max(86400).optional(),
  batch_size: z.number().int().min(1).max(256).optional(),
  semantic_threshold: z.number().min(0.5).max(1).optional(),
  timezone: z.string().min(1).max(100).optional(),
  snapshot_interval_seconds: z.number().int().min(0).max(604800).optional(),
  preload_model: z.boolean().optional(),
  inference_backend: z.literal("onnx").optional(),
  onnx_directory: z.string().min(1).max(1024).optional(),
  cpu_threads: z.number().int().min(1).max(64).optional(),
});
export const policyData = (policy: Policy) => ({
  ...policy,
  yaml: policyYaml(policy),
});
export const snapshotSummary = (snapshot: {
  snapshot_id: string;
  created_at: string;
  entities: unknown[];
  complete: boolean;
  errors: string[];
  timezone: string;
  scope?: { platforms?: string[]; accounts?: string[]; products?: string[] };
}) => ({
  snapshot_id: snapshot.snapshot_id,
  created_at: snapshot.created_at,
  entity_count: snapshot.entities.length,
  complete: snapshot.complete,
  errors: snapshot.errors,
  timezone: snapshot.timezone,
  scope: snapshot.scope,
});
export function csvBytes(
  original: Record<string, unknown>[],
): Uint8Array<ArrayBuffer> {
  const rows = publicData(original) as Record<string, unknown>[];
  return new TextEncoder().encode(`${csvText(rows)}\r\n`);
}
