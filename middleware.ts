import { NextRequest, NextResponse } from "next/server";

// 대시보드/조회 API 보호 (DASHBOARD_PASSWORD 가 설정된 경우만). 카메라 수신 경로는 제외.
export function middleware(req: NextRequest) {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return NextResponse.next();
  const user = process.env.DASHBOARD_USER || "admin";
  const h = req.headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    const [u, ...rest] = atob(h.slice(6)).split(":");
    if (u === user && rest.join(":") === pass) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="parking dashboard"' },
  });
}

export const config = {
  matcher: ["/((?!api/milesight|_next/static|_next/image|favicon.ico).*)"],
};
