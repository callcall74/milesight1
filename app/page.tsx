"use client";

import { useCallback, useEffect, useState } from "react";
import type { Box, Device, ParkingEvent, Spot } from "@/lib/parking";

type Status = {
  store: "memory" | "upstash";
  now: string;
  devices: Device[];
  events: ParkingEvent[];
  raw: unknown[];
};

type SnapView = { snapId: string; box?: Box; res?: { w: number; h: number }; title: string };

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

const TYPE_LABEL: Record<string, string> = { interval: "주기", trigger: "변화", alarm: "장기주차" };

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

  const openSnap = (v: { snapId?: string; box?: Box; res?: { w: number; h: number } }, title: string) =>
    v.snapId && setSnap({ snapId: v.snapId, box: v.box, res: v.res, title });

  return (
    <main>
      <header>
        <h1>주차 점유 현황</h1>
        <span className="muted small">
          {data ? `마지막 갱신 ${fmt(data.now)} · ${POLL_MS / 1000}초마다 자동 갱신` : "불러오는 중..."}
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
        <DeviceCard key={d.id} d={d} now={now} openSnap={openSnap} />
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
                {data.events.map((e) => (
                  <tr key={e.id}>
                    <td>{fmt(e.receivedAt)}</td>
                    <td>
                      <span className={`tag ${e.reportType}`}>{TYPE_LABEL[e.reportType] ?? e.reportType}</span>
                    </td>
                    <td>{e.deviceName || e.deviceId}</td>
                    <td>{e.area !== undefined ? `${e.area} / ${e.index}` : "-"}</td>
                    <td>
                      {e.reportType === "trigger"
                        ? occLabel(e.occupied, e.occupancy)
                        : e.reportType === "interval"
                          ? `점유 ${e.totalOccupied ?? "?"} · 빈자리 ${e.totalAvailable ?? "?"}`
                          : "시간 초과"}
                    </td>
                    <td>{e.duration || "-"}</td>
                    <td className="muted small">{e.cameraTime}</td>
                    <td>
                      {e.snapId ? (
                        <button className="link" onClick={() => openSnap(e, `${e.deviceName} ${e.area ?? ""} ${e.index ?? ""}`)}>
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
}: {
  d: Device;
  now: number;
  openSnap: (v: Spot | { snapId?: string }, title: string) => void;
}) {
  const alarmKeys = new Set(d.alarms.map((a) => a.key));
  const spotOcc = d.spots.filter((s) => s.occupied === true).length;
  const spotFree = d.spots.filter((s) => s.occupied === false).length;
  // interval 리포트 총계를 우선, 없으면 trigger 로 모은 개별 상태로 계산
  const occupied = d.totalOccupied ?? (d.spots.length ? spotOcc : null);
  const available = d.totalAvailable ?? (d.spots.length ? spotFree : null);
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
        {d.intervalSnapId && (
          <>
            {" · "}
            <button className="link" onClick={() => openSnap({ snapId: d.intervalSnapId }, `${d.deviceName} 전체 화면`)}>
              전체 스냅샷 보기
            </button>
          </>
        )}
      </p>

      {d.areas.length > 0 && (
        <>
          <h3>구역별 현황 (주기 리포트)</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>구역</th>
                  <th>번호 체계</th>
                  <th>점유</th>
                </tr>
              </thead>
              <tbody>
                {d.areas.map((a, i) => (
                  <tr key={i}>
                    <td>{a.area_name}</td>
                    <td>{a.numbering_scheme}</td>
                    <td>{a.occupancy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {d.spots.length > 0 && (
        <>
          <h3>주차면 상태 (변화 리포트 기준)</h3>
          <div className="spots">
            {d.spots.map((s) => {
              const cls = s.occupied === true ? "busy" : s.occupied === false ? "free" : "";
              return (
                <button
                  key={s.key}
                  className={`spot ${cls} ${alarmKeys.has(s.key) ? "alarm" : ""}`}
                  data-click={s.snapId ? "1" : "0"}
                  onClick={() => openSnap(s, `${s.area} ${s.index}`)}
                  title={`카메라 시각 ${s.cameraTime}`}
                >
                  <div className="muted small">{s.area}</div>
                  <div className="no">{s.index}</div>
                  <div className="st">
                    {s.occupied === true ? "점유" : s.occupied === false ? "빈자리" : s.occupancy || "?"}
                  </div>
                  <div className="muted small">{ago(s.since, now)}</div>
                </button>
              );
            })}
          </div>
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

function SnapshotModal({ v, onClose }: { v: SnapView; onClose: () => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const res = v.res ?? size;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-inner" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <strong>{v.title}</strong>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="snap-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/snapshot/${v.snapId}`}
            alt="snapshot"
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {v.box && res && (
            <svg viewBox={`0 0 ${res.w} ${res.h}`} preserveAspectRatio="none">
              <rect
                x={v.box.x1}
                y={v.box.y1}
                width={v.box.x2 - v.box.x1}
                height={v.box.y2 - v.box.y1}
                fill="none"
                stroke="#ffcc00"
                strokeWidth={Math.max(2, res.w / 300)}
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
