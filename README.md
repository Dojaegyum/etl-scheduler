# etl-scheduler

서울대 eTL(Canvas)의 과제 마감을 Google Calendar "eTL 과제" 캘린더에 넣고 하루 전 알림을 받는다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `pnpm auth` | 브라우저로 Google 동의를 받아 `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`를 출력 |
| `pnpm sync:dry` | 바뀔 이벤트 목록만 출력 (쓰지 않음) |
| `pnpm sync` | 실제 반영 |
| `pnpm test` / `pnpm typecheck` | 테스트 / 타입 검사 |

처음 설정은 `docs/SETUP.md`, 설계는 `docs/superpowers/specs/2026-09-05-etl-calendar-sync-design.md`.

## 동작 요약

Canvas planner API(오늘 −7일 ~ +120일) → 이벤트 본문 생성 → Google에서 이 앱이 만든 이벤트를 읽어 키(`assignment:ID`)로 대조 → 추가·수정·삭제. 상태 저장소는 없고, Google 이벤트의 숨은 속성(etlKey, etlHash)이 곧 상태다. 제출 완료한 과제는 제목에 ✅가 붙고 알림이 꺼진다.

## 운영

GitHub Actions가 3시간마다 `pnpm sync`를 돌린다(`.github/workflows/sync.yml`). 실패하면 GitHub이 메일을 보낸다. Canvas 토큰이 폐기되면 재발급해 `CANVAS_PRIVATE_TOKEN` 시크릿만 갱신하면 된다.
