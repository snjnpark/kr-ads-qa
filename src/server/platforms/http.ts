import type { FieldState, Json } from "../models";
import { PlatformError } from "./base";
export type FetchLike = typeof fetch;
type RequestOptions = {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
};
export class ReadOnlyHTTP {
  constructor(
    readonly routes: Record<string, [string, RegExp][]>,
    readonly transport: FetchLike = fetch,
    readonly retries = 2,
  ) {}
  async request(
    method: string,
    input: string,
    options: RequestOptions = {},
  ): Promise<any> {
    const url = new URL(input);
    const allowed = this.routes[url.origin]?.some(
      ([verb, pattern]) => verb === method && pattern.test(url.pathname),
    );
    if (
      !allowed ||
      url.search ||
      url.username ||
      url.password ||
      url.port ||
      url.protocol !== "https:"
    )
      throw new PlatformError(
        "WRITE_BLOCKED",
        "허용된 광고 조회 및 인증 요청만 실행할 수 있습니다.",
      );
    if (url.hostname === "googleads.googleapis.com" && method === "POST") {
      const query = (options.json as Json)?.query;
      if (
        typeof query !== "string" ||
        !/^\s*SELECT\s/i.test(query) ||
        query.includes(";")
      )
        throw new PlatformError(
          "WRITE_BLOCKED",
          "Google Ads 조회 쿼리만 허용됩니다.",
        );
    }
    for (const [key, value] of Object.entries(options.params || {}))
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value));
    const headers = {
      ...options.headers,
      ...(options.json !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.form
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    };
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          ...(options.json !== undefined
            ? { body: JSON.stringify(options.json) }
            : {}),
          ...(options.form
            ? { body: new URLSearchParams(options.form).toString() }
            : {}),
        });
      } catch {
        if (attempt < this.retries) {
          await delay(attempt);
          continue;
        }
        throw new PlatformError(
          "NETWORK_ERROR",
          "광고 API에 연결하지 못했습니다.",
        );
      }
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const code =
        typeof payload?.error === "object"
          ? payload.error?.code
          : payload?.code;
      const metaRateLimit =
        url.hostname === "graph.facebook.com" &&
        [4, 17, 32, 613].includes(code);
      if (
        (response.status === 429 || response.status >= 500 || metaRateLimit) &&
        attempt < this.retries
      ) {
        const retry = response.headers.get("retry-after");
        await new Promise((r) =>
          setTimeout(
            r,
            retry && /^\d+$/.test(retry)
              ? Math.min(Number(retry), 10) * 1000
              : 100 * 2 ** attempt,
          ),
        );
        continue;
      }
      if (
        response.status >= 400 ||
        payload?.error ||
        (url.hostname.includes("kakao.com") &&
          typeof code === "number" &&
          code < 0)
      ) {
        let kind =
          (
            {
              401: "AUTHENTICATION",
              403: "PERMISSION_DENIED",
              429: "RATE_LIMIT",
            } as Record<number, string>
          )[response.status] || "API_ERROR";
        if (url.hostname === "graph.facebook.com")
          kind = [102, 104, 190].includes(code)
            ? "AUTHENTICATION"
            : [10, 200].includes(code)
              ? "PERMISSION_DENIED"
              : metaRateLimit
                ? "RATE_LIMIT"
                : kind;
        if (["oauth2.googleapis.com", "kauth.kakao.com"].includes(url.hostname))
          kind = "AUTHENTICATION";
        if (url.hostname.includes("kakao.com"))
          kind =
            code === -401
              ? "AUTHENTICATION"
              : [-402, -403].includes(code)
                ? "PERMISSION_DENIED"
                : kind;
        throw new PlatformError(
          kind,
          `광고 API 요청 실패 (HTTP ${response.status}).`,
        );
      }
      if (response.status >= 300)
        throw new PlatformError(
          "API_ERROR",
          "광고 API의 예기치 않은 리다이렉트입니다.",
        );
      if (payload === null)
        throw new PlatformError(
          "INVALID_RESPONSE",
          "광고 API 응답 형식이 올바르지 않습니다.",
        );
      return payload;
    }
    throw new PlatformError("NETWORK_ERROR", "광고 API에 연결하지 못했습니다.");
  }
}
const delay = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
export const fieldState = (raw: Json, key: string): FieldState =>
  !(key in raw) ? "NOT_RETURNED" : raw[key] == null ? "NOT_SET" : "PRESENT";
