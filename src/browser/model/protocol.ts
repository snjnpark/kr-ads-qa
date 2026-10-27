import type { QueryTrace } from "../../domain/query/query-model";
import type { RequestSpec } from "../../domain/query/query-request";
import type { QueryContext } from "../../domain/query/query";
import type { Decision, SemanticInput } from "./engine-core";
import type { ModelProgress } from "./types";
export type EngineSettings = { threshold?: number; margin?: number; batchSize?: number; baseUrl?: string };
export type WorkerRequest =
  | { id: number; method: "load"; settings: EngineSettings; files?: File[] }
  | { id: number; method: "parseQuery"; args: [string, QueryContext | undefined, Date, string]; settings: EngineSettings }
  | { id: number; method: "classify"; args: [string]; settings: EngineSettings }
  | { id: number; method: "judgeBatch"; args: [SemanticInput[], string]; settings: EngineSettings };
export type WorkerResponse =
  | { type: "progress"; value: ModelProgress }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; error: { name: string; message: string; trace?: QueryTrace; request?: RequestSpec } };
export type { Decision, SemanticInput, ModelProgress };
