import { Loader2 } from "lucide-react";

export function WorkingState({ text }: { text: string }) {
  return (
    <div className="working-state" role="status">
      <Loader2 className="animate-spin size-4" />
      <div>
        <strong>{text}</strong>
      </div>
      <span className="working-dots" />
    </div>
  );
}
