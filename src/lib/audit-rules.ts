import { z } from "./validation";
export const RULES: Record<string, string> = {
  BUDGET_001: "캠페인·광고그룹 예산 설정",
  BUDGET_002: "일예산 금액",
  BUDGET_003: "총예산 금액",
  BUDGET_004: "정책 최대 일예산",
  BUDGET_005: "정책 최대 총예산",
  BUDGET_006: "예산 통화",
  BUDGET_007: "정책 통화 일치",
  BUDGET_008: "예산 금액 단위",
  STATUS_001: "상위 캠페인·광고그룹의 운영 상태",
  STATUS_002: "운영 중인 광고의 집행 제한",
  STATUS_003: "소재 심사 상태 확인",
  SCHEDULE_001: "시작·종료 순서",
  SCHEDULE_002: "종료 후 활성 상태",
  SCHEDULE_003: "시작 전 활성 상태",
  SCHEDULE_004: "프로모션 종료일 정책",
  SCHEDULE_005: "계정 시간대 설정",
  TARGET_001: "최소·최대 연령 순서",
  TARGET_002: "정책 최소 연령",
  TARGET_003: "정책 최대 연령",
  TARGET_004: "정책 허용 국가",
  TARGET_005: "포함·제외 오디언스 중복",
  TARGET_006: "리타겟팅 이름·오디언스 확인",
  OPTIMIZATION_001: "목적 설정",
  OPTIMIZATION_002: "최적화 목표 설정",
  OPTIMIZATION_003: "구매 이름·전환 이벤트 확인",
  BID_001: "입찰가 금액",
  BID_002: "정책 최대 입찰가",
  BID_003: "상한 입찰 전략의 금액",
  CREATIVE_001: "광고 문구 설정",
  URL_001: "도착 페이지 주소 설정",
  URL_002: "도착 페이지 주소 형식",
  URL_003: "필수 추적 태그",
  URL_004: "주소의 중복 항목",
};

export const AUDIT_PLATFORMS = ["meta", "naver", "google", "kakao", "kakao_keyword"] as const;
export type AuditPlatform = typeof AUDIT_PLATFORMS[number];
const extra = (id: string) => id.startsWith("TARGET_") || id.startsWith("OPTIMIZATION_") || id.startsWith("BID_") || ["BUDGET_003", "BUDGET_005"].includes(id);
export const COMMON_RULE_IDS = Object.keys(RULES).filter(id => !extra(id));
const extraIds = Object.keys(RULES).filter(extra);
export const PLATFORM_RULE_IDS: Record<AuditPlatform, string[]> = {
  meta: extraIds,
  naver: extraIds.filter(id => id.startsWith("BID_")),
  google: extraIds.filter(id => id.startsWith("BID_") || id.startsWith("BUDGET_")),
  kakao: extraIds,
  kakao_keyword: extraIds.filter(id => id.startsWith("BID_")),
};
export const PLATFORM_RULE_HELP: Record<AuditPlatform, string> = {
  meta: "광고 세트의 총예산·연령·국가·오디언스·최적화 목표와 입찰 설정을 확인합니다.",
  naver: "광고그룹·키워드의 입찰 설정을 확인합니다. 총예산·오디언스·전환 목표는 현재 연결에서 조회하지 않습니다.",
  google: "캠페인 총예산과 광고그룹·키워드 입찰 설정을 확인합니다. 오디언스·전환 목표는 현재 연결에서 조회하지 않습니다.",
  kakao: "캠페인·광고그룹의 총예산·타겟·최적화 목표와 입찰 설정을 확인합니다.",
  kakao_keyword: "프리미엄링크의 광고그룹·키워드 입찰을 확인합니다. 모먼트 오디언스와 톡채널검색은 검사하지 않습니다.",
};
export type AuditRuleConfiguration = {
  version: number;
  common: string[];
  platforms: Record<AuditPlatform, string[]>;
};
export function defaultAuditRules(): AuditRuleConfiguration {
  return { version: 1, common: [...COMMON_RULE_IDS], platforms: Object.fromEntries(AUDIT_PLATFORMS.map(platform => [platform, [...PLATFORM_RULE_IDS[platform]]])) as Record<AuditPlatform, string[]> };
}
export function enabledAuditRuleIds(configuration: AuditRuleConfiguration, platforms: readonly string[] = AUDIT_PLATFORMS): string[] {
  return [...new Set([...configuration.common, ...platforms.flatMap(platform => configuration.platforms[platform as AuditPlatform] ?? [])])];
}
export function auditRuleCount(configuration: AuditRuleConfiguration, platforms: readonly string[] = AUDIT_PLATFORMS): number {
  return configuration.common.length + [...new Set(platforms)].reduce((count, platform) => count + (configuration.platforms[platform as AuditPlatform]?.length ?? 0), 0);
}

const selection = (allowed: string[]) => z.array(z.string()).max(33).refine(
  ids => new Set(ids).size === ids.length && ids.every(id => allowed.includes(id)),
  "지원하지 않거나 중복된 검사 항목입니다.",
);
export const auditRulesSchema = z.strictObject({
  version: z.number().int().positive(),
  common: selection(COMMON_RULE_IDS),
  platforms: z.strictObject({
    meta: selection(PLATFORM_RULE_IDS.meta),
    naver: selection(PLATFORM_RULE_IDS.naver),
    google: selection(PLATFORM_RULE_IDS.google),
    kakao: selection(PLATFORM_RULE_IDS.kakao),
    kakao_keyword: selection(PLATFORM_RULE_IDS.kakao_keyword).default(() => []),
  }),
});
