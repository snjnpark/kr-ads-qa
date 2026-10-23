import type { SemanticInput } from "./engine-core";
export type { SemanticInput } from "./engine-core";
export const QUESTION_SCHEMA_VERSION = "ads-audience-objective-v1";
export const SEMANTIC_POLICY_VERSION = "typed-input-order-commercial-conflict-v2";
export function checkedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 65_536 ||
    !value.isWellFormed() ||
    // oxlint-disable-next-line no-control-regex -- Reject damaged/control text before tokenization.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufffd]/u.test(
      value,
    ) ||
    /\[(?:CLS|SEP|MASK|PAD)\]|<(?:bos|eos|mask|pad)>/.test(value)
  )
    throw new Error("의미 입력의 문자열 형식 또는 인코딩을 확인해 주세요.");
  return value;
}

export function semanticState(item: SemanticInput) {
  const state: Record<string, string> = {};
  for (const key of ["name", "purpose", "text", "ad_text"]) {
    if (item[key] == null) continue;
    const value = checkedText(item[key]);
    if (value.trim()) state[key] = value;
  }
  return state;
}
export function semanticIdentity(item: SemanticInput) {
  const parts = ["platform", "account_id", "entity_type", "entity_id"].map(
    (key) => item[key],
  );
  if (parts.some((value) => typeof value !== "string" || !value.trim()))
    throw new Error("의미 판단에 플랫폼·계정·유형·원본 ID가 필요합니다.");
  return JSON.stringify(parts.map(checkedText));
}
