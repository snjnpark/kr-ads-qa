/** Choice-only Laya contract shared by browser inference and query validation. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string | object;
  criteria: Record<string, string | null> | string[];
}
export type ModelResult = {
  answers: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }>;
  usage?: { truncated?: unknown; options?: unknown; input_tokens?: number };
};
export interface TypedAgent {
  systemOne(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<ModelResult>;
  close?(): Promise<void>;
}
export type ModelProgress = {
  stage: "download" | "verify" | "initialize" | "ready" | "error";
  file?: string;
  loaded: number;
  total: number;
  cached?: boolean;
  message?: string;
  cacheComplete?: boolean;
  cacheWarning?: string;
  cacheFailure?: string;
};
export type ModelConfig = {
  max_len: number;
  head_max_len: number;
  temperature: number[];
  temperature_by_options?: Record<string, number>;
  condition_classifier?: "ads-conditions-v1" | "ads-conditions-v2";
};
