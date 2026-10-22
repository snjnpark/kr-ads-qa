import Decimal from "decimal.js";
import type { Operator } from "../../contracts/policy";

export function safeRegex(pattern: string): RegExp {
  if (
    pattern.length > 256 ||
    /[()|{}]/.test(pattern) ||
    /\\[1-9]/.test(pattern)
  )
    throw new Error("정규식은 256자 이하의 단순 패턴만 사용할 수 있습니다.");
  const outside = pattern
    .replace(/\[(?:\\.|[^\]\\])*\]/g, "C")
    .replace(/\\./g, "E");
  if ((outside.match(/[?*+]/g) ?? []).length > 1)
    throw new Error("정규식에는 반복 연산자를 하나까지만 사용할 수 있습니다.");
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new Error("정규식 패턴을 확인해 주세요.");
  }
}

export function decimal(value: unknown): Decimal | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof Decimal)
  )
    return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}
export function deepEqual(first: unknown, second: unknown): boolean {
  if (typeof first !== typeof second) return false;
  if (first === second) return true;
  if (Array.isArray(first) && Array.isArray(second))
    return (
      first.length === second.length &&
      first.every((item, index) => deepEqual(item, second[index]))
    );
  if (
    first &&
    second &&
    typeof first === "object" &&
    typeof second === "object" &&
    !Array.isArray(first) &&
    !Array.isArray(second)
  ) {
    const keys = Object.keys(first);
    return (
      keys.length === Object.keys(second).length &&
      keys.every(
        (key) =>
          Object.hasOwn(second, key) &&
          deepEqual(
            (first as Record<string, unknown>)[key],
            (second as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return false;
}
export function compareValue(
  actual: unknown,
  operator: Operator,
  expected: unknown,
  path?: string,
): boolean | null {
  if (operator === "exists") return actual != null;
  if (operator === "is_empty" || operator === "is_not_empty") {
    const empty =
      actual == null ||
      actual === "" ||
      (Array.isArray(actual) && actual.length === 0) ||
      (actual !== null &&
        typeof actual === "object" &&
        Object.keys(actual).length === 0);
    return operator === "is_empty" ? empty : !empty;
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    let comparison: number;
    if (
      path &&
      ["schedule.start", "schedule.end", "created_at"].includes(path)
    ) {
      if (
        typeof actual !== "string" ||
        typeof expected !== "string" ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(actual) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(expected)
      )
        return null;
      const a = Date.parse(actual),
        b = Date.parse(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      comparison = a === b ? 0 : a > b ? 1 : -1;
    } else {
      const a = decimal(actual),
        b = decimal(expected);
      if (!a || !b) return null;
      comparison = a.cmp(b);
    }
    return operator === "gt"
      ? comparison > 0
      : operator === "gte"
        ? comparison >= 0
        : operator === "lt"
          ? comparison < 0
          : comparison <= 0;
  }
  if (operator === "eq") return deepEqual(actual, expected);
  if (operator === "ne") return !deepEqual(actual, expected);
  if (operator === "contains" || operator === "not_contains") {
    let found: boolean;
    if (typeof actual === "string") {
      if (typeof expected !== "string") return null;
      found = actual.includes(expected);
    } else if (Array.isArray(actual))
      found = actual.some((item) => deepEqual(item, expected));
    else if (actual && typeof actual === "object")
      found = Object.keys(actual).some((item) => deepEqual(item, expected));
    else return null;
    return operator === "contains" ? found : !found;
  }
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(expected)) return null;
    const found = expected.some((item) => deepEqual(actual, item));
    return operator === "in" ? found : !found;
  }
  if (operator === "regex")
    return typeof actual === "string" &&
      actual.length <= 1000 &&
      typeof expected === "string"
      ? safeRegex(expected).test(actual)
      : null;
  return null;
}
