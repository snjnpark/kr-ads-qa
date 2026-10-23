"use client";

import { useEffect, useRef, useState } from "react";
import { Cable, Check, ChevronRight, Clock3, Cpu, Eye, EyeOff, LockKeyhole, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BrowserModelTools, BrowserBackupTools } from "@/components/BrowserTools";
import type { Account, Settings } from "@/contracts/api";
import { PageHeader, PlatformMark } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, LoadingButton, Notice, Pick, platformNames } from "@/components/secondary/WorkspaceParts";
import { credentialValues, NUMBER_SETTINGS, numberProblem, parseSettingsDraft, toSettingsDraft, type NumberSetting, type SettingsDraft } from "./settings-draft";

type Section = "connections" | "data" | "model";
type SettingsResponse = { settings: Settings; active_settings?: Settings; restart_required?: boolean; message?: string };
const sections = [
  { id: "connections", label: "광고 API 연결", description: "매체별 인증 정보", icon: Cable },
  { id: "data", label: "조회·이력", description: "데이터와 저장 간격", icon: Clock3 },
  { id: "model", label: "모델 실행", description: "자연어 해석과 성능", icon: Cpu },
];
const media = ["meta", "naver", "google", "kakao", "kakao_keyword"];
const credentialLabels: Record<string, string> = {
  access_token: "액세스 토큰", api_key: "API 키", secret_key: "비밀 키", customer_id: "광고 계정 ID", business_token: "비즈니스 토큰",
  client_id: "클라이언트 ID", client_secret: "클라이언트 비밀 키", refresh_token: "갱신 토큰", login_customer_id: "관리자 계정 ID",
};
const credentialHints: Record<string, string> = {
  meta: "조회할 광고 계정에 접근할 수 있는 액세스 토큰을 입력하세요.",
  naver: "검색광고 API에서 발급받은 키와 조회할 광고 계정 ID를 입력하세요.",
  google: "사용자 액세스 토큰을 입력하세요. 관리자 계정 ID는 필요한 경우에만 입력합니다. 토큰은 이 탭의 메모리에만 보관합니다.",
  kakao: "조회할 모먼트 광고 계정에 접근할 수 있는 비즈니스 토큰을 입력하세요.",
  kakao_keyword: "프리미엄링크 계정의 keyword_management 동의를 받은 비즈니스 토큰을 입력하세요. 톡채널검색은 제외합니다.",
};

function NumberField({ name, draft, change }: { name: NumberSetting; draft: SettingsDraft; change: (key: NumberSetting, value: string) => void }) {
  const rule = NUMBER_SETTINGS[name], problem = numberProblem(name, draft[name]);
  return <Field label={rule.label} hint={rule.hint}>
    <div className="settings-number"><Input aria-label={rule.label} aria-invalid={!!problem} aria-describedby={problem ? `${name}-error` : undefined} type="number" min={rule.min} max={rule.max} step={rule.step === 1 ? 1 : "any"} value={draft[name]} onChange={event => change(name, event.target.value)} />{rule.unit && <span>{rule.unit}</span>}</div>
    {problem && <span id={`${name}-error`} className="settings-field-error" role="alert">{problem}</span>}
  </Field>;
}

