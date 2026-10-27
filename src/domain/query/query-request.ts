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
  source_id: string;
  role: "filter" | "logic" | "target_declaration" | "operation" | "entity" | "scope" | "reference" | "relation" | "semantic" | "workflow";
  owner: QueryPlan["entity"] | null;
  span: [number, number];
  text: string;
  value?: unknown;
};
export type RequestObligation = {
  id: string;
  kind: RequestEvidence["role"];
  owner: RequestEvidence["owner"];
  evidence_ids: string[];
  basis: "explicit" | "context" | "default" | "model";
};
export type RequestCondition = {
  id: string;
  owner: RequestEvidence["owner"];
  filter: QueryPlan["filters"][number];
  evidence_id: string;
};
export type RequestSelection = {
  source_complete: boolean;
  filters: {field: string; alternatives: QueryPlan["filters"]}[];
  required_fields: {fields: string[]; unless_semantic: boolean}[];
  logic: QueryPlan["logical_operator"] | null;
  currency: QueryPlan["currency"];
  name_exact?: boolean;
  shapes: {operation: QueryPlan["operation"]; semantic: QueryPlan["semantic"]}[];
};
export type RequestWorkflow = {
  policy_terms: string[];
  requires_policy: boolean;
  violations_only: boolean;
  history?: {period: [number,number] | null; fields: ("budget" | "targeting")[]; entity?: QueryPlan["entity"]; increased_only: boolean};
};
export type RequestSpec = {
  input: QueryInput;
  sources?: {id:string; text:string}[];
  selection?: RequestSelection;
  workflow?: RequestWorkflow;
  date_expression?: string;
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
  issues?: { code: string; message: string; kind: "clarification" | "unsupported" }[];
};
export type ExecutionPlan = {
  workflow: RequestWorkflow;
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
  scope_roles?: { kind: "entity" | "scope" | "reference" | "relation"; span: [number, number]; text: string; entity?: QueryPlan["entity"] }[];
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

/** Preparation owns source obligations; execution still requires the separate plan validator. */
export function projectPreparedRequest(input: QueryInput, source: ProjectionSource): RequestSpec {
  const owner = source.scopeEntity ?? null;
  const evidence: RequestEvidence[] = [
    ...source.typed.filters.map((fact, index): RequestEvidence => ({
      id: `filter:${index}`, source_id: "question", role: "filter", owner, span: [...fact.span], text: fact.text, value: structuredClone(fact.filter),
    })),
    ...source.typed.logic_evidence.map((fact, index): RequestEvidence => ({
      id: `logic:${index}`, source_id: "question", role: "logic", owner, span: [...fact.span], text: fact.text, value: fact.logical_operator,
    })),
    ...source.clauses.map((clause, index): RequestEvidence => ({
      id: `declaration:${index}`, source_id: "question", role: "target_declaration", owner, span: [...clause.span], text: clause.text,
    })),
    ...(source.request.operation_evidence ?? []).map((fact, index): RequestEvidence => ({
      id: `operation:${index}`, source_id: "question", role: "operation", owner: null, span: [...fact.span], text: fact.text, value: fact.operation,
    })),
    ...(source.scope_roles ?? []).map((fact, index): RequestEvidence => ({
      id: `scope:${index}`, source_id: "question", role: fact.kind, owner: fact.entity ?? null, span: [...fact.span], text: fact.text,
      value: fact.kind === "entity" ? fact.entity : fact.kind === "relation" ? source.literalScope.reference === "children" ? "children" : "hierarchy" : fact.kind === "reference" ? source.literalScope.reference : [...(source.literalScope.platforms.length ? source.literalScope.platforms : source.literalScope.reference ? input.previous.platforms : [])],
    })),
    ...(source.request.semantic ? [{ id: "semantic:request", source_id: "question", role: "semantic" as const, owner, span: [0, input.text.length] as [number, number], text: input.text, value: source.request.semantic }] : []),
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
    obligations: evidence.filter(fact => (fact.role !== "entity" || fact.owner === owner) && (fact.role !== "relation" || !!source.literalScope.reference))
      .map(fact => ({ id: fact.id, kind: fact.role, owner: fact.owner, evidence_ids: [fact.id], basis: "explicit" })),
    model_fields: [...source.modelFields],
    unresolved: [...source.typed.unresolved],
    ambiguities: [...source.typed.ambiguities],
    residual: source.typed.residual,
    data_requirements: [...source.request.data_requirements],
  };
}
