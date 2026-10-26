"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChangeValue, display, Empty, entityNames, fieldNames, formatDate, platformNames } from "@/components/secondary/WorkspaceParts";

import { actorLabel } from "./history-input";


export type Row = Record<string, unknown>;
export type Report = {
  message: string;
  rows: Row[];
  warnings?: string[];
  errors?: { platform: string; account_id: string; reason: string }[];
  complete?: boolean;
  comparable?: boolean;
};
export function HistoryResults({
  report,
  native,
  onDetails,
}: {
  report: Report;
  native: boolean;
  onDetails: (row: Row) => void;
}) {
  const changeNames: Record<string, string> = {
    CREATED: "추가",
    REMOVED: "삭제",
    MODIFIED: "변경",
    added: "추가",
    removed: "삭제",
    changed: "변경",
    modified: "변경",
    deleted: "삭제",
  };
  const eventNames: Record<string, string> = {
    CREATE: "생성",
    UPDATE: "설정 변경",
    REMOVE: "삭제",
    UNKNOWN: "유형 확인 불가",
    UNSPECIFIED: "유형 미제공",
  };
  return (
    <Card className="overflow-hidden">
      {report.rows.length > 0 && (
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {native ? "변경 기록" : "설정 차이"}{" "}
              <span className="ml-1 text-muted-foreground">
                {report.rows.length}
              </span>
            </CardTitle>
            {native && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {report.message}
              </p>
            )}
          </div>
          {report.complete === false && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-200 bg-amber-50 text-amber-800"
            >
              부분 조회
            </Badge>
          )}
        </CardHeader>
      )}
      <CardContent className="p-0">
        {report.rows.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">
                    {native ? "변경 시각" : "대상"}
                  </TableHead>
                  <TableHead>매체 · 계정</TableHead>
                  <TableHead>{native ? "변경 종류" : "변경 항목"}</TableHead>
                  <TableHead>{native ? "변경자" : "이전 → 이후"}</TableHead>
                  <TableHead className="pr-6 text-right">상세</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row, i) => (
                  <TableRow key={String(row.key ?? i)}>
                    <TableCell className="max-w-64 pl-6">
                      <p className="break-words text-sm font-medium">
                        {native
                          ? formatDate(String(row.timestamp ?? ""))
                          : display(row.name ?? row.entity_id)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {native
                          ? `${entityNames[String(row.entity_type)] ?? display(row.entity_type)} · ${display(row.entity_id)}`
                          : (changeNames[String(row.change_type)] ??
                            display(row.change_type))}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">
                        {platformNames[String(row.platform)] ??
                          display(row.platform)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {display(row.account ?? row.account_id)}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal text-sm">
                      {native
                        ? typeof row.description === "string" && row.description
                          ? row.description
                          : (eventNames[String(row.event_type)] ??
                            display(row.event_type))
                        : (fieldNames[String(row.field)] ?? display(row.field))}
                    </TableCell>
                    <TableCell className="max-w-80 whitespace-normal">
                      {native ? (
                        <span className="text-sm">{actorLabel(row.actor)}</span>
                      ) : (
                        <ChangeValue before={row.before} after={row.after} />
                      )}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDetails(row)}
                      >
                        보기
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-6">
            {report.complete === false && (
              <Badge
                variant="outline"
                className="border-amber-200 bg-amber-50 text-amber-800"
              >
                부분 조회
              </Badge>
            )}
            <Empty
              title={
                report.comparable === false
                  ? "비교할 공통 설정이 없습니다"
                  : report.complete === false
                    ? "조회된 변경 기록이 없습니다"
                    : "이 기간에 확인된 변경이 없습니다"
              }
              description={
                report.comparable === false
                  ? "선택한 계정이 포함된 두 시점을 선택하세요."
                  : report.complete === false
                    ? "조회하지 못한 계정의 내역은 위 안내를 확인하세요."
                    : undefined
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
