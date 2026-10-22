import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AppState } from "@/contracts/api";

export default function PolicyPicker({ state, value, onChange, disabled = false }: { state: AppState; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value || "none"} disabled={disabled || !state.policies.length} onValueChange={onChange}>
    <SelectTrigger className="w-full sm:w-64" aria-label="적용할 운영 정책"><SelectValue placeholder="운영 정책 선택" /></SelectTrigger>
    <SelectContent>{!state.policies.length && <SelectItem value="none">저장된 정책 없음</SelectItem>}{state.policies.map(policy => <SelectItem value={policy.policy_id} key={policy.policy_id}>{policy.name} · 버전 {policy.version}</SelectItem>)}</SelectContent>
  </Select>;
}
