import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultReleaseSelection,
  ensureModelRelease,
  releaseDirectory,
  ModelReleaseError,
  type ModelRelease,
} from "./model-release";
import type { ChoiceQuestion } from "@receptron/laya";
import type { QueryContext } from "./query";
import { interpretQuery, QUERY_PLAN_VERSION, type QueryTrace } from "./query-model";
import {
  DEFAULT_MODEL_DIRECTORY,
  MODEL_ID,
  MODEL_REVISION,
  prepareBundle,
  verifyBundle,
  verifyCandidateBundle,
  candidateModelVersion,
} from "./laya-bundle";

export const INTENTS = {
  search: "Find or count advertising entities matching conditions",
  inspect: "Inspect an entity's settings or details",
  audit: "Run all account QA checks",
  filter_previous: "Filter or navigate previously returned results",
  history: "Show changes between past and current settings",
  policy: "Validate or manage advertiser operating policies",
  create_rule: "Create a reusable QA rule for future checks",
  compare: "Compare settings of different advertising entities",
  unknown:
    "Ambiguous, unrelated, unsupported, or an advertising modification request",
};
export const INTENT_QUESTION = {
  intent: {
    type: "choice",
    instructions:
      "Classify the user's request. Select unknown if unclear or unrelated.",
    criteria: INTENTS,
  },
} satisfies Record<string, ChoiceQuestion>;
export const SEMANTIC_QUESTIONS = {
  audience: {
    type: "choice",
    instructions:
      "Classify the intended audience stated in the advertising name and purpose. Use unknown when not stated, unclear or conflicting.",
    criteria: {
      retargeting:
        "Re-engage previous visitors, cart abandoners or existing customers (재방문, 기존 고객)",
      acquisition: "Acquire new or first-time customers (신규 고객, 잠재 고객)",
      unknown: "The audience intent is not stated, unclear or conflicting",
    },
  },
  objective: {
    type: "choice",
    instructions:
      "Classify the primary objective stated in the advertising name and purpose. Use unknown when not stated, unclear or conflicting.",
    criteria: {
      branding:
        "Increase brand awareness, reach or recognition (브랜딩, 인지도, 도달)",
      purchase:
        "Generate completed purchases, orders, revenue or sales (구매, 결제, 주문, 매출)",
      traffic:
        "Drive website visits, landing-page clicks or traffic (방문, 클릭, 트래픽)",
      unknown: "The primary objective is not stated, unclear or conflicting",
    },
  },
} satisfies Record<string, ChoiceQuestion>;
export const QUESTION_SCHEMA_VERSION = "ads-audience-objective-v1";
export const SEMANTIC_POLICY_VERSION =
  "typed-input-order-commercial-conflict-v2";
export type SemanticInput = {
  platform: string;
  account_id: string;
  entity_type: string;
  entity_id: string;
  name?: string;
  purpose?: string | null;
  text?: string | null;
  ad_text?: string | null;
  [key: string]: unknown;
};
export type Decision = {
  label: string | null;
  status: "PASS" | "REVIEW" | "UNKNOWN";
  scores: Record<string, number>;
  model_version: string;
  entity_id: string | null;
  reason: string;
  source: string;
  candidates: Record<string, Record<string, number>>;
  criterion_version: string;
};
type ModelResult = {
  answers: Record<
    string,
    { type?: string; choice?: string; probabilities?: Record<string, number> }
  >;
  usage?: { truncated?: unknown; options?: unknown; input_tokens?: number };
};
export interface TypedAgent {
  systemOne(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
  ): Promise<ModelResult>;
  close?(): Promise<void>;
}
export type EngineOptions = {
  mock?: boolean;
  threshold?: number;
  margin?: number;
  batchSize?: number;
  cpuThreads?: number;
  modelDirectory?: string;
  modelKind?: "baseline" | "candidate";
  candidateId?: string;
  agent?: TypedAgent;
};

function checkedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 65_536 ||
    !value.isWellFormed() ||
    // oxlint-disable-next-line no-control-regex -- Reject damaged/control text before tokenization.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufffd]/u.test(
      value,
    ) ||
    /\[(?:CLS|SEP|MASK|PAD)\]|<(?:bos|eos|mask|pad)>/.test(value)
  )
    throw new Error("의미 입력의 문자열 형식 또는 인코딩을 확인해 주세요.");
  return value;
}

