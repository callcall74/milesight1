import { NextRequest, NextResponse } from "next/server";
import { clean } from "./lib/env";

// 사이트 일시 중지 스위치. true 이면 함수(서버리스)까지 가지 않고 여기서 바로 응답해
// Upstash/함수 사용량이 늘지 않는다. 카메라 수신은 재전송을 막기 위해 200 으로 응답.
const PAUSED = true;

// 대시보드/조회 API 보호 (DASHBOARD_PASSWORD 가 설정된 경우만). 카메라 수신 경로는 제외.
export function middleware(req: NextRequest) {
  if (PAUSED) {
    if (req.nextUrl.pathname.startsWith("/api/milesight"))
      return NextResponse.json({ ok: false, paused: true }, { status: 200 });
    return new NextResponse("일시 중지되었습니다 (paused)", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (req.nextUrl.pathname.startsWith("/api/milesight")) return NextResponse.next();
  const pass = clean(process.env.DASHBOARD_PASSWORD);
  if (!pass) return NextResponse.next();
  const user = clean(process.env.DASHBOARD_USER) || "admin";
  const h = req.headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    const [u, ...rest] = atob(h.slice(6)).split(":");
    if (u.trim() === user && rest.join(":") === pass) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="parking dashboard"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
