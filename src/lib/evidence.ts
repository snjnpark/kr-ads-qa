export type EvidenceObservation = {
  field: string;
  value: unknown;
  state: string;
  source?: string;
};

export function validateSelectedEntity(
  value: unknown,
  selectedKey: string,
): asserts value is Record<string, unknown> {
  const entity =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const identity = ["platform", "account_id", "entity_type", "entity_id"];
  if (
    !entity ||
    entity.key !== selectedKey ||
    identity.some((field) => typeof entity[field] !== "string") ||
    identity.map((field) => entity[field]).join("/") !== selectedKey
  )
    throw new Error(
      "선택한 광고와 다른 설정이 반환되었습니다. 다시 조회해 주세요.",
    );
  const states = new Set([
    "PRESENT",
    "NOT_SET",
    "NOT_SUPPORTED",
    "NOT_RETURNED",
    "PERMISSION_DENIED",
    "FETCH_FAILED",
    "NOT_APPLICABLE",
  ]);
  if (
    !entity.fields ||
    typeof entity.fields !== "object" ||
    Array.isArray(entity.fields) ||
    Object.values(entity.fields).some(
      (state) => typeof state !== "string" || !states.has(state),
    )
  )
    throw new Error(
      "광고 설정 응답 형식이 올바르지 않습니다. 다시 조회해 주세요.",
    );
}

export function parseStoredValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^(?:\[|\{)/.test(value.trim()))
    return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function evidenceObservations(value: unknown): EvidenceObservation[] {
  const evidence = parseStoredValue(value);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return [];
  const record = evidence as Record<string, unknown>,
    observations = new Map<string, EvidenceObservation>();
  const add = (field: string, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const observed = item as Record<string, unknown>;
    if (typeof observed.state !== "string") return;
    observations.set(field, {
      field,
      value: "value" in observed ? observed.value : observed.actual,
      state: observed.state,
      ...(typeof observed.source === "string"
        ? { source: observed.source }
        : {}),
    });
  };
  for (const [field, item] of Object.entries(record))
    if (field !== "fields") add(field, item);
  if (Array.isArray(record.fields))
    for (const item of record.fields) {
      if (item && typeof item === "object" && typeof item.field === "string")
        add(item.field, item);
    }
  return [...observations.values()];
}

export function semanticOutcome(label: unknown) {
  return label === "true"
    ? "해당 의도"
    : label === "false"
      ? "다른 의도"
      : "판단 보류";
}

export function unknownResultTitle(result: {
  status?: string;
  unknown_count?: number;
  semantic_decisions?: Record<string, unknown>;
}) {
  if (result.unknown_count) return "확인하지 못한 설정이 있습니다";
  if (Object.keys(result.semantic_decisions ?? {}).length)
    return "조건에 맞는 검토 후보가 없습니다";
  return result.status === "REVIEW" || result.status === "UNKNOWN"
    ? "질문과 조회 범위를 확인해 주세요"
    : "조건에 해당하는 광고가 없습니다";
}
