import { NextResponse } from "next/server";
import { setSpotManually } from "@/lib/parking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 관리자가 대시보드에서 면 상태를 직접 수정. 대시보드 비밀번호로 보호됨 (middleware)
export async function POST(req: Request) {
  // JSON 만 받아 다른 사이트의 폼 전송으로 호출되지 않게 함
  if (!req.headers.get("content-type")?.includes("application/json"))
    return NextResponse.json({ ok: false, error: "json only" }, { status: 415 });
  const b = await req.json().catch(() => null);
  if (!b || typeof b.deviceId !== "string" || typeof b.area !== "string" || typeof b.index !== "string" || typeof b.occupied !== "boolean")
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  const done = await setSpotManually(b.deviceId, b.area, b.index, b.occupied);
  if (!done) return NextResponse.json({ ok: false, error: "spot not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