export function semanticState(item: SemanticInput) {
  const state: Record<string, string> = {};
  for (const key of ["name", "purpose", "text", "ad_text"]) {
    if (item[key] == null) continue;
    const value = checkedText(item[key]);
    if (value.trim()) state[key] = value;
  }
  return state;
}
export function semanticIdentity(item: SemanticInput) {
  const parts = ["platform", "account_id", "entity_type", "entity_id"].map(
    (key) => item[key],
  );
  if (parts.some((value) => typeof value !== "string" || !value.trim()))
    throw new Error("의미 판단에 플랫폼·계정·유형·원본 ID가 필요합니다.");
  return JSON.stringify(parts.map(checkedText));
}
function pyJson(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}
function top(scores: Record<string, number>) {
  return Object.keys(scores).reduce((best, key) =>
    scores[key]! > scores[best]! ? key : best,
  );
}
function commercialAwarenessConflict(state: Record<string, string>) {
  const text = Object.values(state).join(" ");
  return (
    /브랜드|상표|메이커|명품|\bbrand(?:ed|s)?\b|\bdesigner\b/i.test(text) &&
    /판매|결제|주문|유료\s*예매|\b(?:sell|selling|sales|checkout|payment|orders?|paid bookings?)\b/i.test(
      text,
    ) &&
    !/브랜딩|인지도|인식|친숙|기억|알리|알려|도달|awareness|recognition|recall|familiar|introduc|reach/i.test(
      text,
    )
  );
}
function containsModelInstruction(state: Record<string, string>) {
  return /ignore\s+(?:(?:all|the|any|previous|above)\s+)*(?:instructions?|prompts?)|이전\s*(?:지시|명령).*무시|(?:always|must)\s+(?:answer|choose|return|output)\s+(?:true|false|branding|purchase|retargeting)|(?:정답|출력|라벨)\s*(?:[:=]|은|는)\s*["']?(?:true|false|branding|purchase|retargeting)/i.test(
    Object.values(state).join(" "),
  );
}
const domainPatterns = [
  /(리타겟|재방문|리마케팅|retarget|remarket)/i,
  /(브랜딩|인지도|brand|awareness)/i,
  /(구매|전환|매출|purchase|sales|conversion)/i,
];

