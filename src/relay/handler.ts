import { buildRelayRequest, RelayInputError } from "./contract";

export const RELAY_LIMITS = { requestBytes: 16 * 1024, responseBytes: 3 * 1024 * 1024, timeoutMs: 20000, concurrency: 32 } as const;
const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
let activeRequests = 0; // A count only: never keys, account IDs or response data.
class RelayFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function failure(code: string, status: number) {
  return new Response(JSON.stringify({ error: { code } }), { status, headers: responseHeaders });
}
const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
function secureOrigin(origin: URL) {
  return origin.protocol === "https:" || (origin.protocol === "http:" && loopbackHosts.includes(origin.hostname));
}
function validateOrigin(request: Request, publicOrigin?: string) {
  const url = new URL(request.url), rawOrigin = request.headers.get("origin");
  if (!rawOrigin || url.pathname !== "/api/relay" || url.search) throw new RelayFailure("ORIGIN_REJECTED", 403);
  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { throw new RelayFailure("ORIGIN_REJECTED", 403); }
  let configuredOrigin: string | undefined;
  if (publicOrigin) {
    const configured = publicOrigin.trim();
    let parsed: URL;
    try { parsed = new URL(configured); } catch { throw new RelayFailure("RELAY_CONFIGURATION", 503); }
    if (configured !== parsed.origin || !secureOrigin(parsed)) throw new RelayFailure("RELAY_CONFIGURATION", 503);
    configuredOrigin = parsed.origin;
  }
  // NextRequest canonicalizes loopback URLs; only the exact browser Host can restore their origin.
  const normalizedLoopback = loopbackHosts.includes(url.hostname) && loopbackHosts.includes(origin.hostname) &&
    url.protocol === origin.protocol && url.port === origin.port && request.headers.get("host") === origin.host;
  // Never trust X-Forwarded-Host/Origin to widen the allowed target.
  if (!secureOrigin(origin) || rawOrigin !== origin.origin || (origin.origin !== url.origin && origin.origin !== configuredOrigin && !normalizedLoopback) || (request.headers.has("host") && request.headers.get("host") !== origin.host)) throw new RelayFailure("ORIGIN_REJECTED", 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new RelayFailure("ORIGIN_REJECTED", 403);
  if (request.headers.get("x-laya-relay") !== "1") throw new RelayFailure("ORIGIN_REJECTED", 403);
}
async function bytes(response: { body: ReadableStream<Uint8Array> | null; headers: Headers }, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new RelayFailure("BODY_TOO_LARGE", 413);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { void reader.cancel().catch(() => {}); rejectAbort(new RelayFailure("REQUEST_CANCELLED", 504)); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw new RelayFailure("REQUEST_CANCELLED", 504);
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new RelayFailure("REQUEST_CANCELLED", 504);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new RelayFailure("BODY_TOO_LARGE", 413);
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A cancelled pending reader is already closed. */ }
  }
}
/** One stateless read. No Node application, disk IO, persistence, cookies or logging. */
export async function handleRelay(request: Request, transport: typeof fetch = fetch, options: { publicOrigin?: string } = {}): Promise<Response> {
  let entered = false;
  const upstreamAbort = new AbortController();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(RELAY_LIMITS.timeoutMs), upstreamAbort.signal]);
  try {
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", 405);
    validateOrigin(request, options.publicOrigin ?? process.env.LAYA_PUBLIC_ORIGIN);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "")) return failure("JSON_REQUIRED", 415);
    if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") return failure("ENCODING_REJECTED", 415);
    if (activeRequests >= RELAY_LIMITS.concurrency) return failure("RELAY_BUSY", 429);
    activeRequests++; entered = true;
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(request, RELAY_LIMITS.requestBytes, signal))); }
    catch (error) { if (error instanceof RelayFailure) throw error; throw new RelayFailure("INVALID_RELAY_REQUEST", 400); }
    const upstream = buildRelayRequest(input);
    const response = await transport(upstream.url, {
      method: "GET", headers: { ...upstream.headers, Accept: "application/json" },
      cache: "no-store", credentials: "omit", redirect: "manual", signal,
      referrerPolicy: "no-referrer",
    });
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new RelayFailure("UPSTREAM_REDIRECT_REJECTED", 502); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = [401, 403, 429].includes(response.status) ? response.status : 502;
      const result = failure(status === 401 ? "UPSTREAM_AUTHENTICATION" : status === 403 ? "UPSTREAM_PERMISSION" : status === 429 ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_ERROR", status);
      const retry = response.headers.get("retry-after");
      if (retry && /^\d{1,3}$/.test(retry)) result.headers.set("Retry-After", String(Math.min(Number(retry), 60)));
      return result;
    }
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new RelayFailure("UPSTREAM_INVALID_RESPONSE", 502);
    let body: Uint8Array<ArrayBuffer>;
    try { body = await bytes(response, RELAY_LIMITS.responseBytes, signal); }
    catch (error) { if (error instanceof RelayFailure && error.code === "BODY_TOO_LARGE") throw new RelayFailure("UPSTREAM_RESPONSE_TOO_LARGE", 502); throw error; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new RelayFailure("UPSTREAM_INVALID_RESPONSE", 502); }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = payload as { error?: unknown; code?: unknown };
      if (value.error || (typeof value.code === "number" && value.code < 0))
        throw new RelayFailure("UPSTREAM_ERROR", 502);
    }
    if (signal.aborted) throw new RelayFailure("REQUEST_CANCELLED", 504);
    return new Response(body, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof RelayFailure) return failure(error.code, error.status);
    if (error instanceof RelayInputError) return failure("INVALID_RELAY_REQUEST", 400);
    if (signal.aborted) return failure("REQUEST_CANCELLED", 504);
    return failure("RELAY_FAILED", 502);
  } finally {
    upstreamAbort.abort();
    if (entered) activeRequests--;
  }
}
