"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, FolderOpen, History, Layers3, Loader2, Plus, Save, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Policy, Rule } from "@/contracts/policy";
import type { Account, Scope } from "@/contracts/api";
import { api } from "@/lib/api";
import { confirmDiscard } from "@/lib/navigation-guard";
import { POLICY_PLATFORMS, activePolicyRules, type PolicyPlatform } from "@/lib/policy-conditions";
import { COMMON_PRESETS, MEDIA_PRESETS, PAUSED_STATUSES, RUNNING_STATUSES, emptyPolicy, matchesPreset, policyDocument, ruleFromPreset, type RulePreset } from "@/lib/policy-editor";
import { PageHeader, PlatformMark } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Notice, Pick, conditionText, entityNames, platformNames, severityNames } from "@/components/secondary/WorkspaceParts";

type Section = "common" | PolicyPlatform;
type Preview = { rule: Rule; notes: string[] };
const identity = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const clean = (policy: Policy): Policy => JSON.parse(policyDocument(policy));

export default function PoliciesPage({ accounts = [], onRefresh }: { scope: Scope; accounts?: Account[]; onRefresh?: () => void }) {
  const [policy, setPolicy] = useState<Policy>(() => emptyPolicy(identity("policy")));
  const [baseline, setBaseline] = useState(() => policyDocument(policy));
  const [catalog, setCatalog] = useState<Policy[]>([]);
  const [selected, setSelected] = useState("");
  const [section, setSection] = useState<Section>("common");
  const [historical, setHistorical] = useState(false);
  const [dialog, setDialog] = useState<"load" | "versions" | null>(null);
  const [versions, setVersions] = useState<Policy[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef<AbortController | null>(null);
  const hasDraft = !!text.trim() || !!preview;
  const dirty = policyDocument(policy) !== baseline || hasDraft;
  const legacy = policy.evaluation_mode !== "conditions";
  const locked = !!busy || legacy || historical;
  const active = policy.rules.filter(rule => rule.enabled && (!rule.platforms.length || rule.platforms.some(platform => policy.platforms.includes(platform))));
  const categoryRules = policy.rules.filter(rule => section === "common" ? !rule.platforms.length : rule.platforms.includes(section));
  const presets = section === "common" ? COMMON_PRESETS : [...MEDIA_PRESETS[section], ...COMMON_PRESETS];
  const matched = new Set(presets.map(preset => categoryRules.find(rule => matchesPreset(rule, preset))?.rule_id));
  const extra = categoryRules.filter(rule => !matched.has(rule.rule_id));
  const accountOptions = [...new Map([
    ...accounts.filter(account => policy.platforms.includes(account.platform as PolicyPlatform)).map(account => [account.account_id, account.name] as const),
    ...policy.account_ids.filter(id => !accounts.some(account => account.account_id === id)).map(id => [id, id] as const),
  ]).entries()];

  useEffect(() => {
    const initial = new AbortController();
    api<{ policies: Policy[] }>("/policies", { signal: initial.signal })
      .then(data => { if (!initial.signal.aborted) setCatalog(data.policies); })
      .catch(err => { if (!initial.signal.aborted) setError(err.message); });
    return () => { initial.abort(); request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function perform<T>(operation: string, fetcher: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void) {
    if (request.current) return;
    const pending = new AbortController();
    request.current = pending;
    setBusy(operation);
    setError("");
    try {
      const result = await fetcher(pending.signal);
      if (!pending.signal.aborted) apply(result);
    } catch (err) {
      if (!pending.signal.aborted) setError((err as Error).message);
    } finally {
      if (request.current === pending) { request.current = null; setBusy(""); }
    }
  }
  function edit(next: Policy) { setPolicy(next); }
  function discardDraft() { setText(""); setPreview(null); }
  function replace(next: Policy, id: string, previous = false) {
    const document = clean(next);
    setPolicy(document); setBaseline(policyDocument(document)); setSelected(id);
    setHistorical(previous); setSection("common"); setText(""); setPreview(null); setError("");
  }
  function create() {
    if (!busy && confirmDiscard()) replace(emptyPolicy(identity("policy")), "");
  }
  function updateRule(rule: Rule) {
    edit({ ...policy, rules: policy.rules.map(item => item.rule_id === rule.rule_id ? rule : item) });
  }
  function toggle(preset: RulePreset, checked: boolean) {
    const existing = categoryRules.find(rule => matchesPreset(rule, preset));
    if (existing) updateRule({ ...existing, enabled: checked });
    else edit({ ...policy, rules: [...policy.rules, ruleFromPreset(preset, section, identity("condition"))] });
  }
  function load(id: string, version?: number) {
    if (!confirmDiscard()) return;
    void perform("load", signal => api<Policy>(`/policies/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`, { signal }), data => {
      replace(data, id, version !== undefined && version !== catalog.find(item => item.policy_id === id)?.version);
      setDialog(null);
    });
  }
  function openLibrary() {
    setDialog("load");
    void perform("library", signal => api<{ policies: Policy[] }>("/policies", { signal }), data => setCatalog(data.policies));
  }
  function openVersions() {
    setVersions([]); setDialog("versions");
    void perform("versions", signal => api<Policy[]>(`/policies/${encodeURIComponent(selected)}/versions`, { signal }), setVersions);
  }
  function save() {
    if (locked || !dirty || !policy.name.trim() || !policy.platforms.length || hasDraft) return;
    const document = { ...policy, name: policy.name.trim() };
    void perform("save", signal => api<Policy>(selected ? `/policies/${encodeURIComponent(selected)}` : "/policies", {
      method: selected ? "PUT" : "POST", body: { yaml: policyDocument(document) }, signal,
    }), saved => {
      replace(saved, saved.policy_id);
      setCatalog(items => [...items.filter(item => item.policy_id !== saved.policy_id), clean(saved)]);
      onRefresh?.(); toast.success(`정책을 버전 ${saved.version}으로 저장했습니다.`);
    });
  }
  function generate() {
    if (locked || !text.trim()) return;
    void perform("draft", signal => api<Preview>("/policies/draft", { method: "POST", body: { yaml: policyDocument(policy), text: text.trim() }, signal }), setPreview);
  }
  function addPreview() {
    if (!preview) return;
    const incoming = preview.rule;
    if (policy.rules.some(rule => rule.rule_id === incoming.rule_id)) { setError("이미 추가한 조건입니다."); return; }
    edit({ ...policy, rules: [...policy.rules, incoming] });
    setSection(incoming.platforms.find(platform => policy.platforms.includes(platform)) ?? "common");
    setText(""); setPreview(null);
  }
  function renderPreset(preset: RulePreset) {
    const rule = categoryRules.find(item => matchesPreset(item, preset));
    const inherits = section !== "common" && COMMON_PRESETS.includes(preset) && policy.rules.some(item => item.enabled && !item.platforms.length && matchesPreset(item, preset));
    return <div className={`policy-criterion ${rule?.enabled ? "is-enabled" : ""}`} key={preset.id}>
      <label className="policy-criterion-heading">
        <Checkbox disabled={locked} checked={rule?.enabled ?? false} onCheckedChange={checked => toggle(preset, checked === true)} aria-label={`${preset.label} 사용`} />
        <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
        {!rule?.enabled && inherits && <span className="policy-inheritance-label">공통 값 사용</span>}
      </label>
      {rule?.enabled && <div className="policy-criterion-fields">
        <Field label="검사 대상"><Pick label={`${preset.label} 검사 대상`} value={rule.entity} disabled={locked} onChange={entity => updateRule({ ...rule, entity })} options={Object.entries(entityNames).map(([value, label]) => ({ value, label: value === "adgroup" ? "광고그룹·광고 세트" : label }))} /></Field>
        <Field label="위반 시"><Pick label={`${preset.label} 위반 시`} value={rule.severity} disabled={locked} onChange={severity => updateRule({ ...rule, severity: severity as Rule["severity"] })} options={Object.entries(severityNames).map(([value, label]) => ({ value, label }))} /></Field>
        {preset.kind === "status" ? <Field label="정상 운영 상태">
          <Pick label="정상 운영 상태" value={JSON.stringify(rule.check.value) === JSON.stringify(RUNNING_STATUSES) ? "running" : JSON.stringify(rule.check.value) === JSON.stringify(PAUSED_STATUSES) ? "paused" : "custom"} disabled={locked} options={[{ value: "running", label: "운영 중" }, { value: "paused", label: "일시중지" }, { value: "custom", label: "직접 지정" }]} onChange={value => updateRule({ ...rule, check: { ...rule.check, value: value === "running" ? [...RUNNING_STATUSES] : value === "paused" ? [...PAUSED_STATUSES] : [] } })} />
          {JSON.stringify(rule.check.value) !== JSON.stringify(RUNNING_STATUSES) && JSON.stringify(rule.check.value) !== JSON.stringify(PAUSED_STATUSES) && <Input aria-label="허용할 운영 상태 코드" value={Array.isArray(rule.check.value) ? rule.check.value.join(", ") : String(rule.check.value)} disabled={locked} onChange={event => updateRule({ ...rule, check: { ...rule.check, value: event.target.value.split(",").map(value => value.trim()) } })} />}
        </Field> : preset.kind !== "required" && <Field label={preset.kind === "money" ? "기준 금액" : "기준값"} hint={preset.kind === "money" ? "아래에 지정한 기준 통화로 비교합니다." : undefined}>
          <Input aria-label={`${preset.label} 기준값`} inputMode={preset.kind === "money" || preset.kind === "number" ? "decimal" : "text"} value={String(rule.check.value ?? "")} disabled={locked} onChange={event => updateRule({ ...rule, check: { ...rule.check, value: event.target.value } })} />
        </Field>}
      </div>}
    </div>;
  }

  return <div className="policy-studio" data-unsaved-changes={dirty ? "true" : undefined}>
    <PageHeader title="운영 정책" description="전체 QA에서 사용할 검사 기준을 정하세요.">
      <Button variant="outline" disabled={!!busy} onClick={openLibrary}><FolderOpen />정책 불러오기</Button>
      <Button variant="outline" disabled={!!busy} onClick={create}><Plus />새 정책</Button>
      <Button disabled={locked || !dirty || !policy.name.trim() || !policy.platforms.length || hasDraft} onClick={save}>{busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}정책 저장</Button>
    </PageHeader>
    {error && <Notice tone="error">{error}</Notice>}
    {(legacy || historical) && <Notice tone="warning">
      {legacy ? "이전 형식의 정책입니다. 원본은 보관되며 이 화면에서는 조회만 할 수 있습니다. 새 정책에서 검사 기준을 정해 주세요." : `버전 ${policy.version}을 보고 있습니다. 이전 버전은 수정할 수 없습니다.`}
      <div className="mt-3 flex flex-wrap gap-2">
        {historical && <Button variant="outline" disabled={!!busy} onClick={() => load(selected)}>현재 버전 불러오기</Button>}
        <Button variant="outline" disabled={!!busy} onClick={legacy ? create : () => {
          if (confirmDiscard()) { const next = { ...policy, policy_id: identity("policy"), name: `${policy.name} 복사본`, version: 1 }; replace(next, ""); setBaseline(policyDocument(emptyPolicy(next.policy_id))); }
        }}>{legacy ? "새 정책 작성" : "이 버전으로 새 정책 만들기"}</Button>
      </div>
    </Notice>}
    <section className="policy-identity" aria-label="정책 정보">
      <div className="policy-identity-form">
        <div className="policy-section-heading"><h2>정책 이름과 적용 범위</h2><span className={dirty ? "policy-draft-badge" : "policy-saved-badge"}>{dirty ? "저장 전" : selected ? `저장됨 · v${policy.version}` : "새 정책"}</span></div>
        <Field label="정책 이름"><Input aria-label="정책 이름" placeholder="예: 브랜드 A 기본 운영 기준" value={policy.name} disabled={locked} maxLength={200} onChange={event => edit({ ...policy, name: event.target.value })} /></Field>
        <div className="policy-scope-row"><span>검사할 매체</span><div className="policy-media-choices">{POLICY_PLATFORMS.map(platform => <label key={platform} className={policy.platforms.includes(platform) ? "is-selected" : ""}>
          <Checkbox disabled={locked} checked={policy.platforms.includes(platform)} aria-label={`${platformNames[platform]} 적용`} onCheckedChange={checked => {
            edit({ ...policy, platforms: checked ? [...policy.platforms, platform] : policy.platforms.filter(item => item !== platform) });
            if (!checked && section === platform) setSection("common");
          }} />{platform === "kakao" || platform === "kakao_keyword" ? <span className="grid min-w-0 gap-1"><PlatformMark platform={platform} withLabel={false} /><span className="text-xs">{platformNames[platform]}</span></span> : <PlatformMark platform={platform} withLabel={false} />}{platform === "meta" && <span>Meta</span>}
        </label>)}</div></div>
        {!policy.platforms.length && <p className="text-sm text-red-700" role="alert">검사할 매체를 하나 이상 선택하세요.</p>}
        <div className="policy-scope-row"><span>적용할 계정</span><div className="policy-account-scope">
          <p>{policy.account_ids.length ? "선택한 계정만 검사합니다." : "선택한 매체의 모든 계정을 검사합니다."}</p>
          {!!accountOptions.length && <details><summary>계정 범위 선택</summary><div className="policy-account-list">
            <label><Checkbox disabled={locked} checked={!policy.account_ids.length} onCheckedChange={checked => { if (checked) edit({ ...policy, account_ids: [] }); }} />모든 계정</label>
            {accountOptions.map(([id, name]) => <label key={id}><Checkbox disabled={locked} checked={policy.account_ids.includes(id)} onCheckedChange={checked => edit({ ...policy, account_ids: checked ? [...policy.account_ids, id] : policy.account_ids.filter(item => item !== id) })} />{name}</label>)}
          </div></details>}
        </div></div>
        <Field label="예산 기준 통화" hint="계정 통화가 다르면 금액을 비교하지 않고 확인 불가로 표시합니다."><Pick label="예산 기준 통화" value={policy.settings.currency ?? "account"} disabled={locked} onChange={value => edit({ ...policy, settings: { ...policy.settings, currency: value === "account" ? null : value } })} options={[
          { value: "account", label: "각 계정의 통화 사용" }, { value: "KRW", label: "원화 (KRW)" }, { value: "USD", label: "미국 달러 (USD)" }, { value: "JPY", label: "일본 엔 (JPY)" }, { value: "EUR", label: "유로 (EUR)" }, ...(![null, undefined, "KRW", "USD", "JPY", "EUR"].includes(policy.settings.currency) ? [{ value: policy.settings.currency!, label: policy.settings.currency! }] : []),
        ]} /></Field>
      </div>
    </section>
    <div className="policy-workbench">
      <nav className="policy-sections" aria-label="정책 조건 구분">
        {(["common", ...POLICY_PLATFORMS] as Section[]).map(id => <button type="button" key={id} aria-pressed={section === id} disabled={!!busy || (id !== "common" && !policy.platforms.includes(id))} onClick={() => setSection(id)}>
          {id === "common" ? <span className="policy-common-label"><Layers3 size={16} />공통 기준</span> : <span className="policy-service-label"><PlatformMark platform={id} withLabel={id === "kakao" || id === "kakao_keyword"} /></span>}
          <ChevronRight size={14} />
        </button>)}
      </nav>
      <div className="policy-editor-body">
        <section className="policy-condition-panel" aria-label={`${section === "common" ? "공통" : platformNames[section]} 검사 기준`}>
          <div className="policy-panel-heading"><div><h2>{section === "common" ? "공통 검사 기준" : `${platformNames[section]} 전용 기준`}</h2>{section !== "common" && <p>별도로 지정하지 않은 항목은 공통 기준을 적용합니다.</p>}</div></div>
          {section === "common" ? COMMON_PRESETS.map(renderPreset) : <>
            {MEDIA_PRESETS[section].map(renderPreset)}
            <details className="policy-overrides"><summary>이 매체의 공통 기준 별도 설정 <span>예산·상태·일정</span></summary><p>동일한 항목과 검사 대상에 지정한 값이 공통 값보다 우선합니다.</p>{COMMON_PRESETS.map(renderPreset)}</details>
          </>}
          {(section === "meta" || section === "kakao") && <div className="policy-audience-reference"><Field label="승인 오디언스 목록" hint="승인 오디언스 포함 검사에 사용합니다. ID를 쉼표로 구분하세요. Meta·카카오가 같은 목록을 사용합니다."><Input aria-label="승인 오디언스 목록" disabled={locked} placeholder="예: audience_123, audience_456" value={policy.settings.approved_audiences.join(", ")} onChange={event => edit({ ...policy, settings: { ...policy.settings, approved_audiences: event.target.value.split(",").map(value => value.trim()) } })} /></Field></div>}
          {!!extra.length && <div className="policy-extra-conditions"><h3>추가한 조건</h3>{extra.map(rule => <div className="policy-extra-rule" key={rule.rule_id}>
            <div><Checkbox checked={rule.enabled} disabled={locked} aria-label={`${rule.name} 사용`} onCheckedChange={checked => updateRule({ ...rule, enabled: checked === true })} /><strong>{rule.name || "추가 검사 조건"}</strong><Button size="icon" variant="ghost" aria-label={`${rule.name} 삭제`} disabled={locked} onClick={() => edit({ ...policy, rules: policy.rules.filter(item => item.rule_id !== rule.rule_id) })}><Trash2 size={15} /></Button></div>
            <p>{conditionText(rule.check)}</p>{rule.when && <p>적용 조건: {conditionText(rule.when)}</p>}{rule.exclude && <p>제외 조건: {conditionText(rule.exclude)}</p>}
            <p>{rule.platforms.length ? rule.platforms.map(platform => platformNames[platform]).join(" · ") : "공통"} · {entityNames[rule.entity]} · 위반 시 {severityNames[rule.severity]}</p>
            {rule.check.field && rule.check.value !== undefined && !Array.isArray(rule.check.value) && typeof rule.check.value !== "object" && <Field label="조건값">
              {typeof rule.check.value === "boolean" ? <Pick label={`${rule.name} 조건값`} disabled={locked} value={String(rule.check.value)} options={[{ value: "true", label: "예" }, { value: "false", label: "아니요" }]} onChange={value => updateRule({ ...rule, check: { ...rule.check, value: value === "true" } })} /> : <Input aria-label={`${rule.name} 조건값`} disabled={locked} value={String(rule.check.value)} onChange={event => updateRule({ ...rule, check: { ...rule.check, value: typeof rule.check.value === "number" ? Number(event.target.value) : event.target.value } })} />}
            </Field>}
          </div>)}</div>}
        </section>
        <section className="policy-natural-draft" aria-label="자연어 조건 초안">
          <div className="policy-panel-heading"><h2><Sparkles size={18} />자연어로 기준 추가</h2></div>
          <Textarea aria-label="정책 초안 요청" aria-describedby={preview ? "policy-draft-next-action" : undefined} disabled={locked} readOnly={!!preview} value={text} maxLength={2000} onChange={event => setText(event.target.value)} placeholder="예: 메타 캠페인 일예산은 5만원 이하로 운영" />
          <div className="policy-draft-actions"><small id="policy-draft-next-action">{preview ? "초안을 추가하거나 버린 뒤 새 조건을 입력하세요." : "일예산 · 운영 상태 · 종료일 · 승인 오디언스 / 한 번에 한 조건"}</small><div><Button variant="ghost" disabled={locked || (!text && !preview)} onClick={discardDraft}>초안 버리기</Button><Button variant="outline" disabled={locked || !text.trim() || !!preview} onClick={generate}>{busy === "draft" ? <Loader2 className="animate-spin" /> : <Sparkles />}초안 만들기</Button></div></div>
          {preview && <div className="policy-draft-preview"><span>추가할 기준</span><h3>{preview.rule.name}</h3><p>{preview.rule.platforms.length ? preview.rule.platforms.map(platform => platformNames[platform]).join(" · ") : "공통"} · {entityNames[preview.rule.entity]}</p><p>{conditionText(preview.rule.check)}</p>{preview.rule.when && <p>적용 조건: {conditionText(preview.rule.when)}</p>}{preview.notes.map(note => <small key={note}>{note}</small>)}
            <Button disabled={locked || preview.rule.platforms.some(platform => !policy.platforms.includes(platform))} onClick={addPreview}><Plus />검사 기준에 추가</Button>
            {preview.rule.platforms.some(platform => !policy.platforms.includes(platform)) && <small>이 초안의 매체를 위 적용 범위에서 먼저 선택하세요.</small>}
          </div>}
        </section>
      </div>
      <aside className="policy-summary" aria-label="정책 검사 요약">
        <div className="policy-summary-symbol"><ShieldCheck size={22} /></div><h2>검사 요약</h2><p>{policy.name || "정책 이름을 입력하세요"}</p>
        <div className="policy-summary-total"><strong>{active.length}</strong><span>개 활성 조건</span></div>
        <dl><div><dt>공통 기준</dt><dd>{active.filter(rule => !rule.platforms.length).length}개</dd></div>{policy.platforms.map(platform => <div key={platform}><dt>{platformNames[platform]}</dt><dd>{activePolicyRules(policy.rules, platform).length}개 적용</dd></div>)}</dl>
        <p className="policy-summary-note">현재 조회 범위와 이 정책의 적용 범위가 겹치는 광고를 전체 QA에서 검사합니다.</p>
        <div className="policy-summary-status"><Check size={14} /><span>조회되지 않은 값은 확인 불가로 구분합니다.</span></div>
        {selected && <Button variant="outline" disabled={!!busy} onClick={openVersions}><History size={15} />저장 버전 보기</Button>}
      </aside>
    </div>
    <footer className="policy-save-bar"><div><strong>{historical ? `이전 버전 v${policy.version}` : dirty ? "저장하지 않은 변경이 있습니다" : selected ? `버전 ${policy.version} 저장됨` : "새 정책 작성 중"}</strong><p>{hasDraft ? "초안을 검사 기준에 추가하거나 버린 뒤 저장하세요." : "저장한 정책을 현황에서 선택하면 전체 QA에 적용됩니다."}</p></div><Button disabled={locked || !dirty || !policy.name.trim() || !policy.platforms.length || hasDraft} onClick={save}>{busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}정책 저장</Button></footer>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!busy && !open) setDialog(null); }}><DialogContent className="policy-library-dialog"><DialogHeader><DialogTitle>{dialog === "load" ? "저장된 정책 불러오기" : "저장 버전"}</DialogTitle><DialogDescription>{dialog === "load" ? "불러올 정책을 선택하세요. 새 정책은 이름을 정하고 검사 기준을 저장하면 됩니다." : "검사 당시의 기준을 확인할 수 있습니다. 이전 버전은 조회만 가능합니다."}</DialogDescription></DialogHeader>
      {!!busy && <p className="policy-library-loading"><Loader2 className="animate-spin" size={16} />불러오는 중</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="policy-library-list">{(dialog === "load" ? catalog : versions).map(item => <button key={`${item.policy_id}/${item.version}`} type="button" disabled={!!busy} onClick={() => load(item.policy_id, dialog === "versions" ? item.version : undefined)} aria-label={`${item.name} · 버전 ${item.version}`}>
        <span><strong>{item.name}</strong><small>{item.platforms.map(platform => platformNames[platform]).join(" · ")}{!item.evaluation_mode ? " · 이전 형식" : ""}</small></span><span>v{item.version}<ChevronRight size={15} /></span>
      </button>)}</div>
      {!busy && !(dialog === "load" ? catalog : versions).length && <p className="policy-library-empty">{dialog === "load" ? "저장한 정책이 아직 없습니다. 새 정책을 작성해 주세요." : "저장된 버전이 없습니다."}</p>}
    </DialogContent></Dialog>
  </div>;
}