export class LayaEngine {
  readonly mock: boolean;
  readonly threshold: number;
  readonly margin: number;
  readonly batchSize: number;
  readonly cpuThreads: number;
  readonly modelDirectory: string;
  readonly modelKind: "baseline" | "candidate";
  readonly candidateId?: string;
  private candidateVersion?: string;
  private release?: ModelRelease;
  private agent?: TypedAgent;
  private loading?: Promise<TypedAgent>;
  private encode?: (text: string) => number[];
  private config?: { max_len: number; head_max_len: number; condition_classifier?: "ads-conditions-v1" | "ads-conditions-v2" };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: EngineOptions = {}) {
    if (options.mock) throw new Error("프로덕션에서는 학습 모델만 사용할 수 있습니다.");
    this.mock = false;
    this.threshold = options.threshold ?? 0.8;
    this.margin = options.margin ?? 0.1;
    this.batchSize = options.batchSize ?? 8;
    this.cpuThreads = options.cpuThreads ?? 8;
    this.release = defaultReleaseSelection(options) ?? undefined;
    this.modelDirectory = this.release
      ? releaseDirectory(this.release)
      : (options.modelDirectory ??
        (options.modelKind === "baseline" || this.mock
          ? DEFAULT_MODEL_DIRECTORY
          : "data/models/releases"));
    this.modelKind = this.release
      ? "candidate"
      : (options.modelKind ?? (this.mock ? "baseline" : "candidate"));
    this.candidateId = this.release?.candidate_id ?? options.candidateId;
    if (
      options.modelKind === "candidate" &&
      (!options.modelDirectory ||
        !options.candidateId ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.candidateId) ||
        this.mock)
    )
      throw new Error(
        "Candidate loading requires an explicit directory and candidate ID",
      );
    if (
      (!options.modelKind || this.modelKind === "baseline") &&
      options.candidateId
    )
      throw new Error("Candidate ID requires explicit candidate model loading");
    this.agent = options.agent;
    if (
      !Number.isFinite(this.threshold) ||
      this.threshold < 0 ||
      this.threshold > 1 ||
      !Number.isFinite(this.margin) ||
      this.margin < 0 ||
      this.margin > 1 ||
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 256 ||
      !Number.isInteger(this.cpuThreads) ||
      this.cpuThreads < 1 ||
      this.cpuThreads > 64
    )
      throw new Error("의미 판단 설정값이 올바르지 않습니다.");
  }
  get source() {
    return "laya";
  }
  get modelVersion() {

    const identity =
      this.modelKind === "candidate"
        ? (this.candidateVersion ??
          (this.candidateId
            ? `candidate:${this.candidateId};unverified`
            : "finetuned-model:unconfigured"))
        : `${MODEL_ID}/multilingual@${MODEL_REVISION}`;
    return `${identity};@receptron/laya=0.2.0;cpu;onnx;heads=${this.modelKind === "candidate" ? "candidate" : "base"};axes;policy=${SEMANTIC_POLICY_VERSION}`;
  }
  async load(): Promise<TypedAgent | null> {

    if (this.agent) return this.agent;
    if (!this.loading)
      this.loading = (async () => {
        const manifest = path.join(this.modelDirectory, "node-manifest.json");
        if (this.modelKind === "candidate") {
          if (!this.candidateId)
            throw new ModelReleaseError(
              "배포용 파인튜닝 모델이 지정되지 않았습니다. 배포 모델을 지정해 주세요.",
            );
          if (this.release) await ensureModelRelease(this.release);
          this.candidateVersion = candidateModelVersion(
            await verifyCandidateBundle(this.modelDirectory, this.candidateId),
          );
        } else {
          if (
            !(await readFile(/* turbopackIgnore: true */ manifest).catch(
              () => null,
            ))
          ) {
            if (
              path.resolve(this.modelDirectory) !==
                path.resolve(DEFAULT_MODEL_DIRECTORY) ||
              (await readFile(
                /* turbopackIgnore: true */ path.join(
                  this.modelDirectory,
                  "candidate-manifest.json",
                ),
              ).catch(() => null))
            )
              throw new Error(
                "An explicit model directory requires its registered bundle; baseline auto-preparation is disabled",
              );
            await prepareBundle({ directory: this.modelDirectory });
          }
          await verifyBundle(this.modelDirectory);
        }
        const [{ Laya }, { Tokenizer }] = await Promise.all([
          import("@receptron/laya"),
          import("@huggingface/tokenizers"),
        ]);
        const tokenizer = new Tokenizer(
          JSON.parse(
            await readFile(
              /* turbopackIgnore: true */
              path.join(this.modelDirectory, "tokenizer/tokenizer.json"),
              "utf8",
            ),
          ),
          JSON.parse(
            await readFile(
              /* turbopackIgnore: true */
              path.join(this.modelDirectory, "tokenizer/tokenizer_config.json"),
              "utf8",
            ),
          ),
        );
        this.encode = (text) =>
          tokenizer.encode(text, { add_special_tokens: false }).ids;
        this.config = JSON.parse(
          await readFile(
            /* turbopackIgnore: true */
            path.join(this.modelDirectory, "laya_config.json"),
            "utf8",
          ),
        );
        const delegate = await Laya.load({
          modelDir: this.modelDirectory,
          executionProviders: ["cpu"],
          sessionOptions: {
            intraOpNumThreads: this.cpuThreads,
            interOpNumThreads: 1,
          },
        });
        try {
          this.agent = this.config?.condition_classifier
            ? await (await import("./condition-classifier")).loadConditionAgent(
              this.modelDirectory, delegate, this.encode, this.cpuThreads, this.config.condition_classifier,
            )
            : delegate;
        } catch (error) {
          await delegate.close?.();
          throw error;
        }
        return this.agent;
      })().catch((error) => {
        this.loading = undefined;
        throw error;
      });
    return this.loading;
  }
  async close() {
    await this.queue.catch(() => undefined);
    if (this.loading) await this.loading.catch(() => undefined);
    await this.agent?.close?.();
    this.agent = undefined;
    this.loading = undefined;
  }
  private decision(
    label: string | null,
    identity: string | null,
    reason: string,
    values: Partial<Decision> = {},
  ): Decision {
    return {
      label,
      status: "REVIEW",
      scores: {},
      model_version: this.modelVersion,
      entity_id: identity,
      reason,
      source: this.source,
      candidates: {},
      criterion_version: "",
      ...values,
    };
  }
  private abstain(reason: string, identity: string | null = null) {
    return this.decision(null, identity, reason, { status: "UNKNOWN" });
  }
  private async infer(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
  ) {
    const operation = this.queue
      .catch(() => undefined)
      .then(async () => {
        const agent = await this.load();
        if (!agent) throw new Error("모델이 로드되지 않았습니다.");
        // The public SDK silently truncates state; detect the same token budget first.
        if (this.encode && this.config)
          for (const question of Object.values(questions)) {
            const scrub = (value: string) =>
              value.replace(/\[MASK\]|<mask>/g, " ");
            const options = Object.entries(question.criteria).map(
              ([key, value]) => (value ? `${key}: ${value}` : key),
            );
            let optionLengths = options.map(
              (value) =>
                1 + Math.min(48, this.encode!(" " + scrub(value)).length),
            );
            let budget =
              this.config.head_max_len -
              optionLengths.reduce((sum, value) => sum + value, 0);
            if (budget < 16) {
              const per = Math.max(
                4,
                Math.floor(
                  (this.config.head_max_len - 16) / optionLengths.length,
                ),
              );
              optionLengths = optionLengths.map((value) =>
                Math.min(value, per),
              );
              budget =
                this.config.head_max_len -
                optionLengths.reduce((sum, value) => sum + value, 0);
            }
            const instruction =
              typeof question.instructions === "string"
                ? question.instructions
                : pyJson(question.instructions);
            const headerLength = this.encode(
              `${question.type} question: ${scrub(instruction)}`,
            ).length;
            const stateLength = this.encode(
              scrub(typeof state === "string" ? state : pyJson(state)),
            ).length;
            const total =
              Math.min(headerLength, Math.max(8, budget)) +
              optionLengths.reduce((sum, value) => sum + value, 0) +
              4 +
              stateLength;
            if (
              total > this.config.max_len ||
              headerLength > Math.max(8, budget)
            )
              throw new Error("입력이 모델 토큰 한도를 초과했습니다.");
          }
        const cleanState =
          typeof state === "string"
            ? state.replace(/<mask>/g, " ")
            : JSON.parse(JSON.stringify(state).replace(/<mask>/g, " "));
        return agent.systemOne(cleanState, questions);
      });
    this.queue = operation;
    return operation;
  }
  private decode(
    result: ModelResult,
    qid: string,
    allowed: string[],
    identity: string | null = null,
  ) {
    const answer = result.answers?.[qid],
      scores = answer?.probabilities,
      selected = answer?.choice;
    if (
      answer?.type !== "choice" ||
      !scores ||
      !selected ||
      !allowed.includes(selected) ||
      Object.keys(scores).length !== allowed.length ||
      allowed.some(
        (key) =>
          !Object.hasOwn(scores, key) ||
          !Number.isFinite(scores[key]) ||
          scores[key]! < 0 ||
          scores[key]! > 1,
      )
    )
      return this.abstain("모델 응답 형식을 검증할 수 없습니다.", identity);
    const values = Object.values(scores).sort((a, b) => b - a);
    if (
      Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02 ||
      scores[selected]! < values[0]!
    )
      return this.abstain("모델 후보 점수가 일관되지 않습니다.", identity);
    const uncertain =
      selected === "unknown" ||
      values[0]! < this.threshold ||
      values[0]! - values[1]! < this.margin ||
      !!result.usage?.truncated ||
      !!result.usage?.options;
    return this.decision(
      uncertain ? null : selected,
      identity,
      uncertain
        ? "입력 잘림 또는 불확실한 의미 판단입니다. 사용자 확인이 필요합니다."
        : "Laya 의미 분류 후보입니다. 실제 설정은 규칙으로 확인합니다.",
      { status: uncertain ? "REVIEW" : "PASS", scores },
    );
  }
  async parseQuery(text: string, context?: QueryContext, now = new Date(), timezone = "Asia/Seoul") {
    checkedText(text);

    return interpretQuery(text, context, now, timezone, async (state, questions) => {
      const result = await this.infer(state, questions);
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const decision = this.decode(result, id, Object.keys(question.criteria));
        return [id, { label: decision.label, scores: decision.scores }];
      }));
    }, () => this.modelVersion);
  }
  async classify(text: string): Promise<Decision> {
    try {
      if (!checkedText(text).trim())
        return this.abstain("질문이 비어 있습니다.");
    } catch {
      return this.abstain("질문의 문자열 형식 또는 인코딩을 확인해 주세요.");
    }

    try {
      return this.decode(
        await this.infer(text, INTENT_QUESTION),
        "intent",
        Object.keys(INTENTS),
      );
    } catch (error) {
      return this.abstain(
        error instanceof ModelReleaseError
          ? error.message
          : "Laya 의도 분류를 완료하지 못했습니다. 모델 파일과 입력 길이를 확인해 주세요.",
      );
    }
  }
  async judgeBatch(
    items: SemanticInput[],
    question: string,
  ): Promise<Decision[]> {
    const identities = items.map(semanticIdentity);
    if (new Set(identities).size !== identities.length)
      throw new Error("의미 판단 목록에 중복된 객체가 있습니다.");
    if (typeof question !== "string")
      return identities.map((identity) =>
        this.abstain("지원되는 단일 의미 질문을 선택해 주세요.", identity),
      );
    const domains = domainPatterns.flatMap((pattern, i) =>
      pattern.test(question) ? [i] : [],
    );
    if (
      domains.length !== 1 ||
      /(아닌|아니|제외|않|\bnot\b|\bwithout\b|\bexcept\b)/i.test(question)
    )
      return identities.map((identity) =>
        this.abstain("지원되는 단일 의미 질문을 선택해 주세요.", identity),
      );
    const [axis, target] = (
      [
        ["audience", "retargeting"],
        ["objective", "branding"],
        ["objective", "purchase"],
      ] as const
    )[domains[0]!]!;
    const definition: ChoiceQuestion = SEMANTIC_QUESTIONS[axis];
    const questions: Record<string, ChoiceQuestion> = {
      [axis]: definition,
      [`${axis}_reversed`]: {
        ...definition,
        criteria: Object.fromEntries(
          Object.entries(definition.criteria).reverse(),
        ),
      },
    };
    const decisions: Decision[] = [];
    // systemOne batches questions for one state. States remain sequential to bound CPU RAM.
    for (let offset = 0; offset < items.length; offset += this.batchSize) {
      for (
        let i = offset;
        i < Math.min(offset + this.batchSize, items.length);
        ++i
      ) {
        const item = items[i]!,
          identity = identities[i]!;
        let state: Record<string, string>;
        try {
          state = semanticState(item);
        } catch {
          decisions.push(
            this.abstain(
              "의미 입력의 문자열 형식 또는 인코딩을 확인해 주세요.",
              identity,
            ),
          );
          continue;
        }
        if (!Object.keys(state).length) {
          decisions.push(
            this.abstain("의미 판단에 필요한 정보가 없습니다.", identity),
          );
          continue;
        }
        if (containsModelInstruction(state)) {
          decisions.push(
            this.abstain(
              "광고 의도와 모델 응답 지시가 섞여 있어 판단을 보류했습니다.",
              identity,
            ),
          );
          continue;
        }

        try {
          const output = await this.infer(state, questions);
          const views = Object.keys(questions).map((qid) =>
            this.decode(
              output,
              qid,
              Object.keys(definition.criteria),
              identity,
            ),
          );
          if (views.some((view) => !Object.keys(view.scores).length)) {
            decisions.push(
              this.abstain("의미 선택지 점수를 검증할 수 없습니다.", identity),
            );
            continue;
          }
          const binary = views.map((view) => ({
            true: view.scores[target]!,
            false: Object.entries(view.scores)
              .filter(([label]) => label !== target && label !== "unknown")
              .reduce((sum, [, value]) => sum + value, 0),
            unknown: view.scores.unknown!,
          }));
          const scores = Object.fromEntries(
            ["true", "false", "unknown"].map((label) => [
              label,
              binary.reduce(
                (sum, value) => sum + value[label as keyof typeof value],
                0,
              ) / 2,
            ]),
          );
          const selected = top(scores),
            values = Object.values(scores).sort((a, b) => b - a);
          const conflict =
            target === "branding" &&
            selected === "true" &&
            commercialAwarenessConflict(state);
          const uncertain =
            conflict ||
            selected === "unknown" ||
            new Set(views.map((view) => top(view.scores))).size !== 1 ||
            new Set(binary.map(top)).size !== 1 ||
            scores[selected]! < this.threshold ||
            values[0]! - values[1]! < this.margin ||
            !!output.usage?.truncated ||
            !!output.usage?.options;
          decisions.push(
            this.decision(
              uncertain ? null : selected,
              identity,
              conflict
                ? "상품·상표 언급과 거래 행동만으로 인지도 목표를 확인할 수 없어 보류했습니다."
                : uncertain
                  ? "선택지 순서가 불안정하거나 정보·확신도가 부족해 판단을 보류했습니다."
                  : "대상·목표를 분리하고 정순/역순 선택지의 일관성을 확인한 Laya 후보입니다. 실제 설정은 별도로 확인하세요.",
              {
                scores,
                candidates: Object.fromEntries(
                  Object.keys(questions).map((qid, index) => [
                    qid,
                    views[index]!.scores,
                  ]),
                ),
                criterion_version: QUESTION_SCHEMA_VERSION,
              },
            ),
          );
        } catch (error) {
          decisions.push(
            this.abstain(
              error instanceof ModelReleaseError
                ? error.message
                : "Laya 의미 판단을 완료하지 못했습니다. 모델 파일과 입력 길이를 확인해 주세요.",
              identity,
            ),
          );
        }
      }
    }
    return decisions;
  }
}