export default function SettingsPage({ accounts, onRefresh }: { accounts: Account[]; onRefresh?: () => void }) {
  const [section, setSection] = useState<Section>("connections");
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [baseline, setBaseline] = useState<SettingsDraft | null>(null);
  const [active, setActive] = useState<Settings | null>(null);
  const [restart, setRestart] = useState(false);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [platform, setPlatform] = useState("meta");
  const [googleAuth, setGoogleAuth] = useState("token");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [savedCredentials, setSavedCredentials] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const mounted = useRef(false), working = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let ignore = false;
    const controller = new AbortController();
    setError("");
    Promise.all([
      api<SettingsResponse>("/settings", { signal: controller.signal }),
      api<{ platforms: Record<string, string[]> }>("/credentials/schema", { signal: controller.signal }),
    ]).then(([data, keys]) => {
      if (ignore) return;
      setDraft(toSettingsDraft(data.settings));
      setBaseline(toSettingsDraft(data.settings));
      setActive(data.active_settings ?? data.settings);
      setRestart(data.restart_required ?? false);
      setSchema(keys.platforms);
    }).catch(err => { if (!ignore) setError(err.message); });
    return () => { ignore = true; mounted.current = false; controller.abort(); };
  }, [reload]);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline);
  const credentialsDirty = Object.values(credentials).some(value => value.length > 0);
  const unsaved = dirty || credentialsDirty;
  let invalid = "";
  if (draft) { try { parseSettingsDraft(draft); } catch (err) { invalid = (err as Error).message; } }
  useEffect(() => {
    if (!unsaved) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [unsaved]);

  function change<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous);
  }
  async function action(name: string, run: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(name); setError("");
    try { await run(); }
    catch (err) { if (mounted.current) { setError((err as Error).message); toast.error((err as Error).message); } }
    finally { working.current = false; if (mounted.current) setBusy(""); }
  }
  function resetCredentials() { setCredentials({}); setVisible({}); setError(""); }
  function discardCredentials() {
    return !credentialsDirty || window.confirm("입력 중인 인증 정보가 지워집니다. 계속할까요?");
  }
  const keys = (schema[platform] ?? []).filter(key => platform !== "google" || key === "login_customer_id" || (googleAuth === "token" ? key === "access_token" : key !== "access_token"));

  return <div className="settings-studio" data-unsaved-changes={unsaved ? "true" : undefined}>
    <PageHeader title="설정" description="광고 계정을 연결하고, 조회와 모델 실행 방식을 설정하세요."><span className="settings-local-badge"><LockKeyhole size={13} />이 PC의 설정</span></PageHeader>
    {restart && <Notice tone="warning"><strong>새로고침하면 저장한 환경 설정이 적용됩니다.</strong><p className="mt-1">새로고침 후 API 인증 정보는 다시 연결해 주세요.</p></Notice>}
    {!draft ? <div className="settings-loading" role="status">{error ? <><p role="alert">설정을 불러오지 못했습니다. {error}</p><Button variant="outline" onClick={() => setReload(value => value + 1)}><RotateCcw size={15} />다시 불러오기</Button></> : "설정을 불러오는 중입니다…"}</div> : <>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="settings-workspace">
        <aside className="settings-sidebar">
          <nav aria-label="설정 항목">{sections.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} disabled={!!busy} onClick={() => setSection(item.id as Section)}><item.icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={14} /></button>)}</nav>
          {active && <div className="settings-runtime" aria-label="현재 적용 중인 설정"><span className="settings-eyebrow">현재 적용 중</span><h2>실행 환경</h2><dl><div><dt>데이터</dt><dd>{active.mode === "mock" ? "합성 테스트 데이터" : "광고 API"}</dd></div><div><dt>질문 해석</dt><dd>{active.ai_mode === "mock" ? "테스트 해석기" : "브라우저 학습 모델"}</dd></div><div><dt>기준 시간대</dt><dd>{active.timezone}</dd></div></dl><p>{restart ? "저장한 환경 설정이 아직 적용되지 않았습니다." : "환경 설정은 저장 후 새로고침하면 적용됩니다."}</p></div>}
        </aside>
        <div className="settings-main">
          {section === "connections" && <section className="settings-panel" id="settings-connections" aria-label="광고 API 연결">
            <div className="settings-panel-heading"><span className="settings-section-icon"><Cable size={20} /></span><div><h2>광고 API 연결</h2><p>연결할 매체를 선택하고 인증 정보를 저장하세요.</p></div></div>
            <div className="settings-media-grid">{media.map(item => { const count = accounts.filter(account => account.platform === item).length; return <button type="button" key={item} aria-label={`${platformNames[item]} 연결 설정`} aria-pressed={platform === item} disabled={!!busy || !schema[item]?.length} onClick={() => { if (item !== platform && discardCredentials()) { resetCredentials(); setGoogleAuth("token"); setPlatform(item); } }}>
              <span className="settings-media-logo"><PlatformMark platform={item} withLabel={false} />{item === "meta" && <strong>Meta</strong>}</span>{(item === "kakao" || item === "kakao_keyword") && <strong className="text-xs font-medium">{platformNames[item]}</strong>}<span>{count ? `조회된 계정 ${count}개` : "계정 조회 전"}</span>{platform === item && <Check size={14} />}
            </button>; })}</div>
            {!keys.length ? <div className="settings-empty">사용 가능한 인증 항목이 없습니다. 앱을 다시 실행해 주세요.</div> : <div className="settings-connection-body">
              <form className="settings-credential-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void action("credentials", async () => {
                const values = credentialValues(platform, credentials);
                const result = await api<{ message: string }>(`/credentials/${encodeURIComponent(platform)}`, { method: "POST", body: { values } });
                if (!mounted.current) return;
                resetCredentials(); setSavedCredentials(previous => [...new Set([...previous, platform])]); toast.success(result.message);
              }); }}>
                <div className="settings-form-intro"><h3>{platformNames[platform]} 인증 정보</h3><p>{credentialHints[platform]}</p></div>
                <fieldset disabled={!!busy}>
                  {platform === "google" && <Field label="인증 방식"><Pick label="Google 인증 방식" value={googleAuth} options={[{ value: "token", label: "액세스 토큰" }]} onChange={value => { if (value !== googleAuth && discardCredentials()) { resetCredentials(); setGoogleAuth(value); } }} /></Field>}
                  {keys.map(key => <Field key={`${platform}/${key}`} label={`${credentialLabels[key] ?? key}${key === "login_customer_id" ? " (선택)" : ""}`}>
                    <div className="settings-secret"><Input aria-label={credentialLabels[key] ?? key} type={visible[key] ? "text" : "password"} autoComplete="off" spellCheck={false} value={credentials[key] ?? ""} maxLength={65_536} placeholder="새 값을 입력하세요" onChange={event => setCredentials(previous => ({ ...previous, [key]: event.target.value }))} /><Button type="button" variant="ghost" size="icon" aria-label={`${credentialLabels[key] ?? key} ${visible[key] ? "숨기기" : "표시"}`} onClick={() => setVisible(previous => ({ ...previous, [key]: !previous[key] }))}>{visible[key] ? <EyeOff size={16} /> : <Eye size={16} />}</Button></div>
                  </Field>)}
                </fieldset>
                {savedCredentials.includes(platform) && !credentialsDirty && <p className="settings-credential-saved" role="status"><Check size={15} />이 탭에 연결됨 · 데이터를 새로고침해 확인하세요.</p>}
                <div className="settings-credential-actions"><Button type="button" variant="ghost" disabled={!!busy || !credentialsDirty} onClick={resetCredentials}>입력 지우기</Button><LoadingButton type="submit" loading={busy === "credentials"} disabled={!!busy || !Object.values(credentials).some(value => value.trim())}><LockKeyhole size={15} />이 탭에 연결</LoadingButton></div>
              </form>
              <aside className="settings-connection-guide"><ShieldCheck size={22} /><h3>연결 후 바로 QA를 시작하세요</h3><ol><li>API 인증 정보로 이 탭에 연결합니다.</li><li>새로고침하거나 탭을 닫으면 인증 정보를 다시 입력합니다.</li><li>조회 범위를 선택하고 데이터를 새로고침합니다.</li><li>검색에서 질문하거나 현황에서 전체 QA를 실행합니다.</li></ol><p>인증 정보는 이 탭의 메모리에만 보관합니다. 네이버 검색광고와 카카오 키워드광고 조회만 서버를 일시 경유하며, 서비스는 중계한 광고 데이터와 인증 정보를 서버에 저장하지 않습니다.</p><small>계정 수는 조회 결과입니다. 인증 정보 저장만으로 연결 성공을 판단하지 않습니다.</small></aside>
            </div>}
          </section>}
          <form id="settings-preferences" noValidate onSubmit={event => { event.preventDefault(); if (!dirty || invalid || !draft) return; void action("settings", async () => {
            const { database: _database, policy_directory: _policy, ...editable } = parseSettingsDraft(draft);
            const body: Partial<typeof editable> = { ...editable };
            delete body.mock_dataset;
            const result = await api<SettingsResponse>("/settings", { method: "PUT", body });
            if (!mounted.current) return;
            setDraft(toSettingsDraft(result.settings)); setBaseline(toSettingsDraft(result.settings)); setActive(result.active_settings ?? active); setRestart(result.restart_required ?? false); toast.success(result.message ?? "설정을 저장했습니다.");
          }); }}>
            {section === "data" && <section className="settings-panel" id="settings-data" aria-label="조회·이력 설정">
              <div className="settings-panel-heading"><span className="settings-section-icon"><Clock3 size={20} /></span><div><h2>조회·이력</h2><p>데이터를 다시 가져오는 주기와 변경 비교용 저장 간격을 정하세요.</p></div></div>
              <fieldset disabled={!!busy} className="settings-fields"><NumberField name="cache_ttl_seconds" draft={draft} change={change} /><NumberField name="snapshot_interval_seconds" draft={draft} change={change} /><Field label="기준 시간대" hint="질문의 날짜·기간과 운영 일정을 판단할 때 사용합니다."><Input aria-label="기준 시간대" maxLength={100} value={draft.timezone} placeholder="Asia/Seoul" onChange={event => change("timezone", event.target.value)} /></Field></fieldset>
              <BrowserBackupTools /><div className="settings-maintenance"><div><h3>조회 데이터 비우기</h3><p>임시 조회 데이터를 비웁니다. 다음 데이터 새로고침에서 최신 정보를 가져오며, 저장한 정책과 검사·변경 이력은 유지됩니다.</p></div><LoadingButton type="button" variant="outline" loading={busy === "cache"} disabled={!!busy} onClick={() => void action("cache", async () => { const result = await api<{ message: string }>("/cache/clear", { method: "POST" }); if (!mounted.current) return; onRefresh?.(); toast.success(result.message); })}><Trash2 size={15} />조회 데이터 비우기</LoadingButton></div>
            </section>}
            {section === "model" && <section className="settings-panel" id="settings-model" aria-label="모델 실행 설정">
              <div className="settings-panel-heading"><span className="settings-section-icon"><Cpu size={20} /></span><div><h2>모델 실행</h2><p>한국어 질문을 조회 조건으로 해석하는 로컬 모델의 실행 방식입니다.</p></div></div>
              <div className="settings-model-info"><span className="settings-eyebrow">기본 배포 모델</span><h3>광고 설정 질문에 맞춘 학습 모델</h3><p>공개 모델을 자동으로 받아 저장하고 다음 실행부터 재사용합니다. 질문 해석은 이 브라우저에서 실행합니다.</p><span>약 769MB · 별도 AI API 키 불필요</span></div><BrowserModelTools />
              <fieldset disabled={!!busy} className="settings-model-options"><label className="settings-switch-row"><span><strong>앱 시작 시 모델 미리 불러오기</strong><small>첫 질문의 대기를 줄입니다. 앱 시작 시간과 메모리 사용량이 늘어날 수 있습니다.</small></span><Checkbox aria-label="앱 시작 시 모델 미리 불러오기" checked={draft.preload_model} onCheckedChange={checked => change("preload_model", checked === true)} /></label>
                <details className="settings-advanced"><summary>고급 실행 설정 <ChevronRight size={15} /></summary><p>기본값 사용을 권장합니다. 변경한 값은 페이지를 새로고침하면 적용됩니다.</p><div className="settings-fields"><NumberField name="semantic_threshold" draft={draft} change={change} /><NumberField name="batch_size" draft={draft} change={change} /></div></details>
              </fieldset>
            </section>}
          </form>
          <footer className="settings-save-bar"><div><strong>{dirty ? "저장하지 않은 환경 설정이 있습니다" : restart ? "환경 설정 저장됨 · 새로고침 대기" : "환경 설정 변경 없음"}</strong><p>{invalid || "인증 정보는 위 연결 화면에서 별도로 저장합니다."}</p></div><div><Button type="button" variant="outline" disabled={!!busy || !dirty} onClick={() => { setDraft(baseline); setError(""); }}>변경 취소</Button><LoadingButton type="submit" form="settings-preferences" loading={busy === "settings"} disabled={!!busy || !dirty || !!invalid}><Save size={15} />설정 저장</LoadingButton></div></footer>
        </div>
      </div>
    </>}
  </div>;
}
