import { z } from "zod";
import { auditRulesSchema } from "../lib/audit-rules";

const fieldState = z.enum([
  "PRESENT",
  "NOT_SET",
  "NOT_SUPPORTED",
  "NOT_RETURNED",
  "PERMISSION_DENIED",
  "FETCH_FAILED",
  "NOT_APPLICABLE",
]);
const probabilities = z
  .record(z.string(), z.number().min(0).max(1))
  .refine((scores) => {
    const values = Object.values(scores);
    return (
      !values.length ||
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.02
    );
  });
const semanticDecision = z
  .looseObject({
    label: z.enum(["true", "false"]).nullable(),
    status: z.enum(["PASS", "REVIEW", "UNKNOWN"]),
    scores: probabilities,
    model_version: z.string().min(1),
    entity_id: z.string().min(1),
    reason: z.string(),
    source: z.string().min(1),
    candidates: z.record(z.string(), probabilities),
    criterion_version: z.string(),
    actual_configuration: z
      .object({
        value: z.boolean().nullable(),
        state: fieldState,
        sources: z.array(z.string()),
        reason: z.string(),
      })
      .optional(),
  })
  .refine(
    (decision) =>
      !Object.keys(decision.scores).length ||
      (Object.keys(decision.scores).length === 3 &&
        ["true", "false", "unknown"].every((key) =>
          Object.hasOwn(decision.scores, key),
        )),
  );
const dataRow = z.looseObject({
  key: z.string().min(1),
  platform: z.string().optional(),
  account: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  result: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  semantic: semanticDecision.optional(),
});
const searchResult = z
  .looseObject({
    message: z.string(),
    rows: z.array(dataRow),
    result_type: z.enum(["entities", "audit", "history"]).optional(),
    comparison: z.array(z.object({
      field: z.string(),
      values: z.record(z.string(), z.object({
        value: z.unknown(),
        state: fieldState,
        currency: z.string().nullable().optional(),
      })),
    })).optional(),
    warnings: z.array(z.string()).optional(),
    complete: z.boolean().optional(),
    comparable: z.boolean().optional(),
    status: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    unknown_count: z.number().int().nonnegative().optional(),
    semantic_decisions: z.record(z.string(), semanticDecision).optional(),
  })
  .superRefine((value, context) => {
    const keys = value.rows.map((row) => row.key);
    if (
      new Set(keys).size !== keys.length ||
      (value.count !== undefined && value.count < keys.length)
    )
      context.addIssue({
        code: "custom",
        message: "결과 개수와 행 식별자가 일치하지 않습니다.",
      });
    for (const [key, decision] of Object.entries(
      value.semantic_decisions ?? {},
    )) {
      const parts = key.split("/");
      if (
        parts.length !== 4 ||
        parts.some((part) => !part) ||
        JSON.stringify(parts) !== decision.entity_id
      )
        context.addIssue({
          code: "custom",
          message: "의미 판단의 원본 식별자가 일치하지 않습니다.",
        });
      if (decision.label !== null && decision.status === "UNKNOWN")
        context.addIssue({
          code: "custom",
          message: "판단 보류 상태에 확정 라벨이 있습니다.",
        });
    }
    for (const row of value.rows) {
      if (!row.semantic) continue;
      const decision = value.semantic_decisions?.[row.key];
      if (
        !decision ||
        decision.entity_id !== row.semantic.entity_id ||
        decision.label !== row.semantic.label ||
        decision.status !== row.semantic.status ||
        decision.model_version !== row.semantic.model_version ||
        decision.source !== row.semantic.source ||
        ["true", "false", "unknown"].some(
          (key) => decision.scores[key] !== row.semantic!.scores[key],
        )
      )
        context.addIssue({
          code: "custom",
          message: "결과와 상세 의미 판단이 일치하지 않습니다.",
        });
    }
  });

export function validateResponse(
  path: string,
  value: unknown,
  method = "GET",
): asserts value is Record<string, unknown> | Record<string, unknown>[] {
  const endpoint = path
    .replace(/^\/api/, "")
    .split("?")[0]
    .replace(/\/$/, "");
  const snapshot = z.looseObject({
    snapshot_id: z.string().min(1),
    created_at: z.string(),
    entity_count: z.number().int().nonnegative(),
    complete: z.boolean(),
    errors: z.array(z.string()),
    timezone: z.string(),
  });
  const policyVersion = z.looseObject({
    policy_id: z.string().min(1),
    name: z.string(),
    version: z.number().int().positive(),
  });
  const auditSummary = z.looseObject({
    run_id: z.string().min(1),
    at: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
  });
  const list =
    endpoint === "/snapshots" && method === "GET"
      ? snapshot
      : endpoint === "/audits" && method === "GET"
        ? auditSummary
        : /^\/policies\/[^/]+\/versions$/.test(endpoint)
          ? policyVersion
          : null;
  if (list) {
    if (!z.array(list).safeParse(value).success)
      throw new Error("목록을 불러오지 못했습니다. 다시 조회해 주세요.");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("데이터를 불러오지 못했습니다. 다시 시도해 주세요.");
  if (endpoint === "/audit-rules" && !auditRulesSchema.safeParse(value).success)
    throw new Error("검사 항목을 불러오지 못했습니다. 다시 시도해 주세요.");
  if (
    endpoint === "/snapshots" &&
    method === "POST" &&
    !snapshot.safeParse(value).success
  )
    throw new Error(
      "저장한 설정을 확인하지 못했습니다. 목록을 새로고침해 주세요.",
    );
  if (endpoint === "/ask" && !searchResult.safeParse(value).success)
    throw new Error("검색 결과를 불러오지 못했습니다. 다시 검색해 주세요.");
}
