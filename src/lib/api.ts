import type { DataRow } from "../contracts/api";
import { validateResponse } from "../contracts/responses";

let csrf = "";
let browserPageId: string | undefined;
let sessionRequest: Promise<unknown> | undefined;
function tabId() {
  browserPageId ??= crypto.randomUUID();
  return browserPageId;
}
type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };
function loadSession() {
  sessionRequest ??= api("/state").finally(() => {
    sessionRequest = undefined;
  });
  return sessionRequest;
}
async function request(
  path: string,
  options: RequestOptions,
  recoverSession = true,
): Promise<Response> {
  const method = options.method ?? "GET";
  if (method !== "GET" && !csrf) await loadSession();
  const response = await fetch(
    path.startsWith("/api/") ? path : `/api${path}`,
    {
      method,
      credentials: "same-origin",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Laya-Tab": tabId(),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    },
  );
  if (response.status === 403 && recoverSession) {
    const error = await response
      .clone()
      .json()
      .catch(() => null);
    if (error?.code === "SESSION_EXPIRED") {
      csrf = "";
      await loadSession();
      return request(path, options, false);
    }
  }
  return response;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await request(path, options);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  const data = await response.json().catch(() => {
    throw new Error("요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  });
  if (!response.ok) {
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(
        "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : typeof data.message === "string"
          ? data.message
          : "요청을 완료하지 못했습니다. 연결 상태와 입력을 확인해 주세요.",
    );
  }
  validateResponse(path, data, options.method ?? "GET");
  if (
    !Array.isArray(data) &&
    typeof data.csrf_token === "string" &&
    data.csrf_token
  )
    csrf = data.csrf_token;
  return data as T;
}

export async function exportRows(
  rows: DataRow[] | Record<string, unknown>[],
  filename = "광고_검사_결과.csv",
) {
  const response = await request("/export", {
    method: "POST",
    body: { rows },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? "내보내기를 완료하지 못했습니다.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
