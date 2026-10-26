import { sha256 } from "./crypto";
import Decimal from "decimal.js";
import { DateTime } from "luxon";
import { stringify } from "yaml";
import type { Policy, Rule } from "../contracts/policy";
import { loadPolicy } from "../domain/policies/schema";
import { BrowserPolicyManager as PolicyManager } from "./policies";

export type Classification = {
  source?: string;
  label?: string | null;
  status?: string;
  reason?: string;
  [key: string]: unknown;
};
export type RuleDraft = {
  text: string;
  policy_id: string;
  rule: Rule;
  yaml: string;
  digest: string;
  notes: string[];
  classification: Classification;
};
export type RuleClassifier = (
  text: string,
) => Classification | Promise<Classification>;

export function canonicalJson(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
      );
    return item;
  }
  return JSON.stringify(sorted(value));
}
async function digest(text: string, policyId: string, rule: Rule): Promise<string> {
  return sha256(canonicalJson({ text, policy_id: policyId, rule }));
}
function money(text: string): string {
  const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(억|만|천)?\s*원?/);
  if (!match) throw new Error("규칙의 예산 금액을 확인해 주세요.");
  return new Decimal(match[1].replaceAll(",", ""))
    .mul(
      ({ 천: 1000, 만: 10000, 억: 100000000 } as Record<string, number>)[
        match[2]
      ] ?? 1,
    )
    .toFixed();
}

export class RuleBuilder {
  constructor(
    readonly manager: PolicyManager,
    readonly classifier?: RuleClassifier,
  ) {}

