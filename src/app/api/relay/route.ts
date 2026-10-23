import { handleRelay } from "../../../relay/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;
export async function POST(request: Request) { return handleRelay(request); }
