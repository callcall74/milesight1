import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/parking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snap = await getSnapshot(id);
  if (!snap) return new NextResponse("Not found (expired?)", { status: 404 });
  return new NextResponse(new Uint8Array(snap.data), {
    headers: {
      "Content-Type": snap.type,
      // latest-* 는 주기 리포트마다 덮어쓰므로 캐시하지 않음
      "Cache-Control": id.startsWith("latest-") ? "no-store" : "private, max-age=86400, immutable",
    },
  });
}
