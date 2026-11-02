// 샘플 카메라 리포트를 보내 수신/저장을 확인하는 스크립트
// 사용법: node scripts/send-test.mjs <사이트 주소> <INGEST_USER> <INGEST_PASSWORD>
const [base = "http://localhost:3000", user = "", pass = ""] = process.argv.slice(2);
const headers = { "Content-Type": "application/json" };
if (user || pass) headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// 64x48 단색 PNG
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAQklEQVR42u3OMQEAAAgDIN8/9K3hA5BFJCcnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnJyf3uQAZ+QE/+wSexAAAAABJRU5ErkJggg==";
const dev = { event_type: "Parking Management", device_name: "TEST-Cam", mac_address: "00:00:00:00:00:00", sn: "TEST0001" };
const now = new Date().toISOString().replace("T", " ").slice(0, 19);
const box = { vehicle_tracking_box_x1: "100", vehicle_tracking_box_y1: "200", vehicle_tracking_box_x2: "600", vehicle_tracking_box_y2: "700" };

const payloads = [
  { ...dev, time: now, report_type: "interval", total_occupied: "1", total_available: "1",
    parking_detail: [{ area_name: "A", numbering_scheme: "1-2", occupancy: "1" }], full_snapshot: png },
  { ...dev, time: now, report_type: "trigger", resolution_w: "1920", resolution_h: "1080",
    parking_area: "A", index_number: "1", occupancy: "occupied", duration: "0", ...box, full_snapshot: png },
  { ...dev, time: now, report_type: "trigger", resolution_w: "1920", resolution_h: "1080",
    parking_area: "A", index_number: "2", occupancy: "vacant", duration: "0", full_snapshot: "" },
  { ...dev, time: now, report_type: "alarm", resolution_w: "1920", resolution_h: "1080",
    parking_area: "A", index_number: "1", duration: "7200", ...box, full_snapshot: png },
];

for (const p of payloads) {
  const r = await fetch(`${base}/api/milesight`, { method: "POST", headers, body: JSON.stringify(p) });
  console.log(`${p.report_type.padEnd(8)} HTTP ${r.status} ${await r.text()}`);
}
