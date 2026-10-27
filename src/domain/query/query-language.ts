// Closed grammatical units compose across clauses; unknown text remains an obligation.
const edge = "(?=$|[\\s,.;?!:：]|(?:고|거나|으며|면서|든)(?=$|\\s))";
const please = "(?:줘요?|주세요|주십시오|주시겠(?:어요|습니까)|주실래요?|줄래요?|주시면\\s*좋겠(?:어요|습니다))";
const want = "(?:싶(?:어(?:요)?|습니다|은\\s*(?:거|것)(?:야|이야|입니다)))";
const polite = `(?:${please}|부탁(?:해(?:요)?|드립니다|드려요)|요청(?:해(?:요)?|합니다|할게(?:요)?)|바랍니다)`;
const finish = `(?:${please}|할게(?:요)?|하겠습니다|합니다|해(?:요)?|하고\\s*${want}|하려고\\s*(?:해(?:요)?|합니다)|하고자\\s*합니다|하기를?\\s*${polite})`;
const readNoun = "(?:조회|검색|확인|열람|나열|열거|제시|표시|선별)";
const readInflected = "(?:찾아|보여|알려|추려|골라|모아|가져와|살펴봐|열어)";
const readPredicate = `(?:${readNoun}(?:${finish}|(?:을|를)?\\s*${polite}|해\\s*${please}|하(?:고|는|려는|려던)(?=$|\\s))?|${readInflected}(?:\\s*${please}|\\s*바랍니다|봐(?:요)?|볼게(?:요)?)|(?:받아)?보(?:고\\s*${want}|려는|려던|고자\\s*합니다))`;
const requestObject = "(?:(?:전체|모든|전부|모두)\\s*)?(?:목록|리스트|항목|것)(?:들)?(?:에\\s*대한|의|을|를|은|는|이|가|으로|로)?\\s*";
const request = new RegExp(`^(?:(?:좀|다시|한번|한\\s*번|우선)\\s*)?(?:${requestObject})?(?:${readPredicate}|${readNoun}(?:을|를)?\\s*(?:부탁|요청)(?:드립니다|합니다|해(?:요)?)|(?:어떻게\\s*(?:돼|되나요)|(?:뭐|무엇)(?:야|인가요)|궁금(?:해(?:요)?|합니다)))${edge}`, "u");

export function requestPhraseLength(text: string): number {
  return request.exec(text)?.[0].length ?? 0;
}

export function explicitReadRequest(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (index && !/[\s,.;?!:：]/u.test(text[index - 1])) continue;
    if (requestPhraseLength(text.slice(index))) return true;
  }
  return false;
}

const setting = "(?:설정|입력|지정|기입|기재|배정|등록)";
const negative = "(?:않(?:은|는)|안\\s*(?:된|한))";
const setPositive = `(?:${setting}(?:해\\s*(?:둔|놓은)|(?:되어|돼)\\s*있(?:는|음)|된|한)|(?:정해|적어|써|넣어|채워)\\s*(?:둔|놓은)|(?:정해져|채워져|적혀|써)\\s*있는)`;
const setNegative = `(?:${setting}(?:하지|되지|(?:되어|돼)\\s*있지)\\s*${negative}|정해\\s*(?:두|놓)지\\s*${negative}|정해져\\s*있지\\s*${negative}|채워져\\s*있지\\s*${negative})`;
export const settingPresenceForms: ["is_empty" | "is_not_empty", RegExp][] = [
  ["is_empty", new RegExp(`^(?:${setNegative}|(?:미설정|미입력|미기재|공란|누락)(?:인|된|이야|입니다|이다|되어\\s*있는)?|비어\\s*있(?:는|음))${edge}`, "u")],
  ["is_not_empty", new RegExp(`^(?:${setPositive}|존재하(?:는|고)|들어가\\s*있(?:는|음)|(?:설정|입력|지정)(?:이야|입니다|이다|인|(?=과|와|이거나|이고|이며)))${edge}|^(?:설정|입력|지정)(?=과|와|이거나|이고|이며)`, "u")],
];

export function settingPrefixLength(text: string, endField = false): number {
  const noun = endField ? "(?:날짜|시점|날짜\\s*값|설정값|입력값|값|금액|칸|란|항목)" : "(?:기준\\s*금액|설정값|입력값|값|금액|칸|란|항목)";
  return new RegExp(`^(?:\\s*(?:${noun}(?:에는|에서|이|가|은|는|을|를|에|의)?|에는|에서|이|가|은|는|을|를|에|의|도|아직|아예|:))*\\s*`, "u").exec(text)![0].length;
}

export const composedComparisonForms: ["eq" | "ne" | "gt" | "gte" | "lt" | "lte", RegExp][] = [
  ["gte", /^(?:와|과)\s*같거나\s*(?:더\s*)?(?:큰|높은|많은)(?:\s*금액인)?/u],
  ["lte", /^(?:와|과)\s*같거나\s*(?:더\s*)?(?:작은|낮은|적은)(?:\s*금액인)?/u],
  ["ne", /^(?:(?:와|과)\s*)?일치하지\s*않(?:은|는)/u],
];

