import type { DataRow } from "../contracts/api";
import { validateResponse } from "../contracts/responses";
import { browserCall } from "../browser/client";
import { csvText } from "./csv";
export async function api<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const data = await browserCall<T>(path, options);
  validateResponse(path, data, options.method ?? "GET");
  return data;
}

export async function exportRows(
  rows: DataRow[] | Record<string, unknown>[],
  filename = "광고_검사_결과.csv",
) {
  const content = csvText(rows);
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
