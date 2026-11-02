import { Redis } from "@upstash/redis";

// Upstash Redis 의 일부 명령만 쓰는 얇은 래퍼.
// 환경변수가 없으면 로컬 개발용 메모리 저장소로 동작한다.
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  hset(key: string, values: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  lpushTrim(key: string, value: string, max: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

function upstashKV(url: string, token: string): KV {
  const r = new Redis({ url, token, automaticDeserialization: false });
  return {
    get: (k) => r.get<string>(k),
    async set(k, v, ttl) {
      if (ttl) await r.set(k, v, { ex: ttl });
      else await r.set(k, v);
    },
    async hset(k, values) {
      await r.hset(k, values);
    },
    async hgetall(k) {
      return ((await r.hgetall(k)) as Record<string, string> | null) ?? {};
    },
    async hdel(k, f) {
      await r.hdel(k, f);
    },
    async sadd(k, m) {
      await r.sadd(k, m);
    },
    smembers: (k) => r.smembers(k),
    async lpushTrim(k, v, max) {
      const p = r.pipeline();
      p.lpush(k, v);
      p.ltrim(k, 0, max - 1);
      await p.exec();
    },
    lrange: (k, a, b) => r.lrange<string>(k, a, b),
  };
}

type MemStore = {
  str: Map<string, { v: string; exp?: number }>;
  hash: Map<string, Map<string, string>>;
  set: Map<string, Set<string>>;
  list: Map<string, string[]>;
};

function memoryKV(): KV {
  const g = globalThis as unknown as { __memkv?: MemStore };
  const m = (g.__memkv ??= { str: new Map(), hash: new Map(), set: new Map(), list: new Map() });
  return {
    async get(k) {
      const e = m.str.get(k);
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) {
        m.str.delete(k);
        return null;
      }
      return e.v;
    },
    async set(k, v, ttl) {
      m.str.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : undefined });
    },
    async hset(k, values) {
      const h = m.hash.get(k) ?? new Map();
      for (const [f, v] of Object.entries(values)) h.set(f, v);
      m.hash.set(k, h);
    },
    async hgetall(k) {
      return Object.fromEntries(m.hash.get(k) ?? []);
    },
    async hdel(k, f) {
      m.hash.get(k)?.delete(f);
    },
    async sadd(k, v) {
      const s = m.set.get(k) ?? new Set();
      s.add(v);
      m.set.set(k, s);
    },
    async smembers(k) {
      return [...(m.set.get(k) ?? [])];
    },
    async lpushTrim(k, v, max) {
      const l = m.list.get(k) ?? [];
      l.unshift(v);
      m.list.set(k, l.slice(0, max));
    },
    async lrange(k, a, b) {
      const l = m.list.get(k) ?? [];
      return l.slice(a, b < 0 ? undefined : b + 1);
    },
  };
}

let instance: KV | undefined;

// .env 줄을 통째로 붙여넣어 값에 따옴표/공백이 섞인 경우를 정리
const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "").trim();

function credentials() {
  const url = clean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
  const token = clean(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);
  return { url, token };
}

export function kv(): KV {
  if (instance) return instance;
  const { url, token } = credentials();
  instance = url && token ? upstashKV(url, token) : memoryKV();
  return instance;
}

export function usingMemoryStore(): boolean {
  const { url, token } = credentials();
  return !(url && token);
}
