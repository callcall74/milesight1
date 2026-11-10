import sharp from "sharp";
import { kv } from "./kv";
import { splitList } from "./list";

const MAX_EVENTS = 300;
const MAX_RAW = 20;
const SNAPSHOT_TTL = Math.round(Number(process.env.SNAPSHOT_TTL_HOURS || 1) * 3600);
// Upstash 무료 플랜(저장 250MB, 전송 10GB/월) 보호: 카메라별 최신 전체 화면 한 장을 이 간격(초)마다 덮어써서 저장
const SNAPSHOT_INTERVAL_SEC = Number(process.env.SNAPSHOT_INTERVAL_SEC || 300);
const SNAPSHOT_WIDTH = Number(process.env.SNAPSHOT_WIDTH || 1280);
// 이 시간(초) 안에 원래 상태로 되돌아가는 변화(차 그림자, 사람 지나감 등으로 인한 깜빡임)는 무시
const DEBOUNCE_SEC = Number(process.env.DEBOUNCE_SEC || 60);
// 점유 중인 면을 주기 리포트가 이 횟수만큼 연속으로 비어 있다고 하면 빈자리로 확정
const INTERVAL_VACANT_COUNT = 3;

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
  pending?: Spot; // 아직 DEBOUNCE_SEC 동안 유지되지 않은 새 상태 (확정 전)
  intervalVacant?: number; // 점유 상태인데 주기 리포트가 연속으로 비어 있다고 한 횟수
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
  ignored?: boolean; // 주기 리포트를 보정에 쓰지 않음 (전부 빈자리)
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
  lastSnapId?: string;
  lastSnapAt: string;
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

