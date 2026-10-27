import { targetDeclarationFrames } from "./query-language";

export type QueryClause = { kind: "target_declaration"; span: [number, number]; text: string };

// A declaration owns its framing only after the scope reader has owned its whole subject.
export function consumeQueryDeclarations(text: string, scopeMasked: string, targets: readonly { start: number; end: number }[]) {
  const characters = scopeMasked.split(""), clauses: QueryClause[] = [];
  for (const pattern of targetDeclarationFrames) for (const found of text.matchAll(pattern)) {
    const start = found.index, subjectStart = start + found[1].length;
    const subjectEnd = subjectStart + found[2].length;
    if (!targets.some(target => target.start >= subjectStart && target.end <= subjectEnd) ||
        scopeMasked.slice(subjectStart, subjectEnd).trim()) continue;
    const span: [number, number] = [start, found.index + found[0].length];
    characters.fill(" ", ...span);
    clauses.push({ kind: "target_declaration", span, text: text.slice(...span) });
  }
  return { text: characters.join(""), clauses };
}
