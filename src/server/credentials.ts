import { TEST_MODE } from "../lib/runtime";
import { randomUUID, randomBytes } from "node:crypto";
import type { Platform } from "./models";

export const NAMES: Record<Platform, readonly string[]> = {
  meta: ["access_token"],
  naver: ["api_key", "secret_key", "customer_id"],
  kakao: ["business_token"],
  kakao_keyword: ["business_token"],
  google: [
    "client_id",
    "client_secret",
    "refresh_token",
    "login_customer_id",
    "access_token",
  ],
};
export type Credentials = Partial<Record<Platform, Record<string, string>>>;
const validValue = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= 65536 &&
  !/[\r\n\0]/.test(value);
function validate(platform: Platform, values: unknown): Record<string, string> {
  if (
    !(platform in NAMES) ||
    !values ||
    typeof values !== "object" ||
    Array.isArray(values)
  )
    throw new Error("올바르지 않은 인증 설정입니다.");
  const entries = Object.entries(values);
  if (
    !entries.length ||
    entries.some(
      ([key, value]) => !NAMES[platform].includes(key) || !validValue(value),
    )
  )
    throw new Error("올바르지 않은 인증 설정입니다.");
  return Object.fromEntries(entries) as Record<string, string>;
}
async function entry(service: string, username: string) {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, username, { linux: { store: "secret-service" } });
}
export async function saveCredentials(platform: Platform, values: unknown) {
  const data = validate(platform, values);
  try {
    (await entry(TEST_MODE ? "laya-ads-qa-testing" : "laya-ads-qa", platform)).setPassword(JSON.stringify(data));
  } catch {
    throw new Error("OS 인증 저장소에 저장하지 못했습니다.");
  }
}
export async function loadConnections(): Promise<Credentials> {
  const connections: Credentials = {};
  for (const platform of Object.keys(NAMES) as Platform[]) {
    let values: Record<string, string> = {};
    try {
      const saved = (await entry(TEST_MODE ? "laya-ads-qa-testing" : "laya-ads-qa", platform)).getPassword();
      if (saved) values = validate(platform, JSON.parse(saved));
    } catch {
      /* Missing or unavailable keyring never becomes a plaintext fallback. */
    }
    for (const name of NAMES[platform]) {
      const value = process.env[`${TEST_MODE ? "LAYA_TEST_" : ""}${platform}_${name}`.toUpperCase()];
      if (value !== undefined) {
        if (validValue(value)) values[name] = value;
        else delete values[name];
      }
    }
    if (Object.keys(values).length) connections[platform] = values;
  }
  return connections;
}
export async function probeKeyring() {
  const service = `laya-ads-qa-probe-${randomUUID()}`,
    username = randomUUID(),
    value = randomBytes(32).toString("base64url");
  const test = await entry(service, username);
  let written = false;
  try {
    test.setPassword(value);
    written = true;
    if (test.getPassword() !== value)
      throw new Error("OS 인증 저장소 읽기 검증 실패");
    const deleted = test.deletePassword();
    written = false;
    if (!deleted) throw new Error("OS 인증 저장소 삭제 검증 실패");
    const absent = test.getPassword() === null;
    if (!absent) throw new Error("OS 인증 저장소 삭제 검증 실패");
    return {
      backend: "@napi-rs/keyring",
      platform: process.platform,
      set: true,
      read: true,
      delete: true,
      absent: true,
      existing_credentials_touched: false,
    };
  } finally {
    if (written) {
      try {
        test.deletePassword();
      } catch {
        /* Do not expose the temporary secret in an error. */
      }
    }
  }
}
