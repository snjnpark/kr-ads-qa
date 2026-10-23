import { Tokenizer } from "@huggingface/tokenizers";

const aliases = { "[CLS]": ["<bos>", 2], "[SEP]": ["<eos>", 1], "[MASK]": ["<mask>", 4], "[PAD]": ["<pad>", 0] } as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Keep the downloaded upstream JSON unchanged; only add the app's same-ID aliases in memory. */
export function createUpstreamTokenizer(value: unknown, config: unknown): Tokenizer {
  if (!object(value) || !object(config) || !object(value.model) || !object(value.model.vocab) || !Array.isArray(value.added_tokens)) throw new Error("원천 토크나이저 형식을 확인할 수 없습니다.");
  const tokens: Record<string, unknown>[] = value.added_tokens.map(token => {
    if (!object(token) || typeof token.content !== "string" || !Number.isInteger(token.id)) throw new Error("원천 토크나이저의 추가 토큰이 올바르지 않습니다.");
    return token;
  });
  for (const [content, [original, id]] of Object.entries(aliases)) {
    const originalTokens = tokens.filter(token => token.content === original);
    const existing = tokens.filter(token => token.content === content);
    if (value.model.vocab[original] !== id || originalTokens.length !== 1 || originalTokens[0].id !== id || existing.length > 1 || existing.some(token => token.id !== id || token.special !== true || token.normalized !== false || token.single_word !== false || token.lstrip !== false || token.rstrip !== false) || (Object.hasOwn(value.model.vocab, content) && value.model.vocab[content] !== id)) throw new Error("모델 특수 토큰이 고정 명세와 다릅니다.");
    if (!existing.length) tokens.push({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true });
  }
  const tokenizer = new Tokenizer({ ...value, added_tokens: tokens }, config);
  for (const [content, [, id]] of Object.entries(aliases)) if (tokenizer.token_to_id(content) !== id) throw new Error("모델 특수 토큰이 고정 명세와 다릅니다.");
  return tokenizer;
}
