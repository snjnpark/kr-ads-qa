export type QueryClause = { kind: "target_declaration"; span: [number, number]; text: string };

// A declaration owns its framing only after the scope reader has owned its whole subject.
export function consumeQueryDeclarations(text: string, scopeMasked: string, targets: readonly { start: number; end: number }[]) {
  const action = "(?:(?:조회|검색|확인)(?:할)?|(?:개수를\\s*)?셀)";
  const head = `(?:(?:이번(?:에)?|지금|현재)\\s*)?(?:${action}\\s*)?(?:대상|항목)(?:은|는|:|：)\\s*|(?:조회|검색|확인)할\\s*것(?:은|이)\\s*`;
  const ending = "(?:뿐)?(?:이야|입니다|이에요|예요|이다|야)";
  const subject = "([^.;!?\\n,]+?)", end = "(?=\\s*(?:[.;!?\\n,]|$))";
  // Every frame has prefix, subject, ending groups. Scope words are proved by the caller.
  const patterns = [
    new RegExp(`(?<![\\p{L}\\p{N}_])(${head})${subject}(${ending})${end}`, "gu"),
    new RegExp(`(?<![\\p{L}\\p{N}_])(${head})${subject}((?:으로|로)\\s*잡고)(?=\\s|$)`, "gu"),
    new RegExp(`(?<![\\p{L}\\p{N}_])((?:${action}\\s*)?(?:대상|항목)[:：]\\s*)${subject}()${end}`, "gu"),
    new RegExp(`(?:^|(?<=[.;!?\\n,]))(\\s*)${subject}((?:이|가)?\\s*(?:${action}\\s*)?대상${ending}|(?:을|를)\\s*대상으로)(?=\\s|$|[.;!?\\n,])`, "gu"),
    new RegExp(`(?:^|(?<=[.;!?\\n,]))(\\s*)${subject}(${ending})${end}`, "gu"),
  ];
  const characters = scopeMasked.split(""), clauses: QueryClause[] = [];
  for (const pattern of patterns) for (const found of text.matchAll(pattern)) {
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
