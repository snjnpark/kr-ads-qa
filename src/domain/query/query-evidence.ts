import type { QueryPlan } from "./query-model";
import { queryScopeText } from "../../lib/ad-products";
import { ACTIVE, INACTIVE } from "./query";

type FieldId = "daily" | "lifetime" | "status" | "end" | "name" | "created" | "id";
type Literals = { amounts: string[]; quotedStrings: string[]; dates?: unknown[] };
export type GroundedQueryFilter = {
  field_id: FieldId;
  filter: QueryPlan["filters"][number];
  span: [number, number];
  text: string;
};
type EvidenceOptions = {
  literalsFor?: (clause: string) => { amounts: string[] };
  requestRemainder?: (text: string) => string;
  literalFacts?: GroundedQueryFilter[];
  semantic?: QueryPlan["semantic"];
};
const quoted = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`/gu;
const mask = (text: string) => text.replace(quoted, value => " ".repeat(value.length));
const prefix = /^(?:\s*(?:(?:설정값|항목|금액|값|칸|란)(?:에는|에서|이|가|은|는|을|를|에|의)?|(?:설정|지정|입력|기입)(?:이|가|은|는|을|를)|(?:에는|에서|이|가|은|는|을|를|에|도|아직|아예|:)))*\s*/u;
const presenceForms: ["is_empty" | "is_not_empty", RegExp][] = [
  ["is_empty", /^(?:미\s*설정|미입력|미기입|공란|누락(?:된)?|빈|비어\s*(?:있는|있음)?|비워\s*둔|비었(?:던|음)?|빠져\s*있는|빠진|없는|없음|없(?=거나|고|으면|으며|든)|(?:(?:설정|입력|지정|기입))?(?:되지|하지)\s*않(?:은|는)|(?:설정|입력|지정|기입)\s*안\s*(?:된|한)|(?:입력|설정|기입|기재|지정)해\s*(?:두|놓)지\s*않(?:은|는)|안\s*(?:잡은|잡힌|정한)|잡(?:히)?지\s*않은)/u],
  ["is_not_empty", /^(?:(?:입력|설정|지정|기입)(?:해\s*(?:둔|놓은)|되어\s*있(?:는|음|(?=고|거나|으며|으면))|돼\s*있(?:는|음|(?=고|거나|으며|으면))|된|되어|한)|정해\s*둔|되어\s*있는|돼\s*있는|채워\s*(?:둔|놓은)|채워진|채운|존재하는|넣어\s*둔|들어\s*있(?:는|음|(?=고|거나|으며|으면))|된(?=\s|$)|있는|있음|있(?=고|거나|으며|으면))/u],
];
const doubleNegation = /아닌|아니라|없지|않지|(?:없|비어|미설정|미입력)[가-힣\s]{0,16}(?:않|아니)|않[가-힣\s]{0,12}(?:않|아니)/u;
function presenceMatch(clause: string) {
  const start = prefix.exec(clause)![0].length;
  const withState = (length: number) => length + (/^\s*상태인/u.exec(clause.slice(length))?.[0].length ?? 0);
  const explicitNotEmpty = /^(?:없지(?:는)?|비어\s*있지(?:는)?)\s*않(?:은|는)/u.exec(clause.slice(start));
  if (explicitNotEmpty) return { operator: "is_not_empty" as const, length: withState(start + explicitNotEmpty[0].length) };
  for (const [operator, pattern] of presenceForms) {
    const found = pattern.exec(clause.slice(start));
    if (!found) continue;
    const length = start + found[0].length;
    // 필드 바로 뒤의 술어를 감싼 명사구 부정만 반전한다. 다음 필드와 인용값은 호출부가 경계를 정한다.
    const inverse = /^\s*(?:인\s*)?(?:(?:것(?:이|은)|게|건|상태(?:가|는)|이|은)\s*)아닌/u.exec(clause.slice(length));
    if (inverse && /것(?:이|은)|게|건/u.test(inverse[0]) && /^\s*것/u.test(clause.slice(length + inverse[0].length)) && !/^\s*인\s*건\s*아닌$/u.test(inverse[0])) return;
    if (inverse) return { operator: operator === "is_empty" ? "is_not_empty" as const : "is_empty" as const, length: withState(length + inverse[0].length) };
    if (doubleNegation.test(clause)) return;
    return { operator, length: withState(length) };
  }
}
export const presenceEvidenceOperator = (clause: string) => presenceMatch(clause)?.operator;

const comparisons: [QueryPlan["filters"][number]["operator"], RegExp][] = [
  ["ne", /^인\s*(?:항목|것)(?:들)?(?:을|만)?\s*제외(?:해서|한|하고)/u],
  ["ne", /^(?:(?:이|가|은|는|도)\s*)?(?:아닌|아니면)/u],
  ["ne", /^(?:으로|로)\s*(?:잡|두|맞추|설정하|지정하|정하)지\s*않(?:은|는)/u],
  ["ne", /^(?:(?:보다|와|과)\s*)?(?:같지\s*않(?:은|는|으(?=면서)|으면)|다르게\s*(?:잡은|설정한|지정한)|다른(?:\s*금액인)?|동일하지\s*않(?:은|는|으(?=면서)|으면))/u],
  ["gte", /^(?:보다\s*)?(?:(?:작|적|낮)지\s*않(?:은|는|으(?=면서)|으면)|미만이\s*(?:아닌|아니면)|(?:크|많|높)거나\s*같(?:은|으면))/u],
  ["lte", /^(?:(?:보다|을|를)\s*)?(?:(?:크|많|높)지\s*않(?:은|는|으(?=면서)|으면)|넘지\s*않(?:은|는|으(?=면서)|으면)|초과가?\s*(?:아닌|아니면)|(?:작|적|낮)거나\s*같(?:은|으면))/u],
  ["gt", /^이하가?\s*(?:아닌|아니면)/u], ["lt", /^이상이\s*(?:아닌|아니면)/u],
  ["gte", /^(?:이상|부터)(?:인|이(?=면서)|이면)?/u], ["lte", /^(?:이하|까지)(?:인|이(?=면서)|이면)?/u],
  ["gt", /^(?:(?:보다|을|를)\s*)?(?:위인|초과(?:하는|하면|하(?=거나|고)|한|인|이면)?|큰|크면|많은|많으면|높은|높으면|넘어가는|넘는|넘은|넘으면|넘긴|넘(?=고(?=$|[\s,.;?!·]))|(?:크|많|높|넘)게)/u],
  ["lt", /^(?:(?:보다|에)\s*)?(?:아래(?:인)?|미만(?:인|이(?=면서)|이면)?|작은|작으면|적은|적으면|낮은|낮으면|(?:작|적|낮)게|못\s*미치는|미치지\s*못하는)/u],
  ["eq", /^(?:(?:와|과)\s*)?(?:정확히\s*)?(?:같은|같으면|동일한|동일하면|일치하는)/u],
  ["eq", /^(?:(?:으로|로)\s*(?:되어\s*있는|돼\s*있는|들어간|둔|잡힌|잡은|잡아\s*둔|맞춘|맞춰\s*둔|정한|지정한|등록한|설정(?:된|한|해\s*둔))|(?:을|를)\s*설정한|인(?=\s|$|캠페인|광고)|이(?=고|거나|며))/u],
];
function comparisonMatch(clause: string) {
  const start = /^\s*/u.exec(clause)![0].length;
  const comparisonStart = start + /^(?:기준\s*(?=보다)|더\s*)?/u.exec(clause.slice(start))![0].length;
  for (const [operator, pattern] of comparisons) {
    const found = pattern.exec(clause.slice(comparisonStart));
    if (found) {
      const suffix = /^(?:\s*에\s*해당하는|(?:\s*(?:으로|로))?\s*(?:설정한|설정해\s*둔|제한해서|잡아\s*둔|잡은|잡힌|정한|지정한))?/u.exec(clause.slice(comparisonStart + found[0].length))![0];
      return { operator, length: comparisonStart + found[0].length + suffix.length };
    }
  }
}
export const budgetEvidenceOperator = (clause: string) => comparisonMatch(clause)?.operator;
const amountToken = /^[+]?\s*(?:\d[\d,.]*(?:\s*[억만천백십]\s*(?:\d[\d,.]*)?)*|[영일이삼사오육칠팔구십백천만억열]+)\s*(?:원|달러|KRW|USD)?/iu;
const anchors: [FieldId, RegExp][] = [
  ["daily", /일\s*예\s*산|(?:하루|일일)(?:에)?\s*(?:(?:잡아\s*둔|정한|지정한|설정한)\s*)?예\s*산|예\s*산/gu], ["lifetime", /총\s*예\s*산|전체\s*예\s*산/gu],
  ["end", /종료\s*일|종료\s*날짜|끝나는\s*날짜/gu],
  ["name", /(?:표시\s*)?(?:(?:캠페인|광고\s*(?:그룹|세트)?|(?:애셋|에셋)\s*그룹|키워드|소재)\s*(?:이름|명칭|명)|이름|명칭|그룹명|세트명)(?=$|[\s:：=]|에서|에는|에|이|가|은|는|을|를|과|와|의)/gu],
  ["created", /생성(?:일|\s*날짜)?|만든|만들어진/gu], ["id", /\bID\b|아이디/giu],
];
const statusPattern = /(?:(?:운영\s*)?상태(?:가|는|:)?\s*)?(?:비\s*활\s*성(?:화)?(?:된|인)?|중지(?:된|됐|되어|돼|인)?|정지(?:된|인)?|집행(?:을)?\s*중단한|중단(?:된|인)?|멈[춘춰]|꺼져\s*있는|꺼진|꺼\s*(?:놓은|둔)|운영(?:을)?\s*(?:멈춘|중단한|하지\s*않는|안\s*하는|중(?:인)?)|활\s*성(?:화)?(?:된|인)?|켜져\s*있는|켜진|켜\s*(?:놓은|둔)|(?:사용|진행|집행)\s*중(?:인)?|\b(?:inactive|paused|disabled|active|enabled|running)\b)(?:\s*상태(?:인|면|며)?)?/giu;
const inactiveStatus = (value: string) => /비활성|중지|정지|중단|멈[춘춰]|꺼|하지않|안하는|inactive|paused|disabled/iu.test(value.replace(/\s+/gu, ""));

function nameMatch(clause: string, allowBare = false) {
  // An attached particle and an unquoted value have no proved boundary.
  const attachedParticle = /^(?:안에|에는|에서|에|이|가|은|는|을|를|과|와)/u.exec(clause)?.[0];
  if (allowBare && attachedParticle && !/^[\s'"“‘`]/u.test(clause.slice(attachedParticle.length))) return;
  const initial = (allowBare
    ? /^(?:\s*(?:안에|에는|에서|에|이|가|은|는|을|를|과|와|:)(?=\s|['"“‘`]))*\s*(?:(?:정확히|정확하게|딱)\s*)?/u
    : /^(?:\s*(?:안에|에는|에서|에|이|가|은|는|을|를|과|와|:))*\s*(?:(?:정확히|정확하게|딱)\s*)?/u).exec(clause)![0];
  const wrapper = /^(?:(?:대조하면|대조했을\s*때|확인하면|비교하면)\s*)?/u.exec(clause.slice(initial.length))![0];
  const start = initial.length + wrapper.length;
  const quotedOperand = /^(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|`([^`]+)`)/u.exec(clause.slice(start));
  const bare = allowBare && !quotedOperand ? /^[\p{L}\p{N}_./()-]{1,64}(?:\s+[\p{L}\p{N}_./()-]{1,64}){0,3}/u.exec(clause.slice(start))?.[0] : undefined;
  const operands = quotedOperand ? [{ value: quotedOperand.slice(1).find(value => value !== undefined)!, length: quotedOperand[0].length, quoted: true }]
    : bare ? Array.from({ length: bare.length }, (_, index) => ({ value: bare.slice(0, index + 1), length: index + 1, quoted: false })) : [];
  const patterns: ["eq" | "contains" | "not_contains", RegExp][] = [
    ["not_contains", /^(?:포함(?:되지|하지)\s*않(?:은|는)|포함\s*안\s*(?:된|한)|안\s*포함(?:된|한)|안\s*들어\s*있는|들어(?:가|있)?지\s*않(?:은|는)|들어\s*(?:가\s*)?있지\s*않(?:은|는)|안\s*들어간|제외(?:한|된)?|뺀|빠진|없(?=고|거나|든|으며)|없는)/u],
    ["contains", /^(?:포함(?:되면|되(?=고|거나)|되어\s*있는|된|하는|한)?|들어\s*(?:(?:가\s*)?있(?=고|거나|며)|가(?=고|거나|며)|(?:가\s*)?있는|가는|간|가야)|담긴|든|들(?=고)|있(?=고|거나|든)|있는)/u],
    ["eq", /^(?:(?:(?:와|과)\s*)?(?:(?:정확히|정확하게|완전히)\s*)?(?:같은|동일한|일치하는)|(?:으로|로)\s*둔|인(?=\s|$|캠페인|광고)|이(?=고|거나|며))/u],
  ];
  for (const operand of operands) {
    if (!operand.quoted && (/\s$/u.test(operand.value) || /(?:^|\s)(?:또는|혹은|그리고|아니면)(?:\s|$)/u.test(operand.value))) continue;
    const rest = clause.slice(start + operand.length);
    const particle = /^\s*(?:(?:(?:이라는|이란|라는|란)\s*)?(?:글자|문구|문자열|단어|말)(?:가|이)?|하고|가|이(?!고|거나|며)|을|를)?\s*/u.exec(rest)![0];
    const tail = rest.slice(particle.length);
    for (const [operator, pattern] of patterns) {
      const predicate = pattern.exec(tail);
      if (predicate) {
        if (!operand.quoted && operator === "eq" && /\s/u.test(operand.value)) continue;
        if (!operand.quoted && particle.trim()) {
          if (operator === "eq" && (/^인|^이(?=고|거나|며)/u.test(tail) || !/^(?:와|과|하고)$/u.test(particle.trim()))) continue;
          if (operator !== "eq" && !/^(?:이|가|을|를|(?:이라는|이란|라는|란)\s*(?:글자|문구|문자열|단어|말)(?:가|이)?)$/u.test(particle.trim())) continue;
        }
        const equivalence = operator === "eq" ? /^\s*것(?:과|와)\s*(?:(?:정확히|정확하게|완전히)\s*)?(?:일치하는|같은|동일한)/u.exec(tail.slice(predicate[0].length)) : null;
        const length = start + operand.length + particle.length + predicate[0].length + (equivalence?.[0].length ?? 0);
        if (!operand.quoted && !/^(?:$|\s|(?:고|거나|며|면서|든)(?=$|\s))/u.test(clause.slice(length))) continue;
        return { operator, value: operand.value, quoted: operand.quoted, length };
      }
    }
  }
}

const boundary = "(?=$|[\\s,.;?!·])";
const polite = "(?:주시겠습니까|주면\\s*(?:됩니다|돼)|주세요|주실래요?|주셔요|주어요|주시겠어요|주겠어|줄래요?|줘요?|볼래요?|할게요?|할래요?|합니다|하겠습니다|주십시오|바랍니다|줄\\s*수\\s*있(?:어요|어)|주실\\s*수\\s*있(?:나요|을까요)|주(?:시)?면\\s*좋겠(?:습니다|어요|어))";
const requestEnding = `(?:\\s*(?:(?:하고|고)\\s*싶(?:습니다|어요|어)|해\\s*(?:${polite})?|${polite}))?`;
const logicPhrases: ["AND" | "OR", RegExp][] = [
  ["OR", new RegExp(`^(?:(?:어느\\s*)?한쪽\\s*조건만\\s*(?:충족|만족)해도\\s*(?:됩니다|돼요|돼)|조건\\s*중\\s*하나를\\s*만족하는|한쪽에\\s*해당하는)${boundary}`, "u")],
  ["AND", new RegExp(`^(?:모두|전부)\\s*만족하는${boundary}`, "u")],
];
const carrierParts = [
  new RegExp(`^(?:이번\\s*확인\\s*대상은|검토\\s*대상은|점검\\s*메모\\s*:)${boundary}`, "u"),
  new RegExp(`^(?:(?:을|를)\\s*)?(?:살펴보려\\s*해|찾는\\s*중이야|세되|대상으로)${boundary}`, "u"),
  new RegExp(`^(?:경우에\\s*한해서|경우만\\s*포함한|전체\\s*목록에\\s*올라\\s*있는|계정에\\s*연결된|현재\\s*조회할\\s*수\\s*있는|해당\\s*연결\\s*범위에서\\s*확인\\s*가능한)${boundary}`, "u"),
  new RegExp(`^(?:것들입니다|입니다|수량을\\s*확인합니다|목록을\\s*받겠습니다|구분해서\\s*제시해\\s*주세요|서로)${boundary}`, "u"),
  new RegExp(`^(?:들의\\s*광고\\s*설정을|안에서|연동된\\s*모든\\s*매체에|연결\\s*범위에\\s*등록된|경우(?:만)?|검토\\s*대상은)${boundary}`, "u"),
  new RegExp(`^(?:는\\s*)?(?:총\\s*)?몇\\s*(?:개|건)(?:이야|인지|입니까)${boundary}`, "u"),
  new RegExp(`^(?:설정\\s*비교를\\s*요청합니다|사이\\s*설정이\\s*어떻게\\s*다른지|들\\s*사이\\s*차이점을\\s*제시해\\s*주세요|설정을\\s*나란히\\s*놓고|설정을\\s*서로\\s*대조한\\s*결과를|설정\\s*전체에\\s*대한|전반적으로|운영\\s*점검을\\s*위해)${boundary}`, "u"),
  new RegExp(`^(?:운영\\s*정책이\\s*어떻게\\s*정해져\\s*있는지|적용\\s*정책을\\s*확인하겠습니다|(?:을\\s*)?운영할\\s*때\\s*적용되는\\s*정책\\s*내용을|과거\\s*설정\\s*변경\\s*기록이\\s*필요합니다|설정\\s*변경이\\s*어떤\\s*기록으로\\s*남았는지|설정이\\s*바뀐\\s*이력을|확인할래|제시해\\s*주세요)${boundary}`, "u"),
  new RegExp(`^(?:(?:을|를)\\s*찾는\\s*검수\\s*규칙을|있으면\\s*검수하도록\\s*규칙을|(?:을|를)\\s*확인할\\s*규칙을\\s*만들고\\s*싶어|경우를\\s*검수하는\\s*새\\s*규칙을|(?:을|를)\\s*점검할\\s*규칙\\s*작성안을\\s*요청합니다|(?:을|를)\\s*잡는\\s*규칙을\\s*만들고\\s*싶어|경우를\\s*점검할\\s*규칙안을|(?:을|를)\\s*검사하는\\s*규칙\\s*작성안을\\s*요청합니다|는지\\s*확인할\\s*검수\\s*규칙을)${boundary}`, "u"),
  new RegExp(`^무엇인가요${boundary}`, "u"),
  // Preserve the detached endings used by the existing authored request wrappers.
  new RegExp(`^(?:인야|된야|않은야|야)${boundary}`, "u"),
  new RegExp(`^(?:받아\\s*(?:보고(?:\\s*싶(?:습니다|어요|어))?|볼(?:게요?)?)|쭉|아직|알아야\\s*합니다|필요합니다|원합니다|원해요|실행|상품|다시\\s*시작할래요)${boundary}`, "u"),
  new RegExp(`^(?:자세히|우선|혹시)${boundary}`, "u"),
  new RegExp(`^(?:조건\\s*경계까지\\s*확인해서|지\\s*확인할\\s*검수\\s*규칙을)${boundary}`, "u"),
  new RegExp(`^(?:점검표를\\s*작성합니다|경우만\\s*따로|예산\\s*검토입니다|(?:을\\s*)?금액으로\\s*대조합니다|목록에서|대상의\\s*목록을\\s*받겠습니다|전체에서|항목은\\s*합쳐서|점검에서|항목으로\\s*조회\\s*대상을\\s*한정합니다|간에\\s*설정이\\s*어떻게\\s*다른지|전반의\\s*설정을|설정의\\s*과거\\s*변경\\s*이력을\\s*요청합니다|이면서)${boundary}`, "u"),
  new RegExp(`^(?:(?:기재해|나열|선별|표시)\\s*바랍니다|기재해\\s*주세요)${boundary}`, "u"),
  new RegExp(`^오늘\\s*(?:보여|알려|조회|확인)${requestEnding}${boundary}`, "u"),
  new RegExp(`^(?:(?:으로|로)\\s*)?범위를\\s*한정${requestEnding}${boundary}`, "u"),
  new RegExp(`^(?:연결한\\s*범위에\\s*속하는|처음부터\\s*다시\\s*전체\\s*범위에서\\s*확인할|그\\s*안에서|목록\\s*대신\\s*개수로)${boundary}`, "u"),
  new RegExp(`^(?:어떤\\s*것들이|어떻게)\\s*등록(?:되어|돼)\\s*있(?:나요|는지|어)${boundary}`, "u"),
  new RegExp(`^(?:볼|알)\\s*수\\s*있(?:을까(?:요)?|나요)${boundary}`, "u"),
  new RegExp(`^(?:연결|올려)\\s*(?:해\\s*)?둔${boundary}`, "u"),
  new RegExp(`^(?:확인|조회|검색)(?:할\\s*건데|하려고\\s*(?:해|합니다))${boundary}`, "u"),
  new RegExp(`^(?:에\\s*)?어떤\\s*(?:운영\\s*)?정책이\\s*적용(?:되어|돼)\\s*있는지${boundary}`, "u"),
  new RegExp(`^(?:에\\s*)?(?:걸려\\s*있는|적용(?:된|되어\\s*있는|돼\\s*있는))\\s*(?:운영\\s*)?정책(?:을|은|이|의)?${boundary}`, "u"),
  new RegExp(`^(?:운영\\s*)?정책(?:은|는|이)?\\s*(?:어떤\\s*(?:게|것이|것)\\s*)?적용(?:돼|되어)\\s*있(?:나요|는지)${boundary}`, "u"),
  new RegExp(`^설정(?:이)?\\s*(?:바뀐\\s*기록|수정\\s*이력|괜찮은지)(?:을|은|이)?${boundary}`, "u"),
  new RegExp(`^(?:비교|검수|점검)(?:해서|하여)\\s*(?:확인|조회)${requestEnding}${boundary}`, "u"),
  new RegExp(`^(?:(?:운영|적용(?:한)?)\\s*정책|변경\\s*(?:이력|내역|기록))(?:을|를|은|는|의|부터)?${boundary}`, "u"),
  new RegExp(`^(?:찾고\\s*(?:있(?:습니다|어요|어)|싶(?:습니다|어요|어))|찾을래요?|찾습니다|찾겠습니다|보겠습니다|보겠어요|볼게요?|(?:보고|알고)\\s*싶(?:습니다|어요|어)|볼\\s*수\\s*있을까|궁금(?:합니다|해요|해)|있(?:나요|나)|(?:뭐가|무엇이)\\s*있(?:지|나요|습니까)|바랍니다)${boundary}`, "u"),
  /^(?:[\s,.;?!·]+)/u,
  new RegExp(`^(?:찾아|보여|알려|열람|실행|살펴(?:봐|보)?|표시|확인|검색|조회|나열|추려|골라|모아|세어|세(?=\\s*(?:줘|주세요|주실래요?|주십시오))|집계|비교|검수|점검|검사|제안|진행|열어)${requestEnding}${boundary}`, "iu"),
  new RegExp(`^(?:부탁(?:드릴게요|드립니다|드려요|해요|해|합니다|할게요?)?|요청(?:드립니다|합니다|해요|해)|할게요?|해|하는|할|주세요|주실래요|주시겠어요|주겠어|줘|세기)${boundary}`, "u"),
  new RegExp(`^(?:등록(?:되어|돼)\\s*있(?:는(?:지)?|나요)|등록된|등록한|조회\\s*가능한|들어\\s*있는|만들어\\s*둔|사용하는|연결된|방금\\s*(?:찾은|검색한)|모아서\\s*보고\\s*싶(?:습니다|어요|어)|검수하는|검수할|검사하는|점검할)${boundary}`, "u"),
  new RegExp(`^(?:규칙|룰)(?:을|를)?\\s*(?:제안|생성|작성)${requestEnding}${boundary}`, "u"),
  new RegExp(`^(?:문제가\\s*없는지|(?:에\\s*)?대해)${boundary}`, "u"),
  new RegExp(`^(?:목록|리스트|명단|전체|모든|전부|현재|지금|다시|도합|항목들?|대상들?|것들?|걸|결과|규칙|룰|정책|이력|계정|매체|개수|수량|하위|아래|가운데|중|조건|경우|차이|화면|설정값|설정|모두|검수|점검|검사)(?:들)?(?:들|만|부터|을|를|의|에|에서|이|가|은|는|인지|인|으로|로)?${boundary}`, "u"),
  new RegExp(`^(?:총\\s*)?(?:몇\\s*(?:개|건))(?:나|인지만|인지|입니까|인가요|일까요|야)?${boundary}`, "u"),
  new RegExp(`^(?:그\\s*중|이\\s*중|(?:그|이)\\s*결과(?:에서)?|방금|새로|처음부터|빠짐없이|한\\s*번(?:에)?|한번(?:에)?|얼마나\\s*돼(?:요)?|끼리|좀|함께|같이|따로|만|부터|쪽에|수(?:를|는|가)?|들(?:부터|을|만|의|이|은)?|인|을|를|의|에는|에서|에|이|가|은|는|요|과|와|있으면|이면|으면|있는지|있는|인가요|인지|또는|혹은|아니면|이거나|거나|든|그리고|면서|이고|이며|으며|고|및|동시에|AND|OR)${boundary}`, "iu"),
];

// 의미 요청의 종류가 먼저 증명된 때에만 그 종류에 해당하는 완전한 어구를 소비한다.
const mismatch = "(?:안\\s*맞는|맞지\\s*않는|불일치(?:하는|한)?|어긋(?:나는|난)|다른)";
const semanticCarriers: Record<NonNullable<QueryPlan["semantic"]>, RegExp[]> = {
  branding: [
    new RegExp(`^(?:브랜딩|브랜드\\s*인지도)\\s*(?:목적|의도)을\\s*가진${boundary}`, "u"),
    new RegExp(`^운영\\s*의도가\\s*브랜드를\\s*알리는\\s*데\\s*있는${boundary}`, "u"),
    new RegExp(`^브랜드\\s*인지도\\s*목적의${boundary}`, "u"),
    new RegExp(`^(?:브랜드\\s*(?:인지도|인지)|브랜딩)(?:를|을)?\\s*(?:목적|의도)(?:으로\\s*(?:운영하는|하는|한)|인)${boundary}`, "u"),
    new RegExp(`^브랜드\\s*인지도(?:를|을)?\\s*알리려는\\s*의도(?:의|인)?${boundary}`, "u"),
    new RegExp(`^브랜드(?:를|을)?\\s*(?:널리\\s*)?알리기\\s*위한${boundary}`, "u"),
    new RegExp(`^브랜드\\s*인지도(?:가\\s*운영\\s*목적인|\\s*향상을\\s*목적으로\\s*둔)${boundary}`, "u"),
  ],
  purchase_mismatch: [
    new RegExp(`^구매\\s*(?:목적|의도)인데\\s*최적화\\s*설정이\\s*${mismatch}${boundary}`, "u"),
    new RegExp(`^구매\\s*목적에\\s*맞지\\s*않는\\s*최적화${boundary}`, "u"),
    new RegExp(`^구매\\s*목적\\s*대비\\s*최적화가\\s*잘못된${boundary}`, "u"),
    new RegExp(`^구매\\s*(?:목적|의도)(?:과|와|에)\\s*(?:실제\\s*)?최적화\\s*(?:설정)?(?:이|가)?\\s*${mismatch}${boundary}`, "u"),
    new RegExp(`^구매\\s*(?:목적|의도)에\\s*${mismatch}\\s*(?:실제\\s*)?최적화\\s*설정(?:을\\s*가진|을|이|은)?${boundary}`, "u"),
    new RegExp(`^구매\\s*목적에\\s*맞지\\s*않게\\s*최적화된${boundary}`, "u"),
    new RegExp(`^구매(?:를\\s*목적으로\\s*했지만\\s*최적화가\\s*${mismatch}|라는\\s*운영\\s*목적에\\s*최적화\\s*설정이\\s*${mismatch})${boundary}`, "u"),
    new RegExp(`^설정된\\s*최적화가\\s*구매\\s*목적에\\s*${mismatch}${boundary}`, "u"),
  ],
  retarget: [
    new RegExp(`^(?:리타겟|재방문|기존\\s*(?:방문자|고객))\\s*(?:목적|의도)(?:과|와|에)\\s*(?:실제\\s*)?타겟\\s*(?:설정)?(?:이|가)?\\s*${mismatch}${boundary}`, "u"),
    new RegExp(`^재방문자(?:를\\s*겨냥했지만|\\s*대상이라는\\s*목적에)\\s*타겟\\s*설정이\\s*${mismatch}${boundary}`, "u"),
    new RegExp(`^의도한\\s*리타겟\\s*운영과\\s*실제\\s*타겟이\\s*${mismatch}${boundary}`, "u"),
  ],
};

// 알 수 없는 단어는 내부 글자를 지우지 않고 남은 입력 전체를 보존한다.
export function carrierResidual(text: string, semantic?: QueryPlan["semantic"]) {
  let cursor = 0;
  while (cursor < text.length) {
    const lengths = [...carrierParts, ...(semantic ? semanticCarriers[semantic] : [])].map(pattern => pattern.exec(text.slice(cursor))?.[0].length ?? 0);
    const consumed = Math.max(...lengths);
    if (!consumed) return text.slice(cursor).trim();
    cursor += consumed;
  }
  return "";
}

export function queryPlanRemainder(text: string, operation?: QueryPlan["operation"], semantic?: QueryPlan["semantic"]) {
  if (!["audit", "policy", "history"].includes(operation ?? "")) return carrierResidual(text, semantic);
  const clean = queryScopeText(text), characters = text.split("");
  // In an unfiltered workflow a field immediately qualifying its topic is not a predicate.
  for (const [, pattern] of anchors) for (const match of clean.matchAll(pattern)) {
    if (/^\s*(?:설정(?:값)?\s*)?(?:정책|가이드|이력|검수|점검|검사)(?=$|\s|을|를|이|가|의)/u.test(clean.slice(match.index + match[0].length)))
      characters.fill(" ", match.index, match.index + match[0].length);
  }
  return carrierResidual(characters.join(""), semantic);
}

/** Scope-stripped list/count requests use exactly the same closed carrier grammar. */
export function queryCarrierOperation(text: string): "find" | "count" | undefined {
  if (carrierResidual(text) || /정책|가이드|이력|규칙|룰|비교|검수|점검|검사|\bQA\b/iu.test(text)) return;
  if (/몇\s*(?:개|건)|개수|수량|(?:^|\s)수(?:를|는|가)(?=$|\s)|(?:^|\s)(?:세어|세(?=\s*(?:줘|주세요|주실래|주십시오)))/u.test(text)) return "count";
  if (/찾|보여|알려|열람|조회|검색|목록|리스트|명단|나열|등록(?:되어|돼)\s*있|볼\s*수|확인|무엇인가요/u.test(text)) return "find";
}

const epistemicPredicate = /(?:없지(?:는)?\s*않을|비어\s*있지(?:는)?\s*않을|없을|있을|아닐)\s*수\s*도\s*(?:있|없)|것\s*같(?:지|은|아|다|습)|(?:건지|것인지)\s*(?:없는|있는)\s*(?:건지|것인지)/u;
function hasUnrepresentedCondition(residual: string, unboundMarkers: string[], proof: { count: number; logic?: "AND" | "OR" }, semantic?: QueryPlan["semantic"]) {
  let clean = queryScopeText(residual);
  // The proved intent owns only its complete phrase; an extra setting after it remains an obligation.
  if (semantic) for (let cursor = 0; cursor < clean.length; cursor++) {
    if (cursor && !/[\s,.;?!]/u.test(clean[cursor - 1])) continue;
    const length = Math.max(0, ...semanticCarriers[semantic].map(pattern => pattern.exec(clean.slice(cursor))?.[0].length ?? 0));
    if (length) { clean = clean.slice(0, cursor) + " ".repeat(length) + clean.slice(cursor + length); cursor += length - 1; }
  }
  const clauses = clean.split(/(?<!\d)[,.]|[,.](?!\d)|[;!?]|그리고|또는|혹은|동시에|(?:것|걸|항목)(?:하고|과|와)|(?:^|\s)(?:고|으며|면서)(?=\s)/u);
  return clauses.some(clause => {
    // 이미 증명한 사실 뒤의 대상 확인 질문은 새로운 속성 술어가 아니다.
    if (proof.count && /^\s*(?:건|것(?:은|이))?\s*(?:어떤|어느)\s*것들?(?:이야|인가요|인지|입니까)\s*$/u.test(clause)) return false;
    // 아직 모델이 해석할 수 있는 명시 필드의 술어는 이 검사에서 대신 결정하지 않는다.
    if (unboundMarkers.some(marker => clause.includes(marker))) return false;
    if (/\d[^;!?]{0,40}(?:이상|이하|초과|미만|보다|같지|같은|일치)/u.test(clause)) return true;
    if (/(?:조건|기준)(?:도|을|를|이|가)?\s*(?:적용|추가|만족|해당)/u.test(clause)) return true;
    for (const match of clause.matchAll(/([가-힣]+)\s*(것(?:들)?|걸|항목|대상|조건)(?=$|\s|[이가은는을를만도중,.;?!])/gu)) {
      const word = match[1];
      if (!carrierResidual(word)) continue;
      const last = word.charCodeAt(word.length - 1) - 0xac00;
      const final = last % 28;
      // 관형형의 ㄴ/ㄹ 받침과 명시적인 조건 명사는 소유되지 않은 선택 술어다.
      if (match[2] === "조건" || final === 4 || final === 8) return true;
    }
    return false;
  });
}

export function analyzeQueryEvidence(text: string, literals: Literals, options: EvidenceOptions = {}) {
  const clean = queryScopeText(text), filters: GroundedQueryFilter[] = [...(options.literalFacts ?? [])], unresolved: string[] = [], ambiguities: string[] = [];
  if (epistemicPredicate.test(clean)) ambiguities.push("ambiguous_scope");
  const all = anchors.flatMap(([field_id, pattern]) => [...(field_id === "name" ? mask(text) : clean).matchAll(pattern)].map(found => ({ field_id, start: found.index, end: found.index + found[0].length, marker: found[0] })));
  const displayed = all.flatMap(item => {
    const display = /^(?:을|를|도)?\s*(?:(?:함께|같이)\s*)?(?:보여|표시|알려|출력)/u.exec(clean.slice(item.end));
    return display ? [[item.start, item.end + display[0].length] as [number, number]] : [];
  });
  const fields = all.filter(item => !/^(?:을|를|도)?\s*(?:(?:함께|같이)\s*)?(?:보여|표시|알려|출력)/u.test(clean.slice(item.end)) &&
    !all.some(other => other.start <= item.start && other.end >= item.end && other.end - other.start > item.end - item.start) &&
    !filters.some(fact => fact.field_id === item.field_id && fact.span[0] < item.end && fact.span[1] > item.start));
  for (const found of clean.matchAll(statusPattern)) {
    const baseEnd = found.index + found[0].length;
    // '중지하지 않고 운영 중인'의 앞부분은 독립 중지 조건이 아니다.
    if (/^하지\s*않고/u.test(clean.slice(baseEnd))) continue;
    const suffix = /^(?:으로|로)\s*운영하는/u.exec(clean.slice(baseEnd))?.[0] ?? "";
    const end = baseEnd + suffix.length;
    fields.push({ field_id: "status", start: found.index, end, marker: clean.slice(found.index, end) });
  }
  fields.sort((left, right) => left.start - right.start);
  for (let index = fields.length - 1; index > 0; index--) {
    const before = fields[index - 1], current = fields[index];
    if (before.field_id === "status" && current.field_id === "status" && inactiveStatus(before.marker) === inactiveStatus(current.marker) &&
        /^(?:\s|으로|로|인|상태로|상태인)*$/u.test(clean.slice(before.end, current.start))) {
      before.end = current.end;
      before.marker = text.slice(before.start, before.end);
      fields.splice(index, 1);
    }
  }
  const relevant_fields = [...new Set([...fields.map(item => item.field_id), ...filters.map(item => item.field_id)])];
  let statusEvidence = clean;
  for (const [index, anchor] of fields.entries()) {
    if (!["daily", "lifetime", "end"].includes(anchor.field_id)) continue;
    const presence = presenceMatch(clean.slice(anchor.end, fields[index + 1]?.start ?? clean.length));
    if (presence) {
      const end = anchor.end + presence.length;
      statusEvidence = statusEvidence.slice(0, anchor.start) + " ".repeat(end - anchor.start) + statusEvidence.slice(end);
    }
  }
  if (/(?:상태(?:가|는|를|:)|운영\s*상태)/u.test(statusEvidence) && !relevant_fields.includes("status")) { relevant_fields.push("status"); unresolved.push("status:unrecognized"); }
  for (const field of relevant_fields) if (fields.filter(item => item.field_id === field).length + filters.filter(item => item.field_id === field).length > 1) ambiguities.push(`${field}:multiple_predicates`);
  const sharedAnchors = new Set<number>();
  let sharedConjunction = false;
  const presenceField = (field: FieldId): QueryPlan["filters"][number]["field"] => field === "daily" ? "budget.daily" : field === "lifetime" ? "budget.lifetime" : "schedule.end";
  const supportsPresence = (field: FieldId) => ["daily", "lifetime", "end"].includes(field);
  for (let start = 0; start < fields.length - 1; start++) {
    if (sharedAnchors.has(start) || !supportsPresence(fields[start].field_id)) continue;
    if (supportsPresence(fields[start + 1].field_id) && /^\s*(?:이나|나|혹은|또는|아니면)\s*$/u.test(clean.slice(fields[start].end, fields[start + 1].start)))
      ambiguities.push("ambiguous_field_attachment");
    let end = start;
    while (end + 1 < fields.length && supportsPresence(fields[end + 1].field_id) &&
        /^\s*(?:과|와|및)\s*$/u.test(clean.slice(fields[end].end, fields[end + 1].start))) end++;
    if (end === start) continue;
    const members = fields.slice(start, end + 1);
    if (members.some(item => ambiguities.includes(`${item.field_id}:multiple_predicates`))) continue;
    const external = (options.literalFacts ?? []).filter(item => item.span[0] >= fields[end].end).map(item => item.span[0]);
    const bound = Math.min(fields[end + 1]?.start ?? text.length, ...external);
    const clause = mask(text.slice(fields[end].end, bound));
    if (doubleNegation.test(clause)) continue;
    const initial = prefix.exec(clause)![0].length;
    const quantifier = /^(?:(?:모두|둘\s*다|전부)\s*)?/u.exec(clause.slice(initial))![0].length;
    const presence = presenceMatch(clause.slice(initial + quantifier));
    if (!presence) continue;
    const length = initial + quantifier + presence.length;
    if (/말고|나머지|아닌|아니|제외|않|(?:^|\s)안(?:\s|$)/u.test(clause.slice(length))) continue;
    const span: [number, number] = [fields[start].start, fields[end].end + length];
    // 병렬 필드들은 하나의 공유 술어 구간을 참조한다. 필드 위치에 술어를 복제하지 않는다.
    for (let index = start; index <= end; index++) {
      const field_id = fields[index].field_id;
      filters.push({ field_id, filter: { field: presenceField(field_id), operator: presence.operator }, span, text: text.slice(...span) });
      sharedAnchors.add(index);
    }
    sharedConjunction = true;
  }
  for (const [index, anchor] of fields.entries()) {
    if (sharedAnchors.has(index) || ambiguities.includes(`${anchor.field_id}:multiple_predicates`)) continue;
    const followingLiterals = (options.literalFacts ?? []).filter(item => item.span[0] >= anchor.end).map(item => item.span[0]);
    const bound = Math.min(fields[index + 1]?.start ?? text.length, ...followingLiterals);
    const clause = text.slice(anchor.end, bound);
    if (epistemicPredicate.test(mask(clause))) { unresolved.push(`${anchor.field_id}:unresolved`); continue; }
    let filter: QueryPlan["filters"][number] | undefined, length = 0;
    if (anchor.field_id === "status") {
      const rest = clean.slice(anchor.end, bound);
      const wasInactive = inactiveStatus(anchor.marker);
      const negation = /^\s*(?:하지\s*않(?:은|는)|(?:(?:것(?:은|이)|건|게|이|가)\s*)?아닌)(?=$|\s|야(?=[.;?!]|$))/u.exec(rest)
        ?? (!wasInactive ? /^\s*되지\s*않(?:은|는)(?=$|\s)/u.exec(rest) : null);
      if (!negation && /^(?:\s|것|들|은|는|이|가|되|하|지|된|인)*(?:아닌|아니라|말고|제외|않|안)/u.test(rest)) ambiguities.push("status:ambiguous_predicate");
      else {
        const negative = wasInactive !== !!negation;
        filter = { field: "status", operator: "in", value: negative ? INACTIVE : ACTIVE };
        length = negation?.[0].length ?? 0;
      }
    } else if (anchor.field_id === "name") {
      if ([...clause.matchAll(quoted)].length > 1) ambiguities.push("name:multiple_operands");
      else {
        let found = nameMatch(clause);
        if (!found) {
          const before = text.slice(0, anchor.start);
          const operand = [...before.matchAll(quoted)].at(-1);
          if (operand && !fields.some(item => item.start > operand.index && item.start < anchor.start) &&
              !filters.some(item => item.span[1] > operand.index && item.span[0] < anchor.start) &&
              /^\s*(?:(?:이라는|라는|란)(?:\s*(?:글자|문구|문자열|단어|말)(?:가|이)?)?|을|를|가|이)?\s*$/u.test(before.slice(operand.index + operand[0].length))) {
            const particle = /^(?:\s*(?:안에|에는|에서|에|이|가|은|는|을|를))*\s*/u.exec(clause)![0];
            const definition = /^\s*(?:이라는|라는|란)\s*$/u.test(before.slice(operand.index + operand[0].length)) && /^\s*의(?=\s|$)/u.exec(clause);
            const reverse = nameMatch(operand[0] + clause.slice(particle.length));
            if (definition) {
              const value = /^(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|`([^`]+)`)/u.exec(operand[0])!.slice(1).find(value => value !== undefined)!;
              found = { operator: "eq", value, quoted: true, length: definition[0].length };
              anchor.start = operand.index;
            } else if (reverse) {
              found = { ...reverse, length: particle.length + reverse.length - operand[0].length };
              anchor.start = operand.index;
            }
          }
        }
        if (!found) found = nameMatch(clause, true);
        if (!found) {
          const before = text.slice(0, anchor.start);
          const remainder = options.requestRemainder?.(before) ?? before;
          const operand = /^\s*([\p{L}\p{N}_./()-]{1,64})\s*$/u.exec(remainder);
          if (operand) {
            const reverse = nameMatch(operand[1] + clause, true);
            if (reverse) {
              found = { ...reverse, length: reverse.length - operand[1].length };
              anchor.start = before.lastIndexOf(operand[1]);
            }
          }
        }
        if (found && (!found.quoted || literals.quotedStrings.includes(found.value))) { filter = { field: "name", operator: found.operator, value: found.value }; length = found.length; }
      }
    } else if (["daily", "lifetime", "end"].includes(anchor.field_id)) {
      const field = anchor.field_id === "daily" ? "budget.daily" : anchor.field_id === "lifetime" ? "budget.lifetime" : "schedule.end";
      if (anchor.field_id !== "end" && (options.literalsFor?.(mask(clause)).amounts.length ?? 0) > 1) {
        ambiguities.push(`${anchor.field_id}:multiple_operands`);
        unresolved.push(`${anchor.field_id}:unresolved`);
        continue;
      }
      const presence = presenceMatch(mask(clause));
      if (presence) { filter = { field, operator: presence.operator }; length = presence.length; }
      else if (anchor.field_id !== "end") {
        const initial = prefix.exec(clause)![0].length;
        const wrapper = /^(?:(?:으로\s*보면|로\s*보면|대조했을\s*때|비교하면|대조하면|확인하면)\s*)?/u.exec(clause.slice(initial))![0].length;
        const quantifier = /^(?:(?:정확히|정확하게|딱|최소|최대)\s*)?/u.exec(clause.slice(initial + wrapper))![0];
        const start = initial + wrapper + quantifier.length;
        const amount = amountToken.exec(clause.slice(start));
        const tail = amount ? clause.slice(start + amount[0].length) : "";
        const comparison = amount && (comparisonMatch(tail) ??
          (!carrierResidual(options.requestRemainder?.(tail) ?? tail) ? { operator: "eq" as const, length: 0 } : undefined));
        if (amount && comparison) {
          const part = clause.slice(0, start + amount[0].length + comparison.length);
          const values = options.literalsFor?.(part).amounts ?? (literals.amounts.length === 1 ? literals.amounts : []);
          if (options.literalsFor?.(mask(clause.slice(part.length))).amounts.length) ambiguities.push(`${anchor.field_id}:multiple_operands`);
          else if (values.length === 1 && literals.amounts.includes(values[0])) {
            const limit = /최소|최대/u.test(quantifier) ? quantifier.includes("최소") ? "gte" : "lte" : undefined;
            if (limit && comparison.operator !== "eq" && comparison.operator !== limit) {
              ambiguities.push(`${anchor.field_id}:multiple_predicates`);
              continue;
            }
            const operator = comparison.operator === "eq" && limit ? limit : comparison.operator;
            filter = { field, operator, value: values[0] }; length = part.length;
          }
        }
      }
      if (anchor.field_id !== "end" && (!filter || ["is_empty", "is_not_empty"].includes(filter.operator))) {
          const before = clean.slice(0, anchor.start);
          const preceding = /([+]?\d[\d,.]*(?:\s*[억만천백십]\s*(?:\d[\d,.]*)?)*\s*(?:원|달러|KRW|USD)?)\s*(보다|이상으로|이하로)\s*$/iu.exec(before);
          if (preceding && !filters.some(fact => fact.span[0] < anchor.start && fact.span[1] > preceding.index) &&
              (index === 0 || filters.some(fact => fact.span[0] <= fields[index - 1].start && fact.span[1] >= fields[index - 1].end && fact.span[1] <= preceding.index))) {
            const values = options.literalsFor?.(preceding[1]).amounts ?? [];
            const subject = /^(?:\s*(?:의|을|를|이|가|금액|값))*\s*/u.exec(clause)![0].length;
            const setter = /^(?:잡은|설정한|정한|지정한)/u.exec(clause.slice(subject));
            const compared = preceding[2] === "보다" ? comparisonMatch(clause.slice(subject)) : setter ? { operator: preceding[2] === "이상으로" ? "gte" as const : "lte" as const, length: setter[0].length } : undefined;
            if (values.length === 1 && compared) {
              filter = { field, operator: compared.operator, value: values[0] };
              anchor.start = preceding.index; length = subject + compared.length;
            } else { filter = undefined; ambiguities.push(`${anchor.field_id}:multiple_predicates`); }
          } else if (preceding) {
            filter = undefined; ambiguities.push("ambiguous_field_attachment");
          }
      }
      if (filter && anchor.field_id === "daily" && /^예\s*산$/u.test(anchor.marker) && typeof filter.value === "string" &&
          !/원|달러|\bKRW\b|\bUSD\b/iu.test(mask(text.slice(anchor.start, anchor.end + length)))) unresolved.push("daily:currency_unspecified");
      if (doubleNegation.test(mask(clause)) && !filter) ambiguities.push(`${anchor.field_id}:ambiguous_predicate`);
    }
    if (filter && /말고|나머지|아닌|아니|제외|않|(?:^|\s)안(?:\s|$)/u.test(mask(clause.slice(length)))) {
      ambiguities.push(`${anchor.field_id}:ambiguous_predicate`);
      filter = undefined;
    }
    if (filter) filters.push({ field_id: anchor.field_id, filter, span: [anchor.start, anchor.end + length], text: text.slice(anchor.start, anchor.end + length) });
    else unresolved.push(`${anchor.field_id}:unresolved`);
  }
  for (const operand of text.matchAll(quoted)) {
    if (filters.some(fact => fact.span[0] <= operand.index && fact.span[1] >= operand.index + operand[0].length)) continue;
    const nextField = fields.find(field => field.start > operand.index)?.start ?? text.length;
    const found = nameMatch(text.slice(operand.index, nextField));
    if (!found || found.operator === "eq" || !literals.quotedStrings.includes(found.value)) continue;
    let before = text.slice(0, operand.index);
    for (const fact of filters.filter(fact => fact.span[1] <= operand.index))
      before = before.slice(0, fact.span[0]) + " ".repeat(fact.span[1] - fact.span[0]) + before.slice(fact.span[1]);
    // A bare quoted predicate owns a name only after proved scope/request phrases and earlier facts.
    if (carrierResidual(options.requestRemainder?.(before) ?? before, options.semantic)) continue;
    const span: [number, number] = [operand.index, operand.index + found.length];
    filters.push({ field_id: "name", filter: { field: "name", operator: found.operator, value: found.value }, span, text: text.slice(...span) });
    if (!relevant_fields.includes("name")) relevant_fields.push("name");
  }
  if (filters.filter(fact => fact.field_id === "name").length > 1) ambiguities.push("name:multiple_predicates");
  filters.sort((left, right) => left.span[0] - right.span[0]);
  let remainder = text;
  const proofUnits = [...new Map(filters.map(item => [item.span.join(":"), item])).values()];
  for (const item of [...proofUnits].sort((left, right) => right.span[0] - left.span[0])) remainder = remainder.slice(0, item.span[0]) + " ".repeat(item.span[1] - item.span[0]) + remainder.slice(item.span[1]);
  for (const [start, end] of displayed) remainder = remainder.slice(0, start) + " ".repeat(end - start) + remainder.slice(end);
  let residual = options.requestRemainder?.(remainder) ?? remainder;
  const logic_evidence: { logical_operator: "AND" | "OR"; span: [number, number]; text: string }[] = [];
  const visible = mask(residual);
  for (let cursor = 0; cursor < visible.length; cursor++) {
    if (cursor && !/[\s,.;?!]/u.test(visible[cursor - 1])) continue;
    for (const [logical_operator, pattern] of logicPhrases) {
      const phrase = pattern.exec(visible.slice(cursor));
      if (phrase) {
        const span: [number, number] = [cursor, cursor + phrase[0].length];
        logic_evidence.push({ logical_operator, span, text: text.slice(...span) });
        cursor = span[1] - 1;
        break;
      }
    }
  }
  // A suffix may quantify the one fully grounded condition set, not an unknown or partial clause.
  if (logic_evidence.length) {
    let quantified = residual;
    for (const { span: [start, end] } of logic_evidence) quantified = quantified.slice(0, start) + " ".repeat(end - start) + quantified.slice(end);
    const owned = filters.length > 1 && logic_evidence.every(item => item.span[0] >= proofUnits.at(-1)!.span[1]) &&
      fields.every(anchor => filters.some(fact => fact.field_id === anchor.field_id && fact.span[0] <= anchor.start && fact.span[1] >= anchor.end)) &&
      !carrierResidual(quantified, options.semantic);
    if (owned) residual = quantified;
    else ambiguities.push("mixed_logic");
  }
  const gaps = proofUnits.slice(1).map((item, index) => mask(text.slice(proofUnits[index].span[1], item.span[0])).replace(/[,.;:!?·]/gu, " "));
  const hasOr = logic_evidence.some(item => item.logical_operator === "OR") || gaps.some(gap => /또는|혹은|아니면|이거나|거나|든|\bOR\b/iu.test(gap));
  const hasAnd = logic_evidence.some(item => item.logical_operator === "AND") || sharedConjunction || gaps.some(gap => /중|가운데|그리고|면서|이고|이며|(?:^|\s)고(?:\s|$)|및|동시에|\bAND\b/iu.test(gap));
  if (filters.length > 1 && hasOr && hasAnd) ambiguities.push("mixed_logic");
  if (filters.length > 1 && /[()（）]/u.test(mask(residual))) ambiguities.push("nested_logic");
  const logical_operator = ambiguities.some(item => item === "mixed_logic" || item === "nested_logic") ? undefined : hasOr ? "OR" as const : "AND" as const;
  const remaining = carrierResidual(residual, options.semantic);
  if (remaining) {
    unresolved.push(`residual:${remaining}`);
    const unboundMarkers = fields.filter(anchor => !filters.some(fact => fact.field_id === anchor.field_id && fact.span[0] <= anchor.start && fact.span[1] >= anchor.end))
      .map(anchor => anchor.field_id === "name" ? anchor.marker.match(/이름|명칭|그룹명|세트명|명$/u)![0] : anchor.marker);
    if (hasUnrepresentedCondition(residual, unboundMarkers, { count: filters.length, logic: logical_operator }, options.semantic)) ambiguities.push("unrepresented_condition");
  }
  return { filters, relevant_fields, logical_operator, complete: !unresolved.length && !ambiguities.length, unresolved, ambiguities, residual, logic_evidence };
}
