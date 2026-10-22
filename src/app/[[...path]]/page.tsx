import { notFound, redirect } from "next/navigation";
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  if (path.length === 1 && ["checks", "rules"].includes(path[0])) redirect("/policies");
  if (
    path.length > 1 ||
    !["", "ask", "overview", "audit", "checks", "policies", "history", "rules", "settings"].includes(
      path[0] ?? "",
    )
  )
    notFound();
  return null;
}
