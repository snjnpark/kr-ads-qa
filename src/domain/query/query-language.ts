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
const setPositive = `(?:${setting}(?:해\\s*(?:둔|놓은)|(?:되어|돼)\\s*있(?:는|음)|된|한)|정해\\s*(?:둔|놓은)|정해져\\s*있는|채워져\\s*있는)`;
const setNegative = `(?:${setting}(?:하지|되지|(?:되어|돼)\\s*있지)\\s*${negative}|정해\\s*(?:두|놓)지\\s*${negative}|정해져\\s*있지\\s*${negative}|채워져\\s*있지\\s*${negative})`;
export const settingPresenceForms: ["is_empty" | "is_not_empty", RegExp][] = [
  ["is_empty", new RegExp(`^(?:${setNegative}|(?:미설정|미입력|미기재|공란|누락)(?:인|된|되어\\s*있는)?|비어\\s*있(?:는|음))${edge}`, "u")],
  ["is_not_empty", new RegExp(`^(?:${setPositive}|존재하(?:는|고)|들어가\\s*있(?:는|음))${edge}`, "u")],
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
