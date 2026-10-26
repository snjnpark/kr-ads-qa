"use client";
import { useEffect, useRef, useState } from "react";
import { browserCall } from "../browser/client";
import { Button } from "./ui/button";

type Status = { stage: string; loaded: number; total: number; ready: boolean; loading?: boolean; file?: string; message?: string; cacheWarning?: string };
export function BrowserModelTools() {
  const [status, setStatus] = useState<Status>();
  const [message, setMessage] = useState("");
  const [commandError, setCommandError] = useState(false);
  const [pending, setPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const working = useRef(false), mounted = useRef(false), sequence = useRef(0);
  const refresh = async () => {
    const request = ++sequence.current;
    try {
      const result = await browserCall<Status>("/model/status");
      if (!mounted.current || request !== sequence.current) return;
      setStatus(result);
      if (result.loading !== undefined || result.stage === "ready" || result.stage === "error") setPreparing(false);
    } catch (error) {
      if (mounted.current && request === sequence.current) { setMessage((error as Error).message); setCommandError(true); }
    }
  };
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => { if (!working.current) void refresh(); }, 1000); return () => { mounted.current = false; ++sequence.current; clearInterval(timer); }; }, []);
  const failed = (!status?.loading && status?.stage === "error") || commandError;
  const running = status?.loading ?? (preparing || (!failed && !status?.ready && (status?.stage === "verify" || status?.stage === "initialize" || (status?.stage === "download" && (status.loaded > 0 || !!status.file)))));
  const command = async (path: string, body?: unknown) => {
    if (working.current) return;
    working.current = true; ++sequence.current; setPending(true); setMessage(""); setCommandError(false);
    if (path !== "/model/cancel") setPreparing(true);
    try {
      const result = await browserCall<{ message: string }>(path, { method: "POST", body });
      if (!mounted.current) return;
      setMessage(result.message);
      if (path === "/model/cancel") setPreparing(false);
      await refresh();
    } catch (error) {
      if (mounted.current) { setMessage((error as Error).message); setCommandError(true); setPreparing(false); }
    } finally { working.current = false; if (mounted.current) setPending(false); }
  };
  return <div className="settings-model-info" aria-label="브라우저 모델 준비">
    <h3>브라우저 모델 준비</h3>
    <p>처음에는 약 769MB의 공개 모델을 받아 이 브라우저에 보관하고 재사용합니다. 질문 해석은 사용자 기기에서 실행하며 별도 AI API 키는 필요하지 않습니다. 질문·광고 데이터는 모델 호스트로 전송하지 않습니다.</p>
    <p role={status?.stage === "error" && !running ? "alert" : "status"}>{running && status?.stage === "error" ? "모델을 준비하고 있습니다." : status?.message ?? (status?.ready ? "모델 준비 완료" : running ? "모델을 준비하고 있습니다." : "모델 준비가 필요합니다.")}</p>
    {status?.cacheWarning && status.cacheWarning !== status.message && <p role="alert">{status.cacheWarning}</p>}
    {running && status && status.loaded > 0 && <progress aria-label="모델 준비 진행률" value={status.loaded} max={status.total} className="w-full" />}
    <div className="flex flex-wrap gap-2">
      {running ? <Button type="button" variant="outline" disabled={pending} onClick={() => void command("/model/cancel")}>중단</Button>
        : failed ? <Button type="button" variant="outline" disabled={pending} onClick={() => void command("/model/retry")}>다시 시도</Button>
        : !status?.ready && <Button type="button" variant="outline" disabled={pending || !status} onClick={() => void command("/model/load")}>모델 준비</Button>}
    </div>
    <details className="mt-3"><summary>고급: 모델 파일 직접 가져오기</summary>
      <p>자동 다운로드가 차단된 환경에서만 사용하세요. <a href="https://huggingface.co/convaiinnovations/laya/tree/7b928d828b7b0e022f929d9bd2e44165aa270148/multilingual" target="_blank" rel="noreferrer">원천 모델의 model.safetensors·토크나이저 2개</a>와 <a href="https://github.com/snjnpark/kr-ads-qa-models/releases/tag/model-lora-colab-v1" target="_blank" rel="noreferrer">추가 학습 파일 4개</a>를 함께 선택하세요. 버전과 무결성을 확인해 이 브라우저에 보관하며 서버로 업로드하지 않습니다.</p>
      <input aria-label="모델 파일 선택" type="file" multiple disabled={pending || running} onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) void command("/model/import", { files }); event.target.value = ""; }} />
    </details>
    {message && <p role={commandError ? "alert" : "status"}>{message}</p>}
  </div>;
}

export function BrowserBackupTools() {
  const [message, setMessage] = useState("");
  async function save() {
    try {
      const { content } = await browserCall<{ content: string }>("/backup/export");
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `광고_QA_백업_${new Date().toISOString().slice(0,10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("백업을 만들었습니다. API 인증 정보는 포함되지 않습니다.");
    } catch (error) { setMessage((error as Error).message); }
  }
  async function restore(file: File) {
    if (file.size > 100 * 1024 * 1024) { setMessage("백업 파일은 100MB 이하여야 합니다."); return; }
    if (!window.confirm("현재 브라우저의 저장 데이터를 백업 내용으로 바꾸고 새로고침할까요? 먼저 현재 자료를 백업해 주세요. 인증 정보는 다시 연결해야 합니다.")) return;
    try { const result = await browserCall<{ message: string }>("/backup/import", { method: "POST", body: { content: await file.text() } }); setMessage(result.message); window.location.reload(); }
    catch (error) { setMessage((error as Error).message); }
  }
  return <div className="settings-maintenance" aria-label="브라우저 데이터 백업">
    <div><h3>브라우저 데이터 백업</h3><p>정책·조회 자료·검사·이력은 현재 브라우저 주소별로 저장됩니다. 브라우저 자료를 지우거나 다른 주소로 이동하기 전에 백업하세요. 인증 정보는 포함하지 않습니다.</p></div>
    <Button type="button" variant="outline" onClick={() => void save()}>백업 다운로드</Button>
    <label>백업 복원 <input aria-label="백업 파일 선택" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void restore(file); event.target.value = ""; }} /></label>
    {message && <p role="status">{message}</p>}
  </div>;
}
