// "[1,2]" / "1,2" → ["1","2"], "1-4" → ["1","2","3","4"]
export function splitList(v: string): string[] {
  const out: string[] = [];
  for (const part of v.replace(/[[\]"']/g, "").split(",")) {
    const p = part.trim();
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (Math.abs(b - a) > 200) continue;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(String(i));
    } else if (p) out.push(p);
  }
  return out;
}
