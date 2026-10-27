import type { Scope } from "../../contracts/domain";
import type { QueryContext } from "./query";
import type { QueryPlan } from "./query-contract";
import type { QueryAnswerability } from "./query-answerability";
import type { GroundedQueryFilter } from "./query-evidence";
import type { QueryClause } from "./query-clauses";

export type QueryInput = {
  text: string;
  reference_time: number;
  timezone: string;
  scope: Scope;
  previous: {
    has_results: boolean;
    entity: string | null;
    platforms: QueryPlan["platforms"];
    scope: string | null;
  };
};
export type RequestEvidence = {
  id: string;
  role: "filter" | "logic" | "target_declaration" | "operation" | "entity" | "scope" | "reference" | "relation" | "semantic";
  owner: QueryPlan["entity"] | null;
  span: [number, number];
  text: string;
};
export type RequestObligation = {
  id: string;
  kind: RequestEvidence["role"];
  owner: RequestEvidence["owner"];
  evidence_ids: string[];
};
export type RequestCondition = {
  id: string;
  owner: RequestEvidence["owner"];
  filter: QueryPlan["filters"][number];
  evidence_id: string;
};
export type RequestSpec = {
  input: QueryInput;
  state: "ready" | "needs_clarification" | "unsupported";
  entity: QueryPlan["entity"] | null;
  operation: QueryPlan["operation"] | null;
  platforms: QueryPlan["platforms"];
  products: string[];
  reference: "all" | "previous" | "children";
  conditions: RequestCondition[];
  logic: QueryPlan["logical_operator"] | null;
  semantic: QueryPlan["semantic"];
  evidence: RequestEvidence[];
  obligations: RequestObligation[];
  model_fields: string[];
  unresolved: string[];
  ambiguities: string[];
  residual: string;
  data_requirements: string[];
};
export type ExecutionPlan = {
  query: QueryPlan & { products: string[] };
  steps: { kind: "scope" | "previous" | "children" | "filter" | "semantic" | "workflow" | "result"; obligation_ids: string[] }[];
  data_requirements: string[];
};
export type EvidenceResult = {
  plan: ExecutionPlan;
  scope: Scope;
  matched_keys: string[];
  unknown_keys: string[];
  rows: Record<string, unknown>[];
  count: number;
  unknown_count: number;
  complete: boolean;
  collected_at: string | null;
  reasons: Record<string, string>;
};

type ProjectionSource = {
  typed: {
    filters: GroundedQueryFilter[];
    logical_operator?: QueryPlan["logical_operator"];
    complete: boolean;
    unresolved: string[];
    ambiguities: string[];
    residual: string;
    logic_evidence: { logical_operator: QueryPlan["logical_operator"]; span: [number, number]; text: string }[];
  };
  request: QueryAnswerability;
  literalScope: { entity?: QueryPlan["entity"]; platforms: QueryPlan["platforms"]; reference?: "previous" | "children" };
  scopeEntity?: QueryPlan["entity"];
  products: string[];
  modelFields: string[];
  clauses: QueryClause[];
};

export function snapshotQueryInput(text: string, context: QueryContext | undefined, now: Date, timezone: string, scope: Scope = {}): QueryInput {
  return {
    text,
    reference_time: now.getTime(),
    timezone,
    scope: structuredClone(scope),
    previous: {
      has_results: context?.has_results ?? false,
      entity: context?.entity ?? null,
      platforms: [...(context?.platforms ?? [])],
      scope: context?.scope ?? null,
    },
  };
}

/** Passive projection only: ready preserves the old preparation state and does not authorize execution. */
export function projectPreparedRequest(input: QueryInput, source: ProjectionSource): RequestSpec {
  const owner = source.scopeEntity ?? null;
  const evidence: RequestEvidence[] = [
    ...source.typed.filters.map((fact, index): RequestEvidence => ({
      id: `filter:${index}`, role: "filter", owner, span: [...fact.span], text: fact.text,
    })),
    ...source.typed.logic_evidence.map((fact, index): RequestEvidence => ({
      id: `logic:${index}`, role: "logic", owner, span: [...fact.span], text: fact.text,
    })),
    ...source.clauses.map((clause, index): RequestEvidence => ({
      id: `declaration:${index}`, role: "target_declaration", owner, span: [...clause.span], text: clause.text,
    })),
  ];
  return {
    input: structuredClone(input),
    state: source.request.status === "unsupported" ? "unsupported"
      : source.request.status === "clarification" || !source.typed.complete || !source.scopeEntity ? "needs_clarification" : "ready",
    entity: owner,
    operation: source.request.operation ?? null,
    platforms: [...(source.literalScope.platforms.length ? source.literalScope.platforms : source.literalScope.reference ? input.previous.platforms : [])],
    products: [...source.products],
    reference: source.literalScope.reference ?? "all",
    conditions: source.typed.filters.map((fact, index) => ({
      id: `condition:${index}`, owner, filter: structuredClone(fact.filter), evidence_id: `filter:${index}`,
    })),
    logic: source.typed.logical_operator ?? null,
    semantic: source.request.semantic ?? null,
    evidence,
    obligations: evidence.map(fact => ({ id: fact.id, kind: fact.role, owner: fact.owner, evidence_ids: [fact.id] })),
    model_fields: [...source.modelFields],
    unresolved: [...source.typed.unresolved],
    ambiguities: [...source.typed.ambiguities],
    residual: source.typed.residual,
    data_requirements: [...source.request.data_requirements],
  };
}
