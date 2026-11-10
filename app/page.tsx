"use client";

import { useCallback, useEffect, useState } from "react";
import type { Box, Device, ParkingEvent, Spot } from "@/lib/parking";
import { splitList } from "@/lib/list";

type Status = {
  store: "memory" | "upstash";
  now: string;
  devices: Device[];
  events: ParkingEvent[];
  raw: unknown[];
};

type LabeledBox = { box: Box; label: string; focus?: boolean };
type SnapView = { snapId: string; box?: Box; boxes?: LabeledBox[]; res?: { w: number; h: number }; title: string };

// Upstash 무료 플랜 명령 수(월 50만)를 아끼기 위해 15초 간격, 탭이 숨겨지면 멈춤
const POLL_MS = 15000;

function fmt(iso: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", { hour12: false });
}

function ago(iso: string, now: number) {
  if (!iso) return "";
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

function occLabel(o: boolean | null | undefined, raw?: string) {
  if (o === true) return <span className="tag busy">점유</span>;
  if (o === false) return <span className="tag free">빈자리</span>;
  return <span className="tag">{raw || "?"}</span>;
}

const TYPE_LABEL: Record<string, string> = { interval: "주기", trigger: "변화", alarm: "장기주차", correction: "주기보정", manual: "수동수정" };

// 서버의 DEBOUNCE_SEC 과 같은 값: 이 시간 안에 원래 상태로 되돌아간 변화는 깜빡임으로 보고 목록에서 숨김
const DEBOUNCE_MS = 60_000;
// 카메라에서 이 시간 동안 아무 리포트(주기·변화 모두)도 오지 않으면 연결 끊김 경고
const OFFLINE_MS = 30 * 60_000;

/** 같은 면에서 A→B→A 가 DEBOUNCE_MS 안에 일어나면 B 와 되돌아온 A 이벤트를 숨긴다 */
function hideFlicker(events: ParkingEvent[]): ParkingEvent[] {
  const hidden = new Set<string>();
  const bySpot = new Map<string, ParkingEvent[]>();
  for (const e of events) {
    if (e.reportType !== "trigger" || typeof e.occupied !== "boolean") continue;
    const k = `${e.deviceId}|${e.area}#${e.index}`;
    if (!bySpot.has(k)) bySpot.set(k, []);
    bySpot.get(k)!.push(e);
  }
  for (const list of bySpot.values()) {
    list.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    for (let i = 1; i + 1 < list.length; i++) {
      const [prev, cur, next] = [list[i - 1], list[i], list[i + 1]];
      if (hidden.has(cur.id)) continue;
      const back = cur.occupied !== prev.occupied && next.occupied === prev.occupied;
      if (back && new Date(next.receivedAt).getTime() - new Date(cur.receivedAt).getTime() < DEBOUNCE_MS) {
        hidden.add(cur.id);
        hidden.add(next.id);
      }
    }
  }
  return events.filter((e) => !hidden.has(e.id));
}

export default function Dashboard() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [snap, setSnap] = useState<SnapView | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError("");
    } catch (e) {
      setError(String(e));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    const onVisible = () => !document.hidden && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const openSnap = (
    v: { snapId?: string; box?: Box; boxes?: LabeledBox[]; res?: { w: number; h: number } },
    title: string
  ) => v.snapId && setSnap({ snapId: v.snapId, box: v.box, boxes: v.boxes, res: v.res, title });

  return (
    <main>
      <header>
        <h1>&lt;주차점유현황&gt;</h1>
        <span className="muted small">
          {data ? `마지막 갱신 ${fmt(data.now)} · ${POLL_MS / 1000}초마다 자동 갱신` : "불러오는 중..."}
          {` (ver.${process.env.NEXT_PUBLIC_BUILD_TIME})`}
        </span>
      </header>

      {error && <div className="banner">상태를 불러오지 못했습니다: {error}</div>}
      {data?.store === "memory" && (
        <div className="banner">
          Upstash 환경변수가 없어 메모리 저장소를 사용 중입니다. 서버가 재시작되면 데이터가 사라집니다.
        </div>
      )}

      {data && data.devices.length === 0 && (
        <div className="panel">
          <h2>아직 수신된 데이터가 없습니다</h2>
          <p className="muted">
            카메라 Post 설정의 URL 에 <code>{typeof window !== "undefined" ? window.location.origin : ""}/api/milesight</code>{" "}
            를 입력하세요.
          </p>
        </div>
      )}

      {data?.devices.map((d) => (
        <DeviceCard key={d.id} d={d} now={now} openSnap={openSnap} reload={load} />
      ))}

      {data && data.events.length > 0 && (
        <section className="panel">
          <h2>최근 이벤트</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>수신 시각</th>
                  <th>종류</th>
                  <th>카메라</th>
                  <th>구역 / 번호</th>
                  <th>상태</th>
                  <th>지속시간</th>
                  <th>카메라 시각</th>
                  <th>스냅샷</th>
                </tr>
              </thead>
              <tbody>
                {hideFlicker(data.events).map((e) => (
                  <tr key={e.id}>
                    <td>{fmt(e.receivedAt)}</td>
                    <td>
                      <span className={`tag ${e.reportType}`}>{TYPE_LABEL[e.reportType] ?? e.reportType}</span>
                    </td>
                    <td>{e.deviceName || e.deviceId}</td>
                    <td>{e.area !== undefined ? `${e.area} / ${e.index}` : "-"}</td>
                    <td>
                      {e.reportType === "trigger" || e.reportType === "correction" || e.reportType === "manual"
                        ? occLabel(e.occupied, e.occupancy)
                        : e.reportType === "interval"
                          ? `점유 ${e.totalOccupied ?? "?"} · 빈자리 ${e.totalAvailable ?? "?"}${e.ignored ? " (무시)" : ""}`
                          : "시간 초과"}
                    </td>
                    <td>{e.duration || "-"}</td>
                    <td className="muted small">{e.cameraTime}</td>
                    <td>
                      {(() => {
                        const dev = data.devices.find((x) => x.id === e.deviceId);
                        const title = `${e.deviceName} ${e.area ?? ""} ${e.index ?? ""}`;
                        if (e.reportType === "alarm" && e.snapId)
                          return (
                            <button className="link" onClick={() => openSnap(e, title)}>
                              보기
                            </button>
                          );
                        if (e.reportType !== "trigger" || !dev?.lastSnapId) return "-";
                        return (
                          <button
                            className="link"
                            onClick={() => openSnap(fullSnapView(dev, `${e.area}#${e.index}`, e), `${title} · 사진 ${fmt(dev.lastSnapAt)}`)}
                          >
                            보기
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && data.raw.length > 0 && (
        <details className="panel">
          <summary>
            <strong>수신 원본 로그</strong> <span className="muted small">(최근 {data.raw.length}건, 포맷 확인용)</span>
          </summary>
          {data.raw.map((r, i) => (
            <pre key={i}>{JSON.stringify(r, null, 2)}</pre>
          ))}
        </details>
      )}

      {snap && <SnapshotModal v={snap} onClose={() => setSnap(null)} />}
    </main>
  );
}

function DeviceCard({
  d,
  now,
  openSnap,
  reload,
}: {
  d: Device;
  now: number;
  reload: () => void;
  openSnap: (
    v: Spot | { snapId?: string; box?: Box; boxes?: LabeledBox[]; res?: { w: number; h: number } },
    title: string
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const alarmKeys = new Set(d.alarms.map((a) => a.key));
  const spotGroups = buildSpotGroups(d);

  // 수정 모드에서 면을 누르면 점유 ↔ 빈자리로 바꾼다 (확인중인 면은 점유로)
  const changeSpot = async (s: Spot) => {
    const occupied = s.occupied !== true;
    if (!window.confirm(`${s.area}-${s.index} 을(를) ${occupied ? "점유" : "빈자리"}로 바꿀까요?`)) return;
    const r = await fetch("/api/spot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: d.id, area: s.area, index: s.index, occupied }),
    }).catch(() => null);
    if (!r?.ok) window.alert("수정하지 못했습니다. 다시 시도해 주세요.");
    reload();
  };
  const areaStats = buildAreaStats(spotGroups);
  // 면별 상태(변화 리포트)로 계산, 면 정보가 없으면 주기 리포트 총계
  const known = areaStats.some((a) => a.total);
  const occupied = known ? (sumOf(areaStats, "occupied") as number) : d.totalOccupied;
  const available = known ? (sumOf(areaStats, "free") as number) : d.totalAvailable;
  const total = occupied !== null && available !== null ? occupied + available : null;
  const rate = total ? Math.round(((occupied ?? 0) / total) * 100) : null;

  return (
    <section className="panel">
      <h2>
        {d.deviceName || d.id}{" "}
        <span className="muted small">
          SN {d.sn || "-"} · MAC {d.mac || "-"} · 마지막 수신 {ago(d.lastSeen, now)}
        </span>
      </h2>
      {d.lastSeen && now - new Date(d.lastSeen).getTime() > OFFLINE_MS && (
        <div className="banner">
          카메라와 끊어졌습니다.(30분 이상) 주차 데이터가 올바르지 않을 수 있습니다. (마지막 수신 {fmt(d.lastSeen)})
        </div>
      )}

      <div className="stats">
        <div className="stat busy">
          <div className="label">점유</div>
          <div className="value">{occupied ?? "-"}</div>
        </div>
        <div className="stat free">
          <div className="label">빈자리</div>
          <div className="value">{available ?? "-"}</div>
        </div>
        <div className="stat">
          <div className="label">점유율</div>
          <div className="value">{rate === null ? "-" : `${rate}%`}</div>
        </div>
        <div className="stat">
          <div className="label">장기주차 알림</div>
          <div className="value" style={{ color: d.alarms.length ? "var(--warn)" : undefined }}>
            {d.alarms.length}
          </div>
        </div>
      </div>
      {rate !== null && (
        <div className="bar">
          <div style={{ width: `${rate}%` }} />
        </div>
      )}
      <p className="muted small">
        주기 리포트: {d.lastIntervalAt ? `${fmt(d.lastIntervalAt)} (${ago(d.lastIntervalAt, now)})` : "수신 없음"}
        {d.lastSnapId && (
          <>
            {" · "}
            <button
              className="link"
              onClick={() => {
                const v = fullSnapView(d);
                openSnap(v, `${d.deviceName} 최근 전체 화면 · 점유 ${v.boxes.length}면 · 사진 ${fmt(d.lastSnapAt)}`);
              }}
            >
              전체 스냅샷 보기
            </button>
          </>
        )}
      </p>

      {areaStats.length > 0 && (
        <details className="area-fold">
          <summary>
            <h3>구역별 현황</h3>
          </summary>
          <div className="table-wrap">
            <table className="area-table">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>전체</th>
                  <th className="busy">점유</th>
                  <th className="free">빈자리</th>
                </tr>
              </thead>
              <tbody>
                <tr className="sum">
                  <th>합계</th>
                  <td>{sumOf(areaStats, "total")}</td>
                  <td className="busy">{sumOf(areaStats, "occupied")}</td>
                  <td className="free">{sumOf(areaStats, "free")}</td>
                </tr>
                {areaStats.map((a) => (
                  <tr key={a.name}>
                    <th>{a.name}</th>
                    <td>{a.total ?? "-"}</td>
                    <td className="busy">{a.occupied ?? "-"}</td>
                    <td className="free">{a.free ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {spotGroups.length > 0 && (
        <>
          <h3>
            주차면 상태{" "}
            <button className="link" onClick={() => setEditing(!editing)}>
              {editing ? "수정 끝내기" : "상태 수정"}
            </button>
          </h3>
          {editing && <p className="muted small">상태를 바꿀 면을 누르세요.</p>}
          {spotGroups.map((g) => (
            <div className="spot-row" key={g.area}>
              <div className="spot-area">{g.area || "?"}</div>
              <div className="spots">
                {g.spots.map((s) => {
                  if (!s.since && !editing)
                    return (
                      <div key={s.key} className="spot free unknown" title="아직 변화 리포트가 없어 빈자리로 추정 중">
                        <div className="no">{s.index}</div>
                        <div className="st">빈자리(확인중)</div>
                      </div>
                    );
                  const cls = !s.since ? "free unknown" : s.occupied === true ? "busy" : s.occupied === false ? "free" : "";
                  return (
                    <button
                      key={s.key}
                      className={`spot ${cls} ${alarmKeys.has(s.key) ? "alarm" : ""}`}
                      data-click={editing || d.lastSnapId ? "1" : "0"}
                      onClick={() =>
                        editing
                          ? changeSpot(s)
                          : openSnap(fullSnapView(d, s.key, s), `${s.area} ${s.index} · 사진 ${fmt(d.lastSnapAt)}`)
                      }
                      title={`카메라 시각 ${s.cameraTime}`}
                    >
                      <div className="no">{s.index}</div>
                      <div className="st">
                        {!s.since ? "빈자리(확인중)" : s.occupied === true ? "점유" : s.occupied === false ? "빈자리" : s.occupancy || "?"}
                      </div>
                      <div className="muted small">{ago(s.since, now)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}

      {d.alarms.length > 0 && (
        <>
          <h3>장기주차 알림</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>구역 / 번호</th>
                  <th>지속시간</th>
                  <th>발생</th>
                  <th>스냅샷</th>
                </tr>
              </thead>
              <tbody>
                {d.alarms.map((a) => (
                  <tr key={a.key}>
                    <td>
                      {a.area} / {a.index}
                    </td>
                    <td>{a.duration}</td>
                    <td>{fmt(a.since)}</td>
                    <td>
                      {a.snapId ? (
                        <button className="link" onClick={() => openSnap(a, `${a.area} ${a.index} 장기주차`)}>
                          보기
                        </button>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

type AreaStat = { name: string; total: number | null; occupied: number | null; free: number | null };
type SpotGroup = { area: string; spots: Spot[] };

/** 구역별 한 줄씩. 면 상태는 변화 리포트로만 판단한다.
 *  (Occupancy Detection 모드의 주기 리포트는 occupancy 가 항상 0 이라 신뢰할 수 없음)
 *  주기 리포트의 구역/번호 체계는 현재 카메라 설정으로 보고, 거기 없는 예전 면은 숨기고
 *  아직 변화 리포트가 없는 면은 "빈자리(확인중)"(since 비어있음) 으로 채운다. */
function buildSpotGroups(d: Device): SpotGroup[] {
  const areas = new Map<string, Spot[]>();
  const configured = new Map(d.areas.map((a) => [a.area_name, splitList(a.numbering_scheme)]));
  // 구역/번호가 모두 비어 있는 예전 데이터("#")는 제외
  for (const s of d.spots.filter((s) => s.area || s.index)) {
    const idx = configured.get(s.area);
    if (configured.size && (!idx || !idx.includes(s.index))) continue;
    // 구역 설정이 바뀌기 전의 기록은 지금 구역과 맞지 않으므로 무시
    if (s.since < (d.areaChangedAt[s.area] ?? "")) continue;
    if (!areas.has(s.area)) areas.set(s.area, []);
    areas.get(s.area)!.push(s);
  }
  for (const [area, indexes] of configured) {
    const list = areas.get(area) ?? [];
    for (const index of indexes)
      if (!list.some((s) => s.index === index))
        list.push({ key: `${area}#${index}`, area, index, occupied: null, occupancy: "", duration: "", since: "", cameraTime: "" });
    areas.set(area, list);
  }
  return [...areas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, spots]) => ({
      area,
      spots: spots.sort((x, y) => x.index.localeCompare(y.index, undefined, { numeric: true })),
    }));
}

/** 최신 전체 화면에 지금 점유 중인 면을 노란 박스로 표시한다. 선택한 면이 있으면 그 면만 빨간 박스 */
function fullSnapView(
  d: Device,
  focusKey?: string,
  focus?: { area?: string; index?: string; box?: Box; res?: { w: number; h: number } }
) {
  const occ = buildSpotGroups(d)
    .flatMap((g) => g.spots)
    .filter((x) => x.occupied === true && x.box && x.key !== focusKey);
  const boxes: LabeledBox[] = occ.map((x) => ({ box: x.box!, label: `${x.area}-${x.index}` }));
  if (focus?.box) boxes.push({ box: focus.box, label: `${focus.area}-${focus.index}`, focus: true });
  return { snapId: d.lastSnapId, boxes, res: focus?.res ?? occ.find((x) => x.res)?.res };
}

function buildAreaStats(groups: SpotGroup[]): AreaStat[] {
  return groups.map((g) => ({
    name: g.area || "?",
    total: g.spots.length,
    occupied: g.spots.filter((s) => s.occupied === true).length,
    // 변화 리포트가 아직 없는 면(확인중)은 빈자리로 집계
    free: g.spots.filter((s) => s.occupied !== true).length,
  }));
}

function sumOf(list: AreaStat[], k: "total" | "occupied" | "free") {
  const vals = list.map((a) => a[k]).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((x, y) => x + y, 0) : "-";
}

function SnapshotModal({ v, onClose }: { v: SnapView; onClose: () => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const res = v.res ?? size;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      {/* 사진(창 안 어디든) 을 눌러도 닫힌다 */}
      <div className="modal-inner" style={{ cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <strong>{v.title}</strong>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="snap-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {failed ? (
            <p className="muted">스냅샷이 만료되었거나 없습니다.</p>
          ) : (
            <img
              src={`/api/snapshot/${v.snapId}`}
              alt="snapshot"
              onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
            />
          )}
          {res && (v.box || v.boxes?.length) && (
            <svg viewBox={`0 0 ${res.w} ${res.h}`} preserveAspectRatio="none">
              {[...(v.box ? [{ box: v.box, label: "", focus: true }] : []), ...(v.boxes ?? [])].map(({ box, label, focus }, i) => (
                <g key={i}>
                  <rect
                    x={box.x1}
                    y={box.y1}
                    width={box.x2 - box.x1}
                    height={box.y2 - box.y1}
                    fill="none"
                    stroke={focus ? "#ff2020" : "#ffcc00"}
                    strokeWidth={Math.max(2, res.w / 300)}
                  />
                  {label && (
                    <text
                      x={box.x1}
                      y={Math.max(res.h / 30, box.y1 - res.h / 120)}
                      fill={focus ? "#ff2020" : "#ffcc00"}
                      fontSize={res.h / 30}
                      fontWeight="bold"
                      stroke="#000"
                      strokeWidth={res.h / 600}
                      paintOrder="stroke"
                    >
                      {label}
                    </text>
                  )}
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
