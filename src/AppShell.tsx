"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ClipboardCheck,
  History,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EmptyState,
  InlineError,
  PlatformMark,
  dateText,
  platforms,
} from "@/components/shared";
import { OverviewPage, AskPage, AuditPage } from "@/views/MainPages";
import PoliciesPage from "@/views/PoliciesPage";
import HistoryPage from "@/views/HistoryPage";
import SettingsPage from "@/views/SettingsPage";
import { api } from "@/lib/api";
import { browserCall } from "@/browser/client";
import { confirmDiscard } from "@/lib/navigation-guard";
import type { Account, AppState, Scope } from "@/contracts/api";
import { AD_PRODUCTS } from "@/lib/ad-products";

const statusNavigation = [
  { id: "overview", path: "/overview", label: "요약", icon: LayoutDashboard, tab: "status" },
  { id: "audit", path: "/audit", label: "검사", icon: ClipboardCheck, tab: "status" },
  { id: "history", path: "/history", label: "변경 이력", icon: History, tab: "status" },
];
const navigation = [
  { id: "ask", path: "/", label: "검색", icon: Search, tab: "search" },
  ...statusNavigation,
  { id: "policies", path: "/policies", label: "운영 정책", icon: BookOpen, tab: "rules" },
  { id: "settings", path: "/settings", label: "설정", icon: Settings2, tab: "settings" },
];
const tabs = [
  { id: "search", label: "검색", icon: Search, page: "ask" },
  { id: "status", label: "현황", icon: LayoutDashboard, page: "overview" },
  { id: "rules", label: "운영 정책", icon: BookOpen, page: "policies" },
  { id: "settings", label: "설정", icon: Settings2, page: "settings" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname !== "/ask" && !navigation.some((item) => item.path === pathname))
    return children;
  return <Workspace />;
}

