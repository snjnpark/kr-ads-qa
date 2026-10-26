export function localTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function nativeHistoryRange(
  start: string,
  end: string,
  platforms?: string[],
  now = Date.now(),
) {
  const first = new Date(start),
    last = new Date(end);
  if (!start || !end || !Number.isFinite(+first) || !Number.isFinite(+last))
    throw new Error("시작·종료 일시를 입력해 주세요.");
  if (
    localTime(first) !== start.slice(0, 16) ||
    localTime(last) !== end.slice(0, 16)
  )
    throw new Error(
      "시간대가 바뀌는 구간에서 존재하지 않는 시각입니다. 다른 시각을 선택해 주세요.",
    );
  if (+first >= +last)
    throw new Error("종료 일시는 시작 일시보다 늦어야 합니다.");
  if (+last > now) throw new Error("종료 일시는 현재 시각을 넘을 수 없습니다.");
  if (
    (!platforms?.length || platforms.includes("google")) &&
    +first < now - 30 * 86400000
  )
    throw new Error("Google이 포함된 조회는 최근 30일 이내로 설정해 주세요.");
  return { start: first.toISOString(), end: last.toISOString() };
}
export function actorLabel(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) return text || "기록 없음";
    try {
      return actorLabel(JSON.parse(text));
    } catch {
      return text || "기록 없음";
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "기록 없음";
  const actor = value as Record<string, unknown>,
    parts = [actor.name, actor.email, actor.id].filter(
      (item) => typeof item === "string" && item.trim(),
    );
  return [...new Set(parts)].join(" · ") || "기록 없음";
}
