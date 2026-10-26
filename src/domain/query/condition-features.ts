export const CONDITION_LEXICAL_WIDTH = 8192;
// Fixed text features; field, operator and request-kind decisions remain learned model outputs.
export function conditionTextFeatures(request: string) {
  const text = request.normalize("NFKC").toLowerCase()
    .replace(/[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:억|만|천|백|십)?(?:\s*[0-9]+(?:천|백|십))*/gu, "0")
    .replace(/[ \t\r\n]+/g, "");
  const chars = Array.from(text), result = new Float32Array(CONDITION_LEXICAL_WIDTH);
  for (let size = 2; size <= 5; size++) for (let start = 0; start + size <= chars.length; start++) {
    let hash = 2166136261;
    for (let i = start; i < start + size; i++) hash = Math.imul(hash ^ chars[i].codePointAt(0)!, 16777619) >>> 0;
    const slot = hash % CONDITION_LEXICAL_WIDTH;
    result[slot] = Math.min(3, result[slot] + 1);
  }
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  if (norm) for (let i = 0; i < result.length; i++) result[i] /= norm;
  return result;
}
