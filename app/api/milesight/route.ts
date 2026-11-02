import { NextRequest, NextResponse } from "next/server";
import { ingest, logRaw } from "@/lib/parking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const user = process.env.INGEST_USER;
  const pass = process.env.INGEST_PASSWORD;
  const token = process.env.INGEST_TOKEN;
  if (!user && !pass && !token) return true;

  if (token && req.nextUrl.searchParams.get("key") === token) return true;
  if (user || pass) {
    const h = req.headers.get("authorization") ?? "";
    if (h.startsWith("Basic ")) {
      const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString().split(":");
      if (u === (user ?? "") && rest.join(":") === (pass ?? "")) return true;
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="milesight"' },
    });
  }

  const contentType = req.headers.get("content-type") ?? "";
  const body = await req.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(body);
    if (j && typeof j === "object" && !Array.isArray(j)) parsed = j;
  } catch {
    // JSON 이 아니면 원본만 기록하고 200 으로 응답 (카메라 재전송 폭주 방지)
  }

  try {
    await logRaw(contentType, body, parsed);
    if (!parsed) return NextResponse.json({ ok: false, error: "not json" });
    const ev = await ingest(parsed);
    return NextResponse.json({ ok: true, id: ev.id });
  } catch (e) {
    console.error("ingest failed", e);
    return NextResponse.json({ ok: false, error: "store error" }, { status: 500 });
  }
}

// 브라우저로 URL 을 열어 동작 확인용
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "milesight", method: "POST" });
}
