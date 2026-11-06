# Milesight 주차 점유 대시보드

Milesight AI 카메라가 HTTP POST 로 보내는 주차 이벤트(interval / trigger / alarm)를 받아
Upstash Redis 에 저장하고, 웹 대시보드로 보여주는 Next.js 앱입니다.

## 구조

| 경로 | 역할 |
|---|---|
| `POST /api/milesight` | 카메라 수신 엔드포인트 (카메라 Post 설정의 URL) |
| `GET /api/status` | 대시보드용 현재 상태 / 최근 이벤트 / 원본 로그 |
| `GET /api/snapshot/{id}` | 저장된 스냅샷 이미지 |
| `/` | 대시보드 (5초마다 자동 갱신) |

Redis 키: `devices`, `dev:{sn}`, `spots:{sn}`, `alarms:{sn}`, `events`(최근 300건), `raw`(최근 20건 원본), `snap:{id}`(TTL).

## 배포 순서

1. **서버 준비**: Node.js 가 설치된 서버에 코드를 받고 `npm install` → `npm run build`
2. **Upstash 연결**: console.upstash.com 에서 Redis 데이터베이스를 만들고
   REST API 값을 환경변수 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` 에 넣습니다
3. **환경변수 추가** (`.env.example` 을 `.env.local` 로 복사해 작성)
   - `INGEST_USER`, `INGEST_PASSWORD` : 카메라 인증용 (카메라 화면의 User Name / Password 와 동일하게)
   - `DASHBOARD_PASSWORD` : 대시보드 접근 비밀번호 (아이디는 `DASHBOARD_USER`, 기본 `admin`)
   - `SNAPSHOT_TTL_HOURS` : 스냅샷 보관 시간 (기본 24)
4. **실행**: `pm2 start ecosystem.config.js` (포트 3193)
   - 환경변수를 바꾸거나 다시 빌드한 뒤에는 `pm2 restart milesight` 로 반영합니다
5. **카메라 설정** (Post → HTTP)
   - URL: `http://<서버 주소>:3193/api/milesight`
   - User Name / Password: 3번에서 넣은 값
   - Select Events: Parking Management
   - 전체 현황이 필요하면 Periodic Report 체크 + Period 설정

카메라가 Basic 인증을 보내지 않는 경우에는 `INGEST_TOKEN` 을 설정하고
URL 을 `http://<서버 주소>:3193/api/milesight?key=<토큰>` 으로 넣으세요.

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
