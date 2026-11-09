// 화면 위쪽의 버전 표시용: 빌드한 시각 (한국 시간, "2026-11-09 10:35")
const buildTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date());

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_BUILD_TIME: buildTime },
};
export default nextConfig;
