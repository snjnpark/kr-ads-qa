import {
  FIELD_LABELS,
  PlatformMark,
  dateText,
  money,
} from "@/components/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { settingValueText } from "@/lib/evidence-display";
import type { DataRow, SettingComparison } from "@/contracts/api";

const stateNames: Record<string, string> = {
  NOT_RETURNED: "미조회",
  NOT_SET: "미설정",
  NOT_SUPPORTED: "지원하지 않음",
  PERMISSION_DENIED: "권한 없음",
  FETCH_FAILED: "조회 실패",
  NOT_APPLICABLE: "해당 없음",
};

function comparedValue(
  field: string,
  observed: SettingComparison["values"][string],
) {
  if (observed.state !== "PRESENT")
    return stateNames[observed.state] ?? "확인 불가";
  if (
    /^(?:budget\.(?:daily|lifetime)|bid\.amount|effective_(?:daily|lifetime)_budget)$/.test(
      field,
    ) &&
    (typeof observed.value === "string" || typeof observed.value === "number")
  )
    return observed.currency ? (
      money(observed.value, observed.currency)
    ) : (
      <>
        {settingValueText(observed.value, field)}
        <span className="ml-2 text-xs text-muted-foreground">통화 미조회</span>
      </>
    );
  if (
    ["schedule.start", "schedule.end"].includes(field) &&
    observed.value != null &&
    observed.value !== ""
  )
    return dateText(observed.value);
  return settingValueText(observed.value, field);
}

export default function ComparisonTable({
  comparison,
  entities,
  onSelect,
}: {
  comparison: SettingComparison[];
  entities: DataRow[];
  onSelect: (row: DataRow) => void;
}) {
  if (!comparison.length) return null;
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  return (
    <section className="result-surface" aria-label="설정 차이 비교">
      <div className="result-toolbar">
        <div className="result-heading">
          <h2>서로 다른 설정</h2>
          <span className="count-pill">
            {comparison.length.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="data-table-scroll">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>비교한 설정</TableHead>
              <TableHead className="name-column">광고 항목</TableHead>
              <TableHead>매체</TableHead>
              <TableHead>확인한 값</TableHead>
            </TableRow>
          </TableHeader>
          {comparison.map(({ field, values }) => (
            <TableBody key={field}>
              {Object.entries(values).map(([key, observed], index, entries) => {
                const [platform, account, type, id] = key.split("/");
                const entity = byKey.get(key) ?? {
                  key,
                  platform,
                  account,
                  type,
                  id,
                };
                return (
                  <TableRow key={key}>
                    {index === 0 && (
                      <TableCell
                        rowSpan={entries.length}
                        className="align-top font-medium"
                      >
                        {FIELD_LABELS[field] ?? field}
                      </TableCell>
                    )}
                    <TableCell className="name-column">
                      <button
                        className="entity-name"
                        onClick={() => onSelect(entity)}
                      >
                        {entity.name || "이름 미조회"}
                      </button>
                      <span className="block break-all text-xs text-muted-foreground">
                        {entity.account || account}
                        <span className="meta-divider">/</span>
                        {entity.id || id || "ID 미조회"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <PlatformMark platform={entity.platform || platform} />
                    </TableCell>
                    <TableCell className="max-w-lg whitespace-normal break-words">
                      {comparedValue(field, observed)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          ))}
        </Table>
      </div>
    </section>
  );
}