function Workspace() {
  const pathname = usePathname();
  const router = useRouter();
  const page = navigation.find((item) => item.path === pathname)?.id ?? "ask";
  const active = navigation.find((item) => item.id === page)!;
  const lastPages = useRef<Record<string, string>>({});
  const scrollPositions = useRef<Record<string, number>>({});
  const [state, setState] = useState<AppState | null>(null);
  const [runtimeLabel, setRuntimeLabel] = useState("브라우저에서 처리");
  useEffect(() => { void browserCall<{label:string}>("/runtime").then(value => setRuntimeLabel(value.label)).catch(() => undefined); }, []);
  const [policyId, setPolicyId] = useState("");
  const [auditRequest, setAuditRequest] = useState(0);
  const [auditToOpen, setAuditToOpen] = useState("");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [platform, setPlatform] = useState("all");
  const [account, setAccount] = useState("all");
  const [product, setProduct] = useState("all");
  const [scopeReady, setScopeReady] = useState(false);
  const [catalog, setCatalog] = useState<Account[]>([]);
  const [preset, setPreset] = useState("");
  const scope: Scope = {
    ...(platform !== "all" ? { platforms: [platform] } : {}),
    ...(account !== "all" ? { accounts: [account] } : {}),
    ...(product !== "all" ? { products: [product] } : {}),
  };
  useEffect(() => {
    if (state && !state.policies.some(policy => policy.policy_id === policyId)) setPolicyId(state.policies[0]?.policy_id ?? "");
  }, [state, policyId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const requestSequence = useRef(0);
  const syncSequence = useRef(0);
  const accept = useCallback((data: AppState) => {
    setState(data);
    setCatalog((previous) => [
      ...new Map(
        [...previous, ...data.accounts].map((account) => [
          `${account.platform}/${account.account_id}`,
          account,
        ]),
      ).values(),
    ]);
    setError("");
  }, []);
  const refresh = useCallback(() => {
    const request = ++requestSequence.current;
    const query = new URLSearchParams();
    for (const value of scopeRef.current.platforms ?? [])
      query.append("platforms", value);
    for (const value of scopeRef.current.accounts ?? [])
      query.append("accounts", value);
    for (const value of scopeRef.current.products ?? []) query.append("products", value);
    api<AppState>(`/state?${query}`)
      .then((data) => {
        if (request === requestSequence.current) accept(data);
      })
      .catch((error) => {
        if (request === requestSequence.current) setError(error.message);
      });
  }, [accept]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("laya-scope") ?? "{}");
      if (
        saved.platform === "all" ||
        Object.hasOwn(platforms, saved.platform)
      ) {
        setPlatform(saved.platform);
        if (typeof saved.product === "string" && /^(naver|kakao|kakao_keyword|google):[A-Z][A-Z0-9_]*$/.test(saved.product) && (saved.platform === "all" || saved.product.startsWith(`${saved.platform}:`))) setProduct(saved.product);
        if (
          typeof saved.account === "string" &&
          saved.account.length <= 250 &&
          (saved.account === "all" ||
            Object.keys(platforms).some(
              (id) =>
                saved.account.startsWith(`${id}/`) &&
                saved.account.length > id.length + 1 &&
                (saved.platform === "all" || saved.platform === id),
            ))
        )
          setAccount(saved.account);
      }
    } catch {
      /* A blocked browser store must not prevent loading. */
    }
    setScopeReady(true);
    return () => {
      ++requestSequence.current;
      ++syncSequence.current;
    };
  }, []);
  useEffect(() => {
    if (scopeReady) refresh();
  }, [refresh, scopeReady]);
  useEffect(() => {
    if (!scopeReady) return;
    try {
      sessionStorage.setItem(
        "laya-scope",
        JSON.stringify({ platform, account, product }),
      );
    } catch {
      /* The current page still works without persistent scope. */
    }
  }, [platform, account, product, scopeReady]);
  useEffect(() => {
    lastPages.current[active.tab] = page;
    window.scrollTo(0, scrollPositions.current[page] ?? 0);
    const rememberScroll = () => {
      scrollPositions.current[page] = window.scrollY;
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    if (page === "ask") {
      const question = new URLSearchParams(window.location.search).get("q");
      if (question && question.length <= 2000) setPreset(question);
    }
    return () => window.removeEventListener("scroll", rememberScroll);
  }, [page, active.tab]);
  function navigate(id: string) {
    const target = navigation.find((item) => item.id === id);
    if (!target || syncing || id === page) return;
    if (!confirmDiscard()) return;
    scrollPositions.current[page] = window.scrollY;
    router.push(target.path, { scroll: false });
  }
  async function sync(next: Scope = scope, force = false) {
    const request = ++requestSequence.current;
    const syncRequest = ++syncSequence.current;
    const previous = scopeRef.current;
    setSyncing(true);
    setError("");
    try {
      const data = await api<AppState>("/sync", {
        method: "POST",
        body: { ...next, force },
      });
      if (request === requestSequence.current) {
        accept(data);
        setPlatform(next.platforms?.[0] ?? "all");
        setAccount(next.accounts?.[0] ?? "all");
        setProduct(next.products?.[0] ?? "all");
        if (force) toast.success("선택한 계정의 설정을 새로 조회했습니다.");
      }
    } catch (error) {
      if (request === requestSequence.current) {
        setError((error as Error).message);
        setPlatform(previous.platforms?.[0] ?? "all");
        setAccount(previous.accounts?.[0] ?? "all");
        setProduct(previous.products?.[0] ?? "all");
      }
    } finally {
      if (syncRequest === syncSequence.current) setSyncing(false);
    }
  }
  function changePlatform(value: string) {
    setPlatform(value);
    setAccount("all");
    setProduct("all");
    void sync(value === "all" ? {} : { platforms: [value] });
  }
  function changeAccount(value: string) {
    setAccount(value);
    void sync({
      ...scope,
      ...(value === "all" ? { accounts: undefined } : { accounts: [value] }),
    });
  }

  const visibleAccounts = catalog.filter(
    (account) => platform === "all" || account.platform === platform,
  );
  return (
    <TooltipProvider>
      <div className={`app-layout workspace-shell tab-${active.tab}`}>
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("main-content")?.focus();
          }}
        >
          본문 바로가기
        </a>
        <header className="workspace-header">
          <button
            className="workspace-brand"
            disabled={syncing}
            onClick={() => navigate("ask")}
            aria-label="kr-ads-qa 검색 홈"
          >
            <span className="brand-mark"><CheckLogo /></span>
            <span>kr-ads-qa</span>
          </button>
        </header>
        <div className="main-area">
          <div className="scope-bar">
            <div className="scope-selectors">
              <span className="scope-label">
                <SlidersHorizontal size={14} />
                조회 범위
              </span>
              <Select
                value={platform}
                onValueChange={changePlatform}
                disabled={!scopeReady || syncing}
              >
                <SelectTrigger
                  aria-label="플랫폼 선택"
                  className="platform-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">모든 플랫폼</SelectItem>
                  {Object.entries(platforms).map(([id]) => (
                    <SelectItem value={id} key={id}>
                      <PlatformMark platform={id} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={product} onValueChange={value => { setProduct(value); void sync({ ...scope, products: value === "all" ? undefined : [value] }); }} disabled={!scopeReady || syncing}>
                <SelectTrigger aria-label="광고상품 선택" className="product-select"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">모든 광고상품</SelectItem>
                  {Object.entries(AD_PRODUCTS).filter(([id]) => platform === "all" || platform === id).flatMap(([id, products]) => Object.entries(products).map(([code, label]) => <SelectItem key={`${id}:${code}`} value={`${id}:${code}`}>{platforms[id]} · {label}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select
                value={account}
                onValueChange={changeAccount}
                disabled={!scopeReady || syncing}
              >
                <SelectTrigger
                  aria-label="광고 계정 선택"
                  className="account-select"
                >
                  <SelectValue placeholder="모든 광고 계정" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">모든 광고 계정</SelectItem>
                  {account !== "all" &&
                    !visibleAccounts.some(
                      (item) =>
                        `${item.platform}/${item.account_id}` === account,
                    ) && (
                      <SelectItem value={account}>
                        {account} · 조회하지 못한 계정
                      </SelectItem>
                    )}
                  {visibleAccounts.map((account) => (
                    <SelectItem
                      key={`${account.platform}/${account.account_id}`}
                      value={`${account.platform}/${account.account_id}`}
                    >
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="source-control">
              {state && (
                <>
                  <Badge variant="outline" className="data-mode-badge">
                    {runtimeLabel}
                  </Badge>
                  {syncing ? (
                    <span className="sync-progress" role="status">
                      선택한 범위를 불러오는 중
                    </span>
                  ) : (
                    <span className="last-sync">
                      {dateText(state.last_sync, true)} 조회
                    </span>
                  )}
                </>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!state || syncing}
                aria-label="광고 설정 새로고침"
                onClick={() => sync(scope, true)}
              >
                <RefreshCw
                  size={15}
                  className={syncing ? "animate-spin" : ""}
                />
              </Button>
            </div>
          </div>
          <main id="main-content" className="main-content" tabIndex={-1}>
            <InlineError message={error} />
            {state && !state.coverage.complete && (
              <div className="partial-notice" role="status">
                <Activity size={16} />
                <div>
                  <strong>일부 계정의 설정을 가져오지 못했습니다</strong>
                  <p>
                    조회한 범위만 표시합니다. 연결 상태를 확인한 뒤 새로고침해
                    주세요.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("settings")}
                >
                  연결 확인
                  <ArrowUpRight />
                </Button>
              </div>
            )}
            {!state ? (
              error ? (
                <EmptyState
                  title="광고 설정을 불러오지 못했습니다"
                  description="잠시 후 다시 시도해 주세요."
                  action={<Button onClick={refresh}>다시 시도</Button>}
                />
              ) : (
                <div className="initial-loading" role="status">
                  <span className="brand-mark">
                    <CheckLogo />
                  </span>
                  <Loader2 className="animate-spin size-5" />
                  <h1>광고 설정을 가져오고 있습니다</h1>
                </div>
              )
            ) : (
              <div className="workspace-pages" inert={syncing} aria-busy={syncing}>
                <div className="page-content search-panel" hidden={page !== "ask"}>
                  <AskPage
                    state={state}
                    scope={scope}
                    preset={preset}
                    active={page === "ask"}
                    onRefresh={refresh}
                  />
                </div>
                {active.tab === "status" && (
                  <Tabs value={page} onValueChange={navigate} activationMode="manual" className="section-tabs status-workspace">
                    <div className="section-navigation">
                      <TabsList aria-label="현황 메뉴">
                        {statusNavigation.map((item) => (
                          <TabsTrigger key={item.id} value={item.id} disabled={syncing}>
                            <item.icon size={15} />{item.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </div>
                    {statusNavigation.map((item) => (
                      <TabsContent key={item.id} value={item.id} className="page-content">
                        {item.id === "overview" && <OverviewPage state={state} scope={scope} policyId={policyId} onPolicyChange={setPolicyId} onAudit={() => { setAuditToOpen(""); setAuditRequest(request => request + 1); navigate("audit"); }} onOpenAudit={id => { setAuditRequest(0); setAuditToOpen(id); navigate("audit"); }} onNavigate={navigate} />}
                        {item.id === "audit" && <AuditPage state={state} scope={scope} policyId={policyId} onPolicyChange={setPolicyId} auditRequest={auditRequest} onAuditStarted={() => setAuditRequest(0)} requestedRun={auditToOpen} onRunOpened={() => setAuditToOpen("")} onRefresh={refresh} onNavigate={navigate} />}
                        {item.id === "history" && <HistoryPage scope={scope} onRefresh={refresh} />}
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
                {page === "policies" && (
                  <div className="page-content"><PoliciesPage scope={scope} accounts={state.accounts} onRefresh={refresh} /></div>
                )}
                {page === "settings" && (
                  <div className="page-content"><SettingsPage accounts={state.accounts} onRefresh={refresh} /></div>
                )}
              </div>
            )}
          </main>
        </div>
        <nav className="bottom-navigation" aria-label="주 메뉴">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant="ghost"
              className={`bottom-tab ${active.tab === tab.id ? "active" : ""}`}
              disabled={syncing}
              aria-current={active.tab === tab.id ? "page" : undefined}
              onClick={() => navigate(lastPages.current[tab.id] ?? tab.page)}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
              {tab.id === "status" && Boolean(state?.latest_audit?.counts.FAIL) && (
                <span className="bottom-tab-count" aria-label={`검사 오류 ${state?.latest_audit?.counts.FAIL}건`}>
                  {state?.latest_audit?.counts.FAIL}
                </span>
              )}
            </Button>
          ))}
        </nav>
      </div>
      <Toaster theme="light" richColors closeButton position="bottom-right" />
    </TooltipProvider>
  );
}
function CheckLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 5h12M6 11h5M6 17h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m12 16 3 3 5-7"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