const targetAction = `(?:${readNoun}(?:할|하려는|하려던|하고\\s*싶은|하려고\\s*하는)?|찾(?:을|으려는)|(?:살펴)?볼|(?:보|살펴보)고\\s*싶은|(?:개수를\\s*)?셀)`;
const targetKind = "(?:대상|항목)(?:\\s*종류)?|종류";
const targetLabel = `(?:(?:${targetKind})(?:(?:이라는\\s*말|이라고\\s*한\\s*것))?(?:은|는|을|:|：)|(?:조회|검색|확인|찾으려는)(?:할)?\\s*것(?:은|이))`;
const targetHead = `(?:(?:이번(?:에(?:는)?)?|지금|현재|먼저)\\s*)?(?:(?:개수|수량)(?:를|을)\\s*)?(?:${targetAction}\\s*)?(?:목록의\\s*)?${targetLabel}\\s*|(?:(?:이번|현재)\\s*)?${readNoun}(?:은|는)\\s*`;
const identityEnding = "(?:뿐)?(?:이야|입니다|이에요|예요|이다|이고|이며|야)";
const selectEnding = "(?:으로|로)\\s*(?:할게(?:요)?|합니다|정(?:했어|할게(?:요)?|합니다|하고)|잡(?:고|을게(?:요)?)|삼(?:을게(?:요)?|고)|지정(?:할게(?:요)?|합니다))";
const subject = "([^.;!?\\n,]+?)", clauseEnd = "(?=\\s*(?:[.;!?\\n,]|$))";
export const targetDeclarationFrames = [
  new RegExp(`(?<![\\p{L}\\p{N}_])(${targetHead})${subject}(${identityEnding}|${selectEnding}|(?:을|를)\\s*(?:뜻해|대상으로\\s*합니다))${clauseEnd}`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}_])(${targetHead})${subject}(${selectEnding})(?=\\s|$)`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}_])((?:${targetAction}\\s*)?(?:대상|항목)[:：]\\s*)${subject}()${clauseEnd}`, "gu"),
  new RegExp(`(?:^|(?<=[.;!?\\n,]))(\\s*(?:(?:이번(?:에(?:는)?)?|지금|현재)\\s*)?)${subject}((?:이|가)?\\s*(?:${targetAction}\\s*)?대상${identityEnding}|(?:을|를)\\s*(?:${readNoun}\\s*)?대상(?:${selectEnding}|으로(?:\\s*해서)?))(?=\\s|$|[.;!?\\n,])`, "gu"),
  new RegExp(`(?:^|(?<=[.;!?\\n,]))(\\s*)${subject}(${identityEnding})${clauseEnd}`, "gu"),
];

const satisfaction = "(?:(?:만족|충족|성립|해당)하(?:는|면)|맞(?:는|으면|아도))";
const conditionGroup = "(?:(?:이|그)\\s*)?(?:(?:두|세)\\s*(?:가지|조건)(?:를|을)?\\s*)?";
export const quantifiedLogicForms: ["AND" | "OR", RegExp][] = [
  ["AND", new RegExp(`^${conditionGroup}(?:모두|전부|함께|동시에|둘\\s*다)(?:를|가|이)?\\s*${satisfaction}${edge}`, "u")],
  ["OR", new RegExp(`^(?:조건\\s*)?(?:(?:중|가운데)\\s*)?(?:(?:최소\\s*)?하나\\s*이상|최소\\s*하나|어느\\s*쪽이든|한\\s*개라도)(?:을|이|가)?\\s*${satisfaction}${edge}`, "u")],
];

const operationRoots: Record<string, string> = {
  compare: "(?:비교|대조)", audit: "(?:검수|점검|검사)", policy: "(?:검토|확인|조회|살펴봐)",
  history: "(?:열람|조회|확인)", create_rule: "(?:제안|작성|생성)",
};
const operationPatterns = Object.fromEntries(Object.entries(operationRoots).map(([key, root]) => [key, new RegExp(`^(?:${root})(?:${finish}|(?:을|를)?\\s*${polite}|해\\s*${please})${edge}`, "u")]));
const ruleRole = new RegExp(`^(?:여부(?:를)?\\s*)?(?:판정|검사|확인|점검)(?:할|하는|하도록)\\s*(?:(?:검사|검수)\\s*)?(?:규칙|룰)(?:\\s*(?:초안|작성안|안))?(?:을|를)?${edge}`, "u");
const namedRule = new RegExp(`^(?:것(?:을|이)|을|를)?\\s*찾는\\s*(?:(?:검사|검수)\\s*)?(?:규칙|룰)(?:을|를)?${edge}`, "u");
const operationTopic: Record<string, RegExp> = {
  compare: /^(?:들\s*)?(?:간(?:의|에)?|사이(?:의)?)\s*(?:서로\s*)?(?:다른\s*)?설정(?:을|이|값|의)?(?=$|\s)/u,
  audit: /^(?:(?:에\s*)?대한\s*)?(?:전체\s*)?(?:설정(?:값)?(?:에\s*대한)?\s*)?(?:QA\s*(?:검사|검수|점검)?|검사|검수|점검)(?:을|를)?(?=$|\s)/iu,
  policy: /^(?:에\s*)?(?:대한\s*)?(?:(?:적용하고\s*있는|적용된)\s*)?(?:운영\s*)?정책(?:을|의)?\s*(?:위반한\s*항목|위반\s*목록|내용)(?:을|를)?(?=$|\s)/u,
  history: /^설정(?:에서|의)?\s*변경된\s*내용의\s*이력(?:을|를)?(?=$|\s)/u,
};
export function workflowPhraseLength(text: string, operation?: string): number {
  if (!operation) return 0;
  return Math.max(operationPatterns[operation]?.exec(text)?.[0].length ?? 0, operationTopic[operation]?.exec(text)?.[0].length ?? 0,
    operation === "create_rule" ? Math.max(ruleRole.exec(text)?.[0].length ?? 0, namedRule.exec(text)?.[0].length ?? 0) : 0);
}
