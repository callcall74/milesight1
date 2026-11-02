import { NextResponse } from "next/server";
import { getStatus } from "@/lib/parking";
import { usingMemoryStore } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getStatus();
  return NextResponse.json(
    { store: usingMemoryStore() ? "memory" : "upstash", now: new Date().toISOString(), ...status },
    { headers: { "Cache-Control": "no-store" } }
  );
}