/** 대기 중인 새 상태가 DEBOUNCE_SEC 이상 유지됐으면 확정 상태로 올린다 */
export function settleSpot(spot: Spot, nowMs = Date.now()): Spot {
  const p = spot.pending;
  if (!p) return spot;
  if ((nowMs - new Date(p.since).getTime()) / 1000 < DEBOUNCE_SEC) return spot;
  return { ...p, pending: undefined };
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** base64 스냅샷을 SNAPSHOT_WIDTH 폭 JPEG(base64) 로 줄여 돌려준다. 비어있으면 undefined */
async function shrinkSnapshot(raw: unknown): Promise<string | undefined> {
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
    return small.toString("base64");
  } catch {
    return undefined; // 이미지로 읽을 수 없으면 저장하지 않음
  }
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

/** 빈자리 변화 리포트를 놓쳐 점유로 남은 면을 주기 리포트로 바로잡는다. 빈자리로 확정한 면의 이벤트를 돌려준다 */
async function applyIntervalVacant(
  deviceId: string,
  deviceName: string,
  prevSpots: Record<string, string>,
  areas: AreaDetail[],
  totalOccupied: number | null,
  changedAt: Record<string, string>,
  time: string,
  now: string
): Promise<ParkingEvent[]> {
  const report = areas.map((a) => ({
    area: a.area_name,
    indexes: splitList(a.numbering_scheme),
    occupied: splitList(a.occupancy).map(parseOccupied),
  }));
  // 면별 값의 합이 합계와 다르면 이번 면별 값은 믿을 수 없으므로 판단하지 않음
  const sum = report.flatMap((a) => a.occupied).filter((o) => o === true).length;
  if (totalOccupied !== null && sum !== totalOccupied) return [];

  const updates: Record<string, string> = {};
  const events: ParkingEvent[] = [];
  for (const { area, indexes, occupied } of report) {
    if (indexes.length !== occupied.length) continue;
    for (const [i, index] of indexes.entries()) {
      const key = `${area}#${index}`;
      if (!prevSpots[key]) continue;
      let spot: Spot;
      try {
        spot = settleSpot(JSON.parse(prevSpots[key]) as Spot);
      } catch {
        continue;
      }
      // 이 주기 리포트보다 나중의 변화 리포트가 이미 왔거나 화면에서 숨긴 예전 기록이면 건드리지 않음
      if ((time && spot.cameraTime > time) || spot.since < (changedAt[area] ?? "")) continue;
      if (spot.occupied === true && occupied[i] === false) {
        const count = (spot.intervalVacant ?? 0) + 1;
        if (count < INTERVAL_VACANT_COUNT) {
          updates[key] = JSON.stringify({ ...spot, intervalVacant: count });
          continue;
        }
        updates[key] = JSON.stringify({
          ...spot,
          occupied: false,
          occupancy: "0",
          duration: "",
          since: now,
          cameraTime: time,
          pending: undefined,
          intervalVacant: undefined,
        });
        await kv().hdel(`alarms:${deviceId}`, key);
        events.push({
          id: newId(),
          reportType: "correction",
          eventType: "",
          deviceId,
          deviceName,
          area,
          index,
          occupancy: "0",
          occupied: false,
          cameraTime: time,
          receivedAt: now,
          box: spot.box,
          res: spot.res,
        });
      } else if (spot.intervalVacant) {
        updates[key] = JSON.stringify({ ...spot, intervalVacant: undefined });
      }
    }
  }
  if (Object.keys(updates).length) await kv().hset(`spots:${deviceId}`, updates);
  return events;
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
    prevSpot = prevSpots[key] ? settleSpot(JSON.parse(prevSpots[key]) as Spot) : undefined;
  } catch {}

  // 스냅샷 저장 조건
  //  - 변화 리포트별 사진은 남기지 않는다. 카메라별 "최신 전체 화면" 한 장만 SNAPSHOT_INTERVAL_SEC 마다 덮어씀
  //  - 장기주차 알림: 그 시점 사진을 따로 저장 (SNAPSHOT_TTL 후 삭제)
  const secSince = (iso?: string) => (Date.now() - new Date(iso || 0).getTime()) / 1000;
  const latestDue = !(secSince(prevDev.lastSnapAt) < SNAPSHOT_INTERVAL_SEC);
  const small = reportType === "alarm" || latestDue ? await shrinkSnapshot(p.full_snapshot) : undefined;

  const device: Record<string, string> = {
    deviceName: s(p.device_name),
    mac: s(p.mac_address),
    sn: s(p.sn),
    lastSeen: now,
    lastCameraTime: s(p.time),
  };
  // 어떤 리포트든 스냅샷이 오면 "최신 전체 화면"으로 사용. 덮어쓰므로 카메라당 한 장만 남음
  if (small && latestDue) {
    const latestId = `latest-${deviceId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    await store.set(`snap:${latestId}`, small, SNAPSHOT_TTL);
    device.lastSnapId = latestId;
    device.lastSnapAt = now;
  }
  let alarmSnapId: string | undefined;
  if (small && reportType === "alarm") {
    alarmSnapId = newId();
    await store.set(`snap:${alarmSnapId}`, small, SNAPSHOT_TTL);
  }

  const ev: ParkingEvent = {
    id: newId(),
    reportType,
    eventType: s(p.event_type),
    deviceId,
    deviceName: s(p.device_name),
    cameraTime: s(p.time),
    receivedAt: now,
    snapId: alarmSnapId,
  };

  if (reportType === "interval") {
    const occ = num(p.total_occupied);
    const avail = num(p.total_available);
    // 카메라에서 주차면을 수정하면 점유 0(전부 빈자리) 주기 리포트가 오고 곧바로 변화 리포트가 다시 온다.
    // 실제 상태가 아니므로 점유 0 리포트는 합계/주기 보정에 쓰지 않음 (구역/번호 체계는 반영)
    const ignored = occ === 0;
    if (!ignored) {
      device.totalOccupied = occ === null ? "" : String(occ);
      device.totalAvailable = avail === null ? "" : String(avail);
    }
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
    const corrections = ignored
      ? []
      : await applyIntervalVacant(
          deviceId,
          s(p.device_name),
          prevSpots,
          parseAreas(p.parking_detail),
          occ,
          parseList<Record<string, string>>([device.areaChangedAt || prevDev.areaChangedAt || "{}"])[0] ?? {},
          s(p.time),
          now
        );
    for (const c of corrections) await store.lpushTrim("events", JSON.stringify(c), MAX_EVENTS);
    ev.totalOccupied = occ ?? undefined;
    ev.totalAvailable = avail ?? undefined;
    if (ignored) ev.ignored = true;
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
        box,
        res,
      };
      // 카메라는 리포트를 큐에 쌓아 순서대로 보내지만, 재전송 등으로 늦게 도착한 예전 리포트가
      // 최신 상태를 덮어쓰지 않도록 카메라 시각("YYYY-MM-DD HH:MM:SS")으로 비교
      const prevTime = prevSpot?.pending?.cameraTime || prevSpot?.cameraTime || "";
      if (!prevTime || !spot.cameraTime || spot.cameraTime >= prevTime) {
        let next: Spot;
        if (!prevSpot || prevSpot.occupied === null || occupied === null) {
          next = spot; // 처음 알게 된 면은 바로 확정
        } else if (occupied === prevSpot.occupied) {
          // 확정 상태와 같음: 대기 중이던 변화는 DEBOUNCE_SEC 안에 되돌아온 깜빡임이므로 버림
          next = { ...spot, since: prevSpot.since, pending: undefined };
        } else {
          // 상태가 바뀜: DEBOUNCE_SEC 동안 유지되면 확정 (같은 상태가 다시 와도 처음 바뀐 시각 유지)
          const since = prevSpot.pending?.occupied === occupied ? prevSpot.pending.since : now;
          next = { ...prevSpot, pending: { ...spot, since } };
        }
        await store.hset(`spots:${deviceId}`, { [key]: JSON.stringify(next) });
        // 차가 빠진 것이 확정되면 장기주차 알람 해제 (대기 중인 빈자리는 화면에서 걸러냄)
        if (next.occupied === false) await store.hdel(`alarms:${deviceId}`, key);
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
        snapId: alarmSnapId,
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

/** 관리자가 면 상태를 직접 지정. 대시보드에 나오는 면이 아니면 false */
export async function setSpotManually(deviceId: string, area: string, index: string, occupied: boolean) {
  const store = kv();
  const now = new Date().toISOString();
  const [d, spots] = await Promise.all([store.hgetall(`dev:${deviceId}`), store.hgetall(`spots:${deviceId}`)]);
  const key = `${area}#${index}`;
  const configured = parseAreas(d.areas ?? "").some(
    (a) => a.area_name === area && splitList(a.numbering_scheme).includes(index)
  );
  if (!configured && !spots[key]) return false;
  const prev = spots[key] ? parseList<Spot>([spots[key]])[0] : undefined;
  // 카메라 시각을 지금으로 맞춰, 수정 전에 찍힌 리포트가 늦게 도착해도 덮어쓰지 않게 함
  const cameraTime = d.lastCameraTime ?? "";
  const next: Spot = {
    ...prev,
    key,
    area,
    index,
    occupied,
    occupancy: occupied ? "1" : "0",
    duration: "",
    since: now,
    cameraTime,
    pending: undefined,
    intervalVacant: undefined,
  };
  await store.hset(`spots:${deviceId}`, { [key]: JSON.stringify(next) });
  if (!occupied) await store.hdel(`alarms:${deviceId}`, key);
  const ev: ParkingEvent = {
    id: newId(),
    reportType: "manual",
    eventType: "",
    deviceId,
    deviceName: d.deviceName ?? "",
    area,
    index,
    occupancy: next.occupancy,
    occupied,
    cameraTime,
    receivedAt: now,
  };
  await store.lpushTrim("events", JSON.stringify(ev), MAX_EVENTS);
  return true;
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
      const settled = parseList<Spot>(Object.values(spots))
        .map((x) => {
          const { pending: _pending, ...rest } = settleSpot(x);
          return rest as Spot;
        })
        .sort(bySpot);
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
        lastSnapId: d.lastSnapId || undefined,
        lastSnapAt: d.lastSnapAt ?? "",
        areaChangedAt: parseList<Record<string, string>>([d.areaChangedAt || "{}"])[0] ?? {},
        spots: settled,
        // 빈자리로 확정된 면의 장기주차 알림은 숨김
        alarms: parseList<Spot>(Object.values(alarms))
          .filter((a) => settled.find((x) => x.key === a.key)?.occupied !== false)
          .sort(bySpot),
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