  async preview(
    text: string,
    policyId = "default",
    referenceTime?: string,
    contextPolicy?: Policy,
  ): Promise<RuleDraft> {
    if (!text.trim() || [...text].length > 2000)
      throw new Error("1~2,000자의 검사 규칙을 입력해 주세요.");
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(policyId) ||
      policyId === "bindings"
    )
      throw new Error("올바른 정책 ID가 필요합니다.");
    let classification: Classification = {
      source: "typescript_template",
      label: "create_rule",
      reason: "허용된 문장 템플릿만 해석했습니다.",
    };
    if (this.classifier) {
      classification = await this.classifier(text);
      if (
        classification.status !== "PASS" ||
        classification.label !== "create_rule"
      )
        throw new Error(
          "새 규칙을 만드는 요청인지 확실하지 않습니다. 검사 조건을 명확히 입력해 주세요.",
        );
    }
    if (referenceTime && !/(?:Z|[+-]\d{2}:\d{2})$/.test(referenceTime))
      throw new Error("규칙 기준 시각에는 시간대가 필요합니다.");
    const reference = referenceTime
      ? DateTime.fromISO(referenceTime, { setZone: true })
      : DateTime.now().setZone("Asia/Seoul");
    if (!reference.isValid) throw new Error("규칙 기준 시각을 확인해 주세요.");
    if (contextPolicy && [text.includes("일예산"), /운영\s*상태|활성|일시\s*중지/.test(text), text.includes("종료일"), /맞춤\s*타겟|오디언스/.test(text)].filter(Boolean).length !== 1)
      throw new Error("한 번에 한 조건만 입력해 주세요. 여러 조건은 각각 초안으로 추가할 수 있습니다.");
    const notes: string[] = [];
    let entity = /광고\s*(그룹|세트)/.test(text) ? "adgroup" : "campaign";
    if (text.includes("키워드")) entity = "keyword";
    if (
      text.includes("소재") ||
      (text.includes("광고") &&
        !text.includes("캠페인") &&
        entity === "campaign")
    )
      entity = text.includes("소재") ? "creative" : "ad";
    const platforms = (
      [
        ["메타", "meta"],
        ["네이버", "naver"],
        ["카카오", "kakao"],
        ["구글", "google"],
      ] as const
    )
      .filter(([name]) => text.includes(name))
      .map(([, platform]) => platform);
    const named = text.match(
      /이름에\s*["']?([가-힣A-Za-z0-9_-]+?)["']?(?:이|가)?\s*(?:들어가면|포함)/,
    );
    const when = named
      ? { field: "name", operator: "contains", value: named[1] }
      : undefined;
    let check: Record<string, unknown>;
    if (text.includes("일예산") && /넘|초과|이상|이하|미만/.test(text)) {
      if (contextPolicy && /일예산\s*[-−]/.test(text)) throw new Error("예산은 0 이상의 금액으로 입력해 주세요.");
      const amount = money(text.split("일예산", 2)[1]);
      check = {
        field: "effective_daily_budget",
        operator: contextPolicy
          ? (() => {
              const boundary = text.match(/이상|이하|미만|초과|넘/)![0];
              const normal = ({ 이상: "gte", 이하: "lte", 미만: "lt", 초과: "gt", 넘: "gt" } as Record<string, string>)[boundary];
              return /경고|오류|위반|금지/.test(text) ? ({ gte: "lt", lte: "gt", lt: "gte", gt: "lte" } as Record<string, string>)[normal] : normal;
            })()
          : text.includes("이상") && !/넘|초과|이하/.test(text) ? "lt" : "lte",
        value: amount,
      };
      notes.push(
        "예산은 계정 통화 기준입니다. 상위 캠페인의 예산이 적용될 수 있습니다.",
      );
    } else if (/운영\s*상태|활성|일시\s*중지/.test(text)) {
      const paused = /일시\s*중지|중지\s*상태|비활성/.test(text);
      if (contextPolicy && (!/활성|일시\s*중지|중지\s*상태/.test(text) || /아니|아닌|않|제외/.test(text)))
        throw new Error("운영 상태는 활성 또는 일시중지 중 정상 기준을 명확히 입력해 주세요.");
      check = { field: "status", operator: "in", value: paused
        ? ["PAUSED", "DISABLED", "OFF", "STOPPED"] : ["ACTIVE", "ENABLED", "ON", "ELIGIBLE", "NORMAL"] };
    } else if (text.includes("종료일")) {
      const match = text.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/);
      if (match) {
        const year = match[1] ? Number(match[1]) : reference.year;
        const deadline = reference.set({
          year,
          month: Number(match[2]),
          day: Number(match[3]),
          hour: 23,
          minute: 59,
          second: 59,
          millisecond: 999,
        });
        if (
          !deadline.isValid ||
          deadline.month !== Number(match[2]) ||
          deadline.day !== Number(match[3])
        )
          throw new Error("종료일의 날짜를 확인해 주세요.");
        const end = deadline.toISO()!.replace(".999", ".999999");
        check = { field: "schedule.end", operator: "lte", value: end };
        if (!match[1])
          notes.push(`연도는 기준 시각의 ${year}년으로 해석했습니다.`);
        notes.push(`종료일 상한: ${end} (해당 날짜 마지막 시각)`);
      } else {
        if (!/설정|존재|있는|없는|누락/.test(text))
          throw new Error(
            "종료일 존재 검사인지 날짜 상한 검사인지 확인해 주세요.",
          );
        check = { field: "schedule.end", operator: "is_not_empty" };
      }
    } else if (/맞춤\s*타겟|오디언스/.test(text) && /승인/.test(text)) {
      let policy: Policy;
      try {
        policy = contextPolicy ?? this.manager.get(policyId);
      } catch {
        throw new Error("정책에 승인된 오디언스 ID 목록을 먼저 등록해 주세요.");
      }
      if (!policy.settings.approved_audiences.length)
        throw new Error("정책에 승인된 오디언스 ID 목록을 먼저 등록해 주세요.");
      check = {
        field: "targeting.approved_retarg_audience_present",
        operator: "eq",
        value: true,
      };
    } else
      throw new Error(
        "지원하는 조건: 일예산 상한, 운영 상태, 이름 조건의 종료일, 승인된 맞춤 타겟 존재 검사입니다.",
      );
    const ruleId = `CUSTOM_${(await sha256(text)).slice(0, 12).toUpperCase()}`;
    const rule = loadPolicy({
      policy_id: policyId,
      name: "규칙 미리보기",
      rules: [
        {
          rule_id: ruleId,
          name: text.slice(0, 120),
          entity,
          platforms,
          severity: text.includes("경고") ? "warning" : "error",
          when,
          check,
        },
      ],
    }).rules[0];
    const yaml = stringify(rule);
    return {
      text,
      policy_id: policyId,
      rule,
      yaml,
      digest: await digest(text, policyId, rule),
      notes,
      classification,
    };
  }

  async save(draft: RuleDraft, approved = false, approvedHash?: string): Promise<Policy> {
    if (approved !== true || approvedHash !== draft.digest)
      throw new Error("미리보기의 정확한 규칙을 승인한 뒤 저장할 수 있습니다.");
    if (
      (await digest(draft.text, draft.policy_id, draft.rule)) !== draft.digest ||
      stringify(draft.rule) !== draft.yaml
    )
      throw new Error(
        "승인할 규칙이 미리보기 이후 변경되었습니다. 다시 확인해 주세요.",
      );
    const rule = loadPolicy({
      policy_id: draft.policy_id,
      name: "규칙 검증",
      rules: [draft.rule],
    }).rules[0];
    const existing = this.manager
      .list()
      .find((policy) => policy.policy_id === draft.policy_id);
    if (!existing)
      return this.manager.create({
        policy_id: draft.policy_id,
        name: "사용자 검사 정책",
        rules: [rule],
      });
    const policy = this.manager.get(draft.policy_id);
    if (policy.rules.some((item) => item.rule_id === rule.rule_id))
      throw new Error("동일한 규칙이 이미 있습니다.");
    return this.manager.update({ ...policy, rules: [...policy.rules, rule] });
  }
}
