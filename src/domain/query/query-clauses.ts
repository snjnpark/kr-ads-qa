export type QueryClause = { kind: "target_declaration"; span: [number, number]; text: string };

// A declaration owns its framing only after the scope reader has owned its whole subject.
export function consumeQueryDeclarations(text: string, scopeMasked: string, targets: readonly { start: number; end: number }[]) {
  const prefix = "\\s*(?:(?:(?:이번(?:에)?|지금|현재)\\s*)?(?:(?:조회|검색|확인)(?:할)?\\s*)?(?:대상|항목)(?:은|는|:|：)\\s*)?";
  const pattern = new RegExp(`(^|[.;!?\\n])(${prefix})([^.;!?\\n]+?)(이야|입니다|이에요|예요|야)(?=\\s*(?:[.;!?\\n]|$))`, "gu");
  const characters = scopeMasked.split(""), clauses: QueryClause[] = [];
  for (const found of text.matchAll(pattern)) {
    const start = found.index + found[1].length, subjectStart = start + found[2].length;
    const subjectEnd = subjectStart + found[3].length;
    if (!targets.some(target => target.start >= subjectStart && target.end <= subjectEnd) ||
        scopeMasked.slice(subjectStart, subjectEnd).trim()) continue;
    const span: [number, number] = [start, found.index + found[0].length];
    characters.fill(" ", ...span);
    clauses.push({ kind: "target_declaration", span, text: text.slice(...span) });
  }
  return { text: characters.join(""), clauses };
}
