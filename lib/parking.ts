import sharp from "sharp";
import { kv } from "./kv";

const MAX_EVENTS = 300;
const MAX_RAW = 20;
const SNAPSHOT_TTL = Math.round(Number(process.env.SNAPSHOT_TTL_HOURS || 24) * 3600);
// Upstash 무료 플랜(저장 250MB, 전송 10GB/월) 보호: 카메라별로 이 간격(초)마다 한 장만, 줄여서 저장
const SNAPSHOT_INTERVAL_SEC = Number(process.env.SNAPSHOT_INTERVAL_SEC || 300);
// 점유(차 들어옴) 리포트는 면마다 사진을 따로 남기되, 같은 면은 이 간격(초)에 한 장까지
const SPOT_SNAPSHOT_INTERVAL_SEC = Number(process.env.SPOT_SNAPSHOT_INTERVAL_SEC || 600);
const SNAPSHOT_WIDTH = Number(process.env.SNAPSHOT_WIDTH || 1280);

export type Box = { x1: number; y1: number; x2: number; y2: number };

export type Spot = {
  key: string;
  area: string;
  index: string;
  occupied: boolean | null;
  occupancy: string; // 카메라가 보낸 원본 값
  duration: string;
  since: string; // 서버 수신 시각 (ISO)
  cameraTime: string;
  snapId?: string;
  snapAt?: string; // 이 면의 사진을 마지막으로 저장한 시각
  occSnapId?: string; // 이 면의 마지막 점유 사진
  box?: Box;
  res?: { w: number; h: number };
};

export type ParkingEvent = {
  id: string;
  reportType: string;
  eventType: string;
  deviceId: string;
  deviceName: string;
  area?: string;
  index?: string;
  occupancy?: string;
  occupied?: boolean | null;
  duration?: string;
  cameraTime: string;
  receivedAt: string;
  snapId?: string;
  box?: Box;
  res?: { w: number; h: number };
  totalOccupied?: number;
  totalAvailable?: number;
};

export type AreaDetail = { area_name: string; numbering_scheme: string; occupancy: string };

export type Device = {
  id: string;
  deviceName: string;
  mac: string;
  sn: string;
  lastSeen: string;
  lastCameraTime: string;
  totalOccupied: number | null;
  totalAvailable: number | null;
  lastIntervalAt: string;
  areas: AreaDetail[];
  intervalSnapId?: string;
  lastSnapId?: string;
  areaChangedAt: Record<string, string>; // 구역 → 번호 체계가 바뀐 시각
  spots: Spot[];
  alarms: Spot[];
};

type Payload = Record<string, unknown>;

// 카메라가 채우지 못한 템플릿 변수("$space_id$" 등)는 빈 값으로 취급
const s = (v: unknown) => {
  if (v === undefined || v === null) return "";
  const t = String(v);
  return /^\$[a-z0-9_]+\$$/i.test(t) ? "" : t;
};
const num = (v: unknown) => {
  const n = Number(v);
  return v === "" || v === undefined || v === null || Number.isNaN(n) ? null : n;
};

export function parseOccupied(v: unknown): boolean | null {
  const t = s(v).trim().toLowerCase();
  if (["1", "true", "occupied", "occupy", "parked", "yes", "on"].includes(t)) return true;
  if (["0", "false", "vacant", "available", "free", "empty", "no", "off", "unoccupied", "idle"].includes(t))
    return false;
  return null;
}

function parseBox(p: Payload): Box | undefined {
  const x1 = num(p.vehicle_tracking_box_x1);
  const y1 = num(p.vehicle_tracking_box_y1);
  const x2 = num(p.vehicle_tracking_box_x2);
  const y2 = num(p.vehicle_tracking_box_y2);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return undefined;
  if (x1 === 0 && y1 === 0 && x2 === 0 && y2 === 0) return undefined;
  return { x1, y1, x2, y2 };
}

function parseRes(p: Payload) {
  const w = num(p.resolution_w);
  const h = num(p.resolution_h);
  return w && h ? { w, h } : undefined;
}

