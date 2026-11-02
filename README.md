# Milesight 주차 점유 대시보드

Milesight AI 카메라가 HTTP POST 로 보내는 주차 이벤트(interval / trigger / alarm)를 받아
Upstash Redis 에 저장하고, 웹 대시보드로 보여주는 Next.js 앱입니다. Vercel 배포를 전제로 합니다.

## 구조

| 경로 | 역할 |
|---|---|
| `POST /api/milesight` | 카메라 수신 엔드포인트 (카메라 Post 설정의 URL) |
| `GET /api/status` | 대시보드용 현재 상태 / 최근 이벤트 / 원본 로그 |
| `GET /api/snapshot/{id}` | 저장된 스냅샷 이미지 |
| `/` | 대시보드 (5초마다 자동 갱신) |

Redis 키: `devices`, `dev:{sn}`, `spots:{sn}`, `alarms:{sn}`, `events`(최근 300건), `raw`(최근 20건 원본), `snap:{id}`(TTL).

## 배포 순서

1. **Vercel 프로젝트 생성**: vercel.com → Add New → Project → GitHub `callcall74/milesight1` Import → Deploy
2. **Upstash 연결**: Vercel 프로젝트 → Storage → Create Database → **Upstash for Redis** 선택 → 프로젝트에 연결
   (환경변수 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 이 자동 추가됩니다)
3. **환경변수 추가** (Settings → Environment Variables)
   - `INGEST_USER`, `INGEST_PASSWORD` : 카메라 인증용 (카메라 화면의 User Name / Password 와 동일하게)
   - `DASHBOARD_PASSWORD` : 대시보드 접근 비밀번호 (아이디는 `DASHBOARD_USER`, 기본 `admin`)
   - `SNAPSHOT_TTL_HOURS` : 스냅샷 보관 시간 (기본 24)
4. **Redeploy** (환경변수는 재배포해야 반영됩니다)
5. **카메라 설정** (Post → HTTP)
   - URL: `https://<프로젝트>.vercel.app/api/milesight`
   - User Name / Password: 3번에서 넣은 값
   - Select Events: Parking Management
   - 전체 현황이 필요하면 Periodic Report 체크 + Period 설정

카메라가 Basic 인증을 보내지 않는 경우에는 `INGEST_TOKEN` 을 설정하고
URL 을 `https://<프로젝트>.vercel.app/api/milesight?key=<토큰>` 으로 넣으세요.

## 처음 연결 후 확인할 것

대시보드 맨 아래 **수신 원본 로그**에서 카메라가 실제로 보낸 값을 확인하세요.
특히 `occupancy` 값 형식(예: `occupied` / `1` 등), `time` 형식, `parking_detail` 의 `occupancy` 의미를 확인한 뒤
필요하면 `lib/parking.ts` 의 `parseOccupied` 를 맞춰주면 됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

Upstash 환경변수가 없으면 메모리 저장소로 동작합니다(재시작 시 초기화).
`.env.example` 을 `.env.local` 로 복사해 값을 넣으면 실제 Upstash 를 사용합니다.

## 용량 참고 (Upstash 무료 플랜)

- 스냅샷은 base64 로 Redis 에 저장되며 `SNAPSHOT_TTL_HOURS` 후 자동 삭제됩니다.
  이벤트가 많으면 TTL 을 줄이거나 카메라의 스냅샷 전송을 끄세요.
- 요청 1건당 Vercel 함수 본문 제한은 4.5MB 입니다.