export function decimalValue(value: unknown, divisor = 1): string | null {
  if (value == null) return null;
  if (typeof value !== "number" && typeof value !== "string")
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 금액의 자료형이 올바르지 않습니다.",
    );
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new PlatformError(
      "INVALID_RESPONSE",
      "예산 숫자의 정밀도를 확인할 수 없습니다.",
    );
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || !Number.isSafeInteger(divisor) || divisor <= 0)
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 금액 형식이 올바르지 않습니다.",
    );
  let numerator = BigInt(match[2] + (match[3] || "")),
    denominator = BigInt(divisor) * 10n ** BigInt((match[3] || "").length);
  const whole = numerator / denominator;
  numerator %= denominator;
  let fraction = "";
  while (numerator && fraction.length < 32) {
    numerator *= 10n;
    fraction += String(numerator / denominator);
    numerator %= denominator;
  }
  if (numerator)
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 금액의 단위를 정확히 변환할 수 없습니다.",
    );
  return `${match[1] === "-" && (whole || fraction) ? "-" : ""}${whole}${fraction ? "." + fraction.replace(/0+$/, "") : ""}`;
}
export function zonedParts(instant: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  return Object.fromEntries(
    parts
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}
export function timestamp(value: unknown, zone?: string | null): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string")
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 시각은 문자열이어야 합니다.",
    );
  const text = value;
  const components =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|[+-](\d{2}):?(\d{2}))?$/i.exec(
      text,
    );
  if (
    !components ||
    Number(components[1]) < 100 ||
    Number(components[2]) < 1 ||
    Number(components[2]) > 12 ||
    Number(components[3]) < 1 ||
    Number(components[3]) >
      new Date(
        Date.UTC(Number(components[1]), Number(components[2]), 0),
      ).getUTCDate() ||
    Number(components[4] || 0) > 23 ||
    Number(components[5] || 0) > 59 ||
    Number(components[6] || 0) > 59 ||
    Number(components[8] || 0) > 23 ||
    Number(components[9] || 0) > 59
  )
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 시각의 날짜 또는 시간이 올바르지 않습니다.",
    );
  if (/(?:Z|[+-]\d\d:?\d\d)$/i.test(text)) {
    const result = new Date(text);
    if (!Number.isFinite(+result))
      throw new PlatformError(
        "INVALID_RESPONSE",
        "광고 시각 형식이 올바르지 않습니다.",
      );
    return result.toISOString();
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(
      text,
    );
  if (!match || !zone)
    throw new PlatformError(
      "INVALID_RESPONSE",
      "광고 시각을 해석할 시간대를 확인하지 못했습니다.",
    );
  const values = match.slice(1, 7).map((n) => Number(n || 0)),
    local = Date.UTC(
      values[0],
      values[1] - 1,
      values[2],
      values[3],
      values[4],
      values[5],
    ),
    millis = Number((match[7] || "").slice(0, 3).padEnd(3, "0"));
  let candidate = local;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(candidate, zone);
    const offset =
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
      candidate;
    candidate = local - offset;
  }
  const matches = [
    candidate - 7200000,
    candidate - 3600000,
    candidate,
    candidate + 3600000,
    candidate + 7200000,
  ].filter((t) => {
    const p = zonedParts(t, zone);
    return [p.year, p.month, p.day, p.hour, p.minute, p.second].every(
      (n, index) => n === values[index],
    );
  });
  if (matches.length !== 1)
    throw new PlatformError(
      matches.length ? "AMBIGUOUS_TIME" : "INVALID_RESPONSE",
      "광고 시각이 시간대 경계에서 모호하거나 존재하지 않습니다.",
    );
  return new Date(matches[0] + millis).toISOString();
}
export function validateHistoryRange(start: Date, end: Date, days?: number) {
  if (
    !(start instanceof Date) ||
    !(end instanceof Date) ||
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +start >= +end ||
    +end > Date.now() ||
    (days && +start < Date.now() - days * 86400000)
  )
    throw new Error(
      days
        ? `최근 ${days}일 이내의 과거 범위를 입력해 주세요.`
        : "과거의 유효한 시작·종료 범위를 입력해 주세요.",
    );
}