function parseAreas(v: unknown): AreaDetail[] {
  let arr = v;
  if (typeof v === "string") {
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((a: Payload) => ({
    area_name: s(a?.area_name),
    numbering_scheme: s(a?.numbering_scheme),
    occupancy: s(a?.occupancy),
  }));
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** base64 스냅샷을 SNAPSHOT_WIDTH 폭 JPEG 로 줄여 저장하고 id 를 돌려준다. 비어있으면 undefined */
async function saveSnapshot(raw: unknown): Promise<string | undefined> {
  let b64 = s(raw).trim();
  if (!b64 || b64.startsWith("$")) return undefined;
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma > 0) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, "");
  if (b64.length < 100) return undefined;
  try {
    const small = await sharp(Buffer.from(b64, "base64"))
      .resize({ width: SNAPSHOT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    b64 = small.toString("base64");
  } catch {
    return undefined; // 이미지로 읽을 수 없으면 저장하지 않음
  }
  const id = newId();
  await kv().set(`snap:${id}`, b64, SNAPSHOT_TTL);
  return id;
}

export async function getSnapshot(id: string): Promise<{ data: Buffer; type: string } | null> {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const b64 = await kv().get(`snap:${id}`);
  if (!b64) return null;
  const type = b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("R0lGOD") ? "image/gif" : "image/jpeg";
  return { data: Buffer.from(b64, "base64"), type };
}

/** 디버깅용: 스냅샷을 잘라낸 원본 payload 를 기록 */
export async function logRaw(contentType: string, body: string, parsed: Payload | null) {
  let preview: unknown;
  if (parsed) {
    const copy: Payload = { ...parsed };
    if (typeof copy.full_snapshot === "string" && copy.full_snapshot.length > 80)
      copy.full_snapshot = `<${copy.full_snapshot.length} chars: ${copy.full_snapshot.slice(0, 40)}...>`;
    preview = copy;
  } else {
    preview = body.slice(0, 2000);
  }
  await kv().lpushTrim(
    "raw",
    JSON.stringify({ receivedAt: new Date().toISOString(), contentType, size: body.length, body: preview }),
    MAX_RAW
  );
}

export async function ingest(p: Payload): Promise<ParkingEvent> {
  const store = kv();
  const now = new Date().toISOString();
  const deviceId = s(p.sn) || s(p.mac_address) || s(p.device_name) || "unknown";
  const reportType = s(p.report_type) || "unknown";
  const [prevDev, prevSpots] = await Promise.all([
    store.hgetall(`dev:${deviceId}`),
    store.hgetall(`spots:${deviceId}`),
  ]);
  // Parking Management: parking_area/index_number, Occupancy Detection: space_name/space_id
  const area = s(p.parking_area) || s(p.space_name);
  const index = s(p.index_number) || s(p.space_id);
  const key = `${area}#${index}`;
  let prevSpot: Spot | undefined;
  try {
    prevSpot = prevSpots[key] ? (JSON.parse(prevSpots[key]) as Spot) : undefined;
  } catch {}

  // 스냅샷 저장 조건
  //  - 장기주차 알림: 항상
  //  - 점유 리포트: 그 면의 마지막 사진 후 SPOT_SNAPSHOT_INTERVAL_SEC 지났으면 (노란 박스와 함께 보기 위함)
  //  - 그 외: 카메라 전체에서 SNAPSHOT_INTERVAL_SEC 마다 한 장 ("최근 전체 화면")
  const secSince = (iso?: string) => (Date.now() - new Date(iso || 0).getTime()) / 1000;
  const wantSnap =
    reportType === "alarm" ||
    (reportType === "trigger" &&
      parseOccupied(p.occupancy) === true &&
      !(secSince(prevSpot?.snapAt) < SPOT_SNAPSHOT_INTERVAL_SEC)) ||
    !(secSince(prevDev.lastSnapAt) < SNAPSHOT_INTERVAL_SEC);
  const snapId = wantSnap ? await saveSnapshot(p.full_snapshot) : undefined;

  const device: Record<string, string> = {
    deviceName: s(p.device_name),
    mac: s(p.mac_address),
    sn: s(p.sn),
    lastSeen: now,
    lastCameraTime: s(p.time),
  };
  // 어떤 리포트든 스냅샷이 오면 "최신 전체 화면"으로 사용
  if (snapId) {
    device.lastSnapId = snapId;
    device.lastSnapAt = now;
  }

  const ev: ParkingEvent = {
    id: newId(),
    reportType,
    eventType: s(p.event_type),
    deviceId,
    deviceName: s(p.device_name),
    cameraTime: s(p.time),
    receivedAt: now,
    snapId,
  };

  if (reportType === "interval") {
    const occ = num(p.total_occupied);
    const avail = num(p.total_available);
    device.totalOccupied = occ === null ? "" : String(occ);
    device.totalAvailable = avail === null ? "" : String(avail);
    device.lastIntervalAt = now;
    device.areas = JSON.stringify(parseAreas(p.parking_detail));
    // 구역별 번호 체계가 바뀌면(구역을 다시 그림) 그 시각을 남겨, 이전 변화 리포트는 화면에서 미확인 처리
    const schemes = (areas: string) => {
      try {
        return new Map((JSON.parse(areas) as AreaDetail[]).map((a) => [a.area_name, a.numbering_scheme]));
      } catch {
        return new Map<string, string>();
      }
    };
    const before = schemes(prevDev.areas ?? "");
    if (before.size) {
      let changed: Record<string, string> = {};
      try {
        changed = JSON.parse(prevDev.areaChangedAt || "{}");
      } catch {}
      let dirty = false;
      for (const [name, scheme] of schemes(device.areas))
        if (before.get(name) !== scheme) {
          changed[name] = now;
          dirty = true;
        }
      if (dirty) device.areaChangedAt = JSON.stringify(changed);
    }
    if (snapId) device.intervalSnapId = snapId;
    ev.totalOccupied = occ ?? undefined;
    ev.totalAvailable = avail ?? undefined;
  } else if (reportType === "trigger" || reportType === "alarm") {
    const box = parseBox(p);
    const res = parseRes(p);
    Object.assign(ev, { area, index, duration: s(p.duration), box, res });

    if (reportType === "trigger") {
      const occupied = parseOccupied(p.occupancy);
      ev.occupancy = s(p.occupancy);
      ev.occupied = occupied;
      const spot: Spot = {
        key,
        area,
        index,
        occupied,
        occupancy: s(p.occupancy),
        duration: s(p.duration),
        since: now,
        cameraTime: s(p.time),
        // 이번에 사진을 안 남겼으면(같은 면 10분 제한) 마지막 점유 사진을 계속 사용.
        // 빈자리 리포트가 와도 snapAt/occSnapId 는 유지해야 깜빡이는 면에서 제한이 풀리지 않음
        snapId: snapId ?? (occupied ? prevSpot?.occSnapId : undefined),
        snapAt: occupied && snapId ? now : prevSpot?.snapAt,
        occSnapId: (occupied && snapId) || prevSpot?.occSnapId,
        box,
        res,
      };
      // 카메라는 리포트를 큐에 쌓아 순서대로 보내지만, 재전송 등으로 늦게 도착한 예전 리포트가
      // 최신 상태를 덮어쓰지 않도록 카메라 시각("YYYY-MM-DD HH:MM:SS")으로 비교
      ev.snapId = spot.snapId; // 이벤트 목록의 "보기"도 같은 사진
      const prevTime = prevSpot?.cameraTime ?? "";
      if (!prevTime || !spot.cameraTime || spot.cameraTime >= prevTime) {
        await store.hset(`spots:${deviceId}`, { [key]: JSON.stringify(spot) });
        // 차가 빠지면 장기주차 알람 해제
        if (occupied === false) await store.hdel(`alarms:${deviceId}`, key);
      }
    } else {
      const alarm: Spot = {
        key,
        area,
        index,
        occupied: true,
        occupancy: "",
        duration: s(p.duration),
        since: now,
        cameraTime: s(p.time),
        snapId,
        box,
        res,
      };
      await store.hset(`alarms:${deviceId}`, { [key]: JSON.stringify(alarm) });
    }
  }

  await store.sadd("devices", deviceId);
  await store.hset(`dev:${deviceId}`, device);
  await store.lpushTrim("events", JSON.stringify(ev), MAX_EVENTS);
  return ev;
}

const parseList = <T,>(rows: string[]): T[] =>
  rows.flatMap((r) => {
    try {
      return [typeof r === "string" ? JSON.parse(r) : r];
    } catch {
      return [];
    }
  });

const bySpot = (a: Spot, b: Spot) =>
  a.area.localeCompare(b.area) || a.index.localeCompare(b.index, undefined, { numeric: true });

export async function getStatus(eventLimit = 100) {
  const store = kv();
  const ids = await store.smembers("devices");
  const devices: Device[] = await Promise.all(
    ids.map(async (id) => {
      const [d, spots, alarms] = await Promise.all([
        store.hgetall(`dev:${id}`),
        store.hgetall(`spots:${id}`),
        store.hgetall(`alarms:${id}`),
      ]);
      return {
        id,
        deviceName: d.deviceName ?? "",
        mac: d.mac ?? "",
        sn: d.sn ?? "",
        lastSeen: d.lastSeen ?? "",
        lastCameraTime: d.lastCameraTime ?? "",
        totalOccupied: num(d.totalOccupied),
        totalAvailable: num(d.totalAvailable),
        lastIntervalAt: d.lastIntervalAt ?? "",
        areas: d.areas ? parseList<AreaDetail[]>([d.areas])[0] ?? [] : [],
        intervalSnapId: d.intervalSnapId || undefined,
        lastSnapId: d.lastSnapId || undefined,
        areaChangedAt: parseList<Record<string, string>>([d.areaChangedAt || "{}"])[0] ?? {},
        spots: parseList<Spot>(Object.values(spots)).sort(bySpot),
        alarms: parseList<Spot>(Object.values(alarms)).sort(bySpot),
      };
    })
  );
  devices.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  const [events, raw] = await Promise.all([
    store.lrange("events", 0, eventLimit - 1),
    store.lrange("raw", 0, MAX_RAW - 1),
  ]);
  return { devices, events: parseList<ParkingEvent>(events), raw: parseList<unknown>(raw) };
}
