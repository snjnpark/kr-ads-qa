import type { DataRow } from "../contracts/api";
import { validateResponse } from "../contracts/responses";
import { browserCall } from "../browser/client";
export async function api<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const data = await browserCall<T>(path, options);
  validateResponse(path, data, options.method ?? "GET");
  return data;
}

export async function exportRows(
  rows: DataRow[] | Record<string, unknown>[],
  filename = "광고_검사_결과.csv",
) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = (value: unknown) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const content = `\uFEFF${[columns.map(cell).join(","), ...rows.map(row => columns.map(column => cell(Object.hasOwn(row, column) ? row[column] : "")).join(","))].join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
