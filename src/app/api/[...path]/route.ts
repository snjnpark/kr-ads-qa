export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function localOnly() {
  return Response.json({ message: "이 작업은 브라우저에서 처리합니다." }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
}
export const GET = localOnly;
export const HEAD = localOnly;
export const POST = localOnly;
export const PUT = localOnly;
export const DELETE = localOnly;
