const randomBytes = (size: number) => ({ toString: (_encoding: string) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") });
import { z } from "../lib/validation";
import { setOperationSignal } from "./operation-context";
import { BrowserApplication as Application } from "./application";
import { readSettings, saveSettings } from "./settings";
import { validateScope } from "../server/application/scope";
import { NAMES, saveCredentials } from "./credentials";
import { queryNativeHistory } from "../server/history";
import { PLATFORMS, type Json, type Settings } from "../server/models";
import { loadPolicy, policyYaml } from "../server/policies/schema";
import type { Policy } from "../contracts/policy";
import { auditRulesSchema } from "../lib/audit-rules";
import { emptyContext, type QueryContext } from "../server/query";
import { RuleBuilder, type RuleDraft } from "./rules";

export const MAX_BODY_BYTES = 2_000_000;
const COOKIE_NAME = "laya_browser_session";
const SESSION_TTL = 12 * 60 * 60 * 1000;
type TabSession = {
  context: QueryContext;
  draft: RuleDraft | null;
  touched: number;
};
type BrowserSession = {
  csrf: string;
  tabs: Map<string, TabSession>;
  touched: number;
};
type ApiOptions = {
  credentialsWriter?: typeof saveCredentials;
  settingsReader?: () => Settings;
  settingsWriter?: (values: Json, active: Settings) => unknown;
  now?: () => number;
  maxSessions?: number;
  maxTabs?: number;
};
class ApiError extends Error {
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
function json(value: unknown, status = 200): Response {
  return Response.json(publicData(value), { status });
}
function validateRequestOrigin(_request: Request): void { /* Local Worker RPC only; no HTTP listener. */ }
function equalToken(first: string | null, second: string): boolean { return first !== null && first === second; }
function cookieValue(request: Request): string | null {
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
function headers(
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
async function readBody(request: Request): Promise<Record<string, unknown>> {
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
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(422, "입력값을 확인해 주세요.");
  return result.data;
}
const accountId = z
  .string()
  .min(1)
  .max(250)
  .refine((value) => !!value.trim() && !/[\r\n\0]/.test(value));
const scopeShape = {
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).optional(),
  accounts: z.array(accountId).max(500).optional(),
  products: z.array(z.string().regex(/^(?:naver|kakao|kakao_keyword|google):[A-Z][A-Z0-9_]*$/)).max(100).optional(),
};
const scopeSchema = z.strictObject(scopeShape);
const syncSchema = z.strictObject({
  ...scopeShape,
  force: z.boolean().default(false),
});
const policyText = z.strictObject({ yaml: z.string().min(1).max(1_000_000) });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const settingsSchema = z.strictObject({
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
const policyData = (policy: Policy) => ({
  ...policy,
  yaml: policyYaml(policy),
});
const snapshotSummary = (snapshot: {
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
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  function cell(value: unknown): string {
    let text =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (/^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }
  return new TextEncoder().encode(
    `\uFEFF${[columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell(Object.hasOwn(row, column) ? row[column] : undefined)).join(","))].join("\r\n")}\r\n`,
  );
}

export function createApi(
  application: Application | (() => Promise<Application>),
  options: ApiOptions = {},
) {
  const sessions = new Map<string, BrowserSession>();
  const now = options.now ?? Date.now;
  const writer = options.credentialsWriter ?? saveCredentials;
  const maxSessions = options.maxSessions ?? 256,
    maxTabs = options.maxTabs ?? 32;
  const app = () =>
    typeof application === "function"
      ? application()
      : Promise.resolve(application);
  return async function handle(request: Request): Promise<Response> {
    let fresh: string | undefined;
    try {
      validateRequestOrigin(request);
      if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(request.method))
        throw new ApiError(405, "지원하지 않는 요청 방식입니다.");
      const time = now();
      for (const [id, session] of sessions)
        if (time - session.touched >= SESSION_TTL) sessions.delete(id);
      let id = cookieValue(request),
        session = id ? sessions.get(id) : undefined;
      if (
        !["GET", "HEAD"].includes(request.method) &&
        (!session ||
          !equalToken(request.headers.get("x-csrf-token"), session.csrf))
      )
        throw new ApiError(
          403,
          "앱을 새로고침한 뒤 다시 시도해 주세요.",
          "SESSION_EXPIRED",
        );
      if (!session) {
        if (sessions.size >= maxSessions)
          sessions.delete(
            [...sessions].sort((a, b) => a[1].touched - b[1].touched)[0][0],
          );
        id = randomBytes(32).toString("base64url");
        session = {
          csrf: randomBytes(32).toString("base64url"),
          tabs: new Map(),
          touched: time,
        };
        sessions.set(id, session);
        fresh = id;
      }
      session.touched = time;
      const tabId = request.headers.get("x-laya-tab") ?? "default";
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(tabId))
        throw new ApiError(
          400,
          "화면 식별자가 올바르지 않습니다. 앱을 새로고침해 주세요.",
        );
      let tab = session.tabs.get(tabId);
      if (!tab) {
        if (session.tabs.size >= maxTabs)
          session.tabs.delete(
            [...session.tabs].sort((a, b) => a[1].touched - b[1].touched)[0][0],
          );
        tab = { context: emptyContext(), draft: null, touched: time };
        session.tabs.set(tabId, tab);
      }
      tab.touched = time;
      const url = new URL(request.url);
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        throw new ApiError(400, "요청 경로를 확인해 주세요.");
      }
      if (!path.startsWith("/api/") || path.includes("\0"))
        throw new ApiError(404, "요청한 기능을 찾을 수 없습니다.");
      path = path.slice(4).replace(/\/$/, "");
      const method = request.method === "HEAD" ? "GET" : request.method;
      const body = method === "GET" ? {} : await readBody(request);
      const service = await app();
      const activeTab = tab;
      const response = await service.mutex.run(async () => {
        const previousContext = structuredClone(activeTab.context), previousDraft = structuredClone(activeTab.draft);
        try { const result = await service.storage.atomic(async () => {
        setOperationSignal(request.signal);
        if (service.hydratedRevision !== service.storage.revision) await service.initialize();
        if (method === "GET" && path === "/state") {
          const scope = validateScope(
            parsed(scopeSchema, {
              ...(url.searchParams.has("platforms")
                ? { platforms: url.searchParams.getAll("platforms") }
                : {}),
              ...(url.searchParams.has("accounts")
                ? { accounts: url.searchParams.getAll("accounts") }
                : {}),
              ...(url.searchParams.has("products")
                ? { products: url.searchParams.getAll("products") }
                : {}),
            }),
          );
          await service.ensureScope(scope);
          return json({ ...service.state(), csrf_token: session.csrf });
        }
        if (method === "POST" && path === "/sync") {
          const input = parsed(syncSchema, body);
          await service.sync(validateScope(input), input.force);
          return json({ ...service.state(), csrf_token: session.csrf });
        }
        if (method === "GET" && path === "/audit-rules")
          return json(service.policies.auditRules());
        if (method === "PUT" && path === "/audit-rules") {
          const configuration = parsed(auditRulesSchema, body);
          if (configuration.version !== service.policies.auditRules().version)
            throw new ApiError(409, "검사 항목이 변경되었습니다. 최신 설정을 다시 불러와 주세요.");
          return json(service.policies.saveAuditRules(configuration));
        }
        if (method === "POST" && path === "/ask") {
          const input = parsed(
            z.strictObject({
              ...scopeShape,
              text: z.string().trim().min(1).max(2000),
            }),
            body,
          );
          return json(
            await service.ask(input.text, tab.context, validateScope(input)),
          );
        }
        if (method === "POST" && path === "/audit") {
          const input = parsed(
            z.strictObject({
              ...scopeShape,
              policy_id: z.string().min(1).max(80).nullable().optional(),
              rule_ids: z.array(z.string().max(80)).min(1).max(1000).optional(),
            }),
            body,
          );
          const scope = validateScope(input);
          await service.sync(scope);
          return json(
            service.audit(scope, input.policy_id ?? undefined, input.rule_ids),
          );
        }
        if (method === "POST" && path === "/anomalies") {
          const scope = validateScope(parsed(scopeSchema, body));
          await service.sync(scope);
          return json(service.anomalies(scope));
        }
        if (method === "GET" && path.startsWith("/entities/")) {
          const key = path.slice("/entities/".length);
          const entity = service.entities.find((entity) => entity.key === key);
          if (!entity)
            throw new ApiError(404, "선택한 광고 항목을 찾을 수 없습니다.");
          return json(entity);
        }
        if (method === "GET" && path === "/audits")
          return json(
            service.storage
              .list<Json>("audit_runs")
              .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
          );
        if (method === "GET" && path.startsWith("/audits/"))
          return json(service.getAudit(path.slice("/audits/".length)));
        if (method === "GET" && path === "/policies")
          return json({
            policies: service.policies.list().map(policyData),
            bindings: service.policies.bindings(),
          });
        if (method === "POST" && path === "/policies/validate")
          return json(policyData(loadPolicy(parsed(policyText, body).yaml)));
        if (method === "POST" && path === "/policies/bind") {
          const input = parsed(
            z.strictObject({
              platform: z.enum(PLATFORMS),
              account_id: accountId,
              policy_id: z.string().min(1).max(80),
            }),
            body,
          );
          service.policies.bind(
            input.platform,
            input.account_id,
            input.policy_id,
          );
          return json({
            bindings: service.policies.bindings(),
            message: "계정에 정책을 연결했습니다.",
          });
        }
        if (method === "POST" && path === "/policies")
          return json(
            policyData(
              service.policies.create(
                loadPolicy(parsed(policyText, body).yaml),
              ),
            ),
            201,
          );
        const policyMatch = path.match(
          /^\/policies\/([^/]+)(?:\/(versions|clone))?$/,
        );
        if (policyMatch) {
          const [, policyId, action] = policyMatch;
          if (method === "GET" && action === "versions")
            return json(service.policies.versions(policyId).map(policyData));
          if (method === "GET" && !action) {
            const requested = url.searchParams.get("version");
            const version = requested === null ? undefined : Number(requested);
            if (
              version !== undefined &&
              (!Number.isSafeInteger(version) || version < 1)
            )
              throw new ApiError(400, "정책 버전을 확인해 주세요.");
            return json(policyData(service.policies.get(policyId, version)));
          }
          if (method === "PUT" && !action) {
            const policy = loadPolicy(parsed(policyText, body).yaml);
            if (policy.policy_id !== policyId)
              throw new ApiError(
                400,
                "선택한 정책과 입력한 정책 ID가 다릅니다.",
              );
            return json(policyData(service.policies.update(policy)));
          }
          if (method === "DELETE" && !action) {
            service.policies.delete(policyId);
            return json({
              message: "정책을 삭제했습니다. 이전 버전은 이력에 보관됩니다.",
            });
          }
          if (method === "POST" && action === "clone") {
            const input = parsed(
              z.strictObject({
                new_id: z.string().min(1).max(80),
                name: z.string().max(200).optional(),
              }),
              body,
            );
            return json(
              policyData(
                service.policies.clone(policyId, input.new_id, input.name),
              ),
              201,
            );
          }
        }
        if (method === "GET" && path === "/snapshots")
          return json(service.snapshots.list().map(snapshotSummary));
        if (method === "POST" && path === "/snapshots") {
          const input = parsed(syncSchema, body);
          await service.sync(validateScope(input), input.force);
          return json(service.saveSnapshot(), 201);
        }
        if (method === "POST" && path === "/history/compare") {
          const input = parsed(
            z.strictObject({
              ...scopeShape,
              before_id: z.string().min(1).max(80),
              after_id: z.string().min(1).max(80),
            }),
            body,
          );
          return json(
            await service.compareHistory(
              input.before_id,
              input.after_id,
              validateScope(input),
            ),
          );
        }
        if (method === "POST" && path === "/history/native") {
          const input = parsed(
            z.strictObject({
              ...scopeShape,
              start: z.string().min(1).max(100),
              end: z.string().min(1).max(100),
            }),
            body,
          );
          return json(
            await queryNativeHistory(
              service,
              input.start,
              input.end,
              validateScope(input),
            ),
          );
        }
        if (method === "POST" && path === "/policies/draft") {
          const input = parsed(z.strictObject({
            yaml: z.string().min(1).max(1_000_000),
            text: z.string().trim().min(1).max(2000),
          }), body);
          try {
            const policy = loadPolicy(input.yaml);
            const draft = await new RuleBuilder(service.policies).preview(input.text, policy.policy_id, undefined, policy);
            return json(draft);
          } catch (error) {
            throw new ApiError(400, `정책 초안을 확인해 주세요: ${(error as Error).message.slice(0, 700)}`);
          }
        }
        if (method === "POST" && path === "/rules/preview") {
          const input = parsed(
            z.strictObject({
              text: z.string().trim().min(1).max(2000),
              policy_id: z.string().min(1).max(80).default("default"),
            }),
            body,
          );
          // The form already selects rule creation; bounded templates still require exact approval.
          const builder = new RuleBuilder(service.policies);
          tab.draft = await builder.preview(input.text, input.policy_id);
          return json(tab.draft);
        }
        if (
          method === "POST" &&
          (path === "/rules/test" || path === "/rules/approve")
        ) {
          const input =
            path === "/rules/test"
              ? parsed(
                  z.strictObject({ ...scopeShape, digest: digestSchema }),
                  body,
                )
              : parsed(
                  z.strictObject({
                    digest: digestSchema,
                    approved: z.literal(true),
                  }),
                  body,
                );
          if (!tab.draft || tab.draft.digest !== input.digest)
            throw new ApiError(
              400,
              "먼저 이 화면에서 규칙 미리보기를 생성해 주세요.",
            );
          if (path === "/rules/approve") {
            const saved = await new RuleBuilder(service.policies).save(
              tab.draft,
              true,
              input.digest,
            );
            tab.draft = null;
            return json({
              policy: policyData(saved),
              message: "승인한 규칙을 정책에 저장했습니다.",
            });
          }
          const scope = validateScope(input);
          await service.sync(scope);
          const draft = tab.draft;
          let policy = service.policies
            .list()
            .find((policy) => policy.policy_id === draft.policy_id);
          policy = policy
            ? loadPolicy({ ...policy, rules: [draft.rule] })
            : loadPolicy({
                policy_id: draft.policy_id,
                name: "규칙 검증",
                rules: [draft.rule],
              });
          const { customRuleResults } = await import("../server/policies");
          const selected = service.entities.filter(
            (entity) =>
              (!scope.platforms?.length ||
                scope.platforms.includes(entity.platform)) &&
              (!scope.accounts?.length ||
                scope.accounts.includes(entity.account_id) ||
                scope.accounts.includes(
                  `${entity.platform}/${entity.account_id}`,
                )),
          );
          const results = selected.flatMap((entity) =>
            customRuleResults(entity, service.entities, policy),
          );
          const rows = service.auditRows(
            `preview/${draft.digest.slice(0, 12)}`,
            results,
          );
          return json({
            rows,
            status: "REVIEW",
            message: `${selected.length}개 설정으로 규칙을 검증했습니다. 저장 전 검사 결과를 확인해 주세요.`,
            coverage: { ...service.coverage, evaluated_count: selected.length },
          });
        }
        if (method === "GET" && path === "/settings") {
          const pending = options.settingsReader ? options.settingsReader() : readSettings();
          return json({
            settings: pending,
            active_settings: service.settings,
            restart_required:
              JSON.stringify(pending) !== JSON.stringify(service.settings),
          });
        }
        if (method === "PUT" && path === "/settings") {
          const input = parsed(settingsSchema, body);
          try {
            return json(
              (options.settingsWriter ?? saveSettings)(input, service.settings),
            );
          } catch {
            throw new ApiError(
              400,
              "설정을 저장하지 못했습니다. 시간대와 입력 범위를 확인해 주세요.",
            );
          }
        }
        if (method === "POST" && path === "/cache/clear") {
          parsed(z.strictObject({}), body);
          return json(service.clearCache());
        }
        if (method === "GET" && path === "/credentials/schema")
          return json({ platforms: NAMES });
        const credentialsMatch = path.match(/^\/credentials\/([^/]+)$/);
        if (method === "POST" && credentialsMatch) {
          const platform = parsed(z.enum(PLATFORMS), credentialsMatch[1]);
          const input = parsed(
            z.strictObject({
              values: z
                .record(z.string(), z.string().min(1).max(65536))
                .refine((values) => {
                  const entries = Object.entries(values);
                  return (
                    entries.length > 0 &&
                    entries.length <= 10 &&
                    entries.every(
                      ([key, value]) =>
                        NAMES[platform].includes(key) &&
                        !!value.trim() &&
                        !/[\r\n\0]/.test(value),
                    )
                  );
                }),
            }),
            body,
          );
          try {
            await writer(platform, input.values);
          } catch {
            throw new ApiError(400, "인증 정보를 저장하지 못했습니다.");
          }
          return json({
            message:
              "인증 정보는 이 탭의 메모리에만 보관합니다. 데이터를 새로고침해 연결을 확인하세요.",
          });
        }
        if (method === "POST" && path === "/export") {
          const input = parsed(
            z.strictObject({
              rows: z.array(z.record(z.string(), z.unknown())).max(20000),
            }),
            body,
          );
          return new Response(csvBytes(input.rows), {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="laya_ads_qa.csv"',
            },
          });
        }
        throw new ApiError(404, "요청한 기능을 찾을 수 없습니다.");
      }, { signal: request.signal });
          service.hydratedRevision = service.storage.revision;
          return result;
        } catch (error) {
          activeTab.context = previousContext; activeTab.draft = previousDraft;
          await service.storage.reload();
          await service.initialize();
          throw error;
        } finally { setOperationSignal(); }
      });
      return headers(response, request, fresh);
    } catch (error) {
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof Error &&
              /^[가-힣]/.test(error.message) &&
              error.message.length <= 1000
            ? 400
            : 500;
      const message =
        error instanceof ApiError
          ? error.message
          : status === 400
            ? (error as Error).message
            : "작업을 완료하지 못했습니다. 연결 상태와 입력값을 확인해 주세요.";
      return headers(
        json(
          {
            message,
            ...(error instanceof ApiError && error.code
              ? { code: error.code }
              : {}),
          },
          status,
        ),
        request,
        fresh,
      );
    }
  };
}
