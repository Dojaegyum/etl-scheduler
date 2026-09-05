# eTL 과제 → Google Calendar 동기화 설계

작성일: 2026-09-05 · 상태: 승인됨(설계) · 다음 단계: 구현 계획

## 1. 목표와 범위

서울대학교 eTL(실체는 Canvas LMS, `myetl.snu.ac.kr`)의 내 과제 마감을 Google Calendar의 전용 캘린더 "eTL 과제"에 이벤트로 넣고, 마감 하루 전에 알림을 받는다.

범위 안:
- 과제(assignment), 퀴즈(quiz), 마감이 있는 토론(discussion_topic)의 마감 이벤트 생성·갱신·삭제
- 제출 완료된 과제의 알림 해제
- GitHub Actions에서 3시간마다 자동 실행 + 수동 실행

범위 밖(YAGNI):
- 여러 사용자, 웹 UI, DB
- SNU 통합인증(SSO) 자동화 — Canvas 개인 액세스 토큰으로 대체
- 강의 일정(calendar_event) 동기화 — ICS 피드에만 있고 요구사항이 아님

## 2. 확정된 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 사용 범위 | 나 혼자 | DB·인증 서비스 불필요 |
| 실행 환경 | GitHub Actions schedule + workflow_dispatch | 서버 없음, 무료, Secrets 보관 |
| 언어 | TypeScript, Node 24 내장 타입 스트리핑 | 옆 프로젝트와 동일 스택, 빌드 단계 없음 |
| Canvas 인증 | 개인 액세스 토큰(Bearer) | 서버사이드 검증, SSO/MFA 우회 불필요 |
| Google 인증 | 사용자 OAuth(refresh token) | 이벤트별 알림 제어 가능 |
| Google 스코프 | `https://www.googleapis.com/auth/calendar.app.created` | 앱이 만든 캘린더만 접근, 개인 캘린더 접근 불가 |
| 대상 캘린더 | 전용 보조 캘린더 "eTL 과제" | 기존 일정과 분리, 켜고 끄기 쉬움 |
| 상태 저장 | 없음. Google 이벤트의 extendedProperties가 곧 상태 | 어디서 돌려도 결과 동일, 중복 없음 |

## 3. 조사로 확인된 사실

- `etl.snu.ac.kr`은 LearningX 포털이고 과제 데이터는 `myetl.snu.ac.kr`(Canvas)에 있다. 공식 REST API `/api/v1/*`가 열려 있다.
- 로그인은 `nsso.snu.ac.kr`(Pass-Ni SSO)을 거치며 이메일/SMS MFA가 붙는다. 헤드리스 재인증은 비현실적이므로 토큰 방식을 쓴다.
- `/api/v1/planner/items?start_date&end_date`는 과제의 정확한 `due_at`(초 단위)과 `submissions.submitted`를 준다. `per_page`는 50으로 잘리며 `Link: rel="next"` 페이지네이션이 필요하다.
- ICS 피드(`/feeds/calendars/user_*.ics`)는 과제를 종일 이벤트로 바꿔 마감 시각이 사라진다. 예비 경로로만 둔다(이번 범위 밖).
- 토큰이 폐기되면 Canvas는 401을 준다. 개인 토큰은 refresh가 없으므로 "재발급 알림"이 곧 복구 절차다.

## 4. 아키텍처와 데이터 흐름

```
GitHub Actions (3h마다 / 수동)
  └─ node src/index.ts sync
       1. canvas.fetchItems(window)        → EtlItem[]
       2. google.listManagedEvents(window) → ManagedEvent[]
       3. mapper.toDesired(EtlItem)        → DesiredEvent[]
       4. sync.plan(desired, existing)     → {inserts, updates, deletes}
       5. google.apply(plan)               → 결과 로그, 실패 시 exit 1
```

조회 창(window): `[now − 7일, now + 120일]`. Canvas와 Google 모두 이 창으로 조회한다. 창 밖의 이벤트는 읽지도 지우지도 않는다.

## 5. 구성 요소

파일마다 책임 하나. 순수 함수(mapper, sync)와 I/O 어댑터(canvas, google)를 분리한다.

| 파일 | 책임 | 의존 |
|---|---|---|
| `src/config.ts` | 환경 변수 읽기·검증, 상수(창 크기, 캘린더 이름, 시간대) | 없음 |
| `src/retry.ts` | 지수 백오프 재시도 래퍼(3회, 1s·2s·4s, 429/5xx/네트워크) | 없음 |
| `src/canvas.ts` | planner API 호출, Link 페이지네이션, 타입 필터, `EtlItem` 정규화 | config, retry, fetch |
| `src/mapper.ts` | `EtlItem → DesiredEvent` (제목·시간·설명·알림·해시) | config |
| `src/sync.ts` | desired vs existing 대조 → `SyncPlan` | 없음 |
| `src/google.ts` | OAuth 클라이언트, 캘린더 find-or-create, 이벤트 list/insert/patch/delete | googleapis, retry |
| `src/index.ts` | CLI 진입점: `sync [--dry-run]`, `auth` | 전부 |

### 타입

```ts
type EtlItem = {
  key: string;            // "assignment:375398" | "quiz:123" | "discussion_topic:456"
  courseId: number;
  courseName: string;     // "2026-2 전기·정보세미나 3 (001)" 원문
  title: string;
  dueAt: string;          // ISO 8601 UTC
  url: string;            // 절대 URL
  submitted: boolean;
  pointsPossible: number | null;
};

type DesiredEvent = {
  key: string;
  hash: string;           // 아래 필드들의 sha256 — 변경 감지용
  summary: string;
  description: string;
  start: string; end: string;   // ISO UTC
  reminderMinutes: number[];    // [] 이면 알림 없음
};

type ManagedEvent = { id: string; key: string; hash: string };

type SyncPlan = {
  inserts: DesiredEvent[];
  updates: { id: string; event: DesiredEvent }[];
  deletes: ManagedEvent[];
};
```

## 6. Canvas 조회 규칙

- 엔드포인트: `GET {CANVAS_BASE_URL}/api/v1/planner/items?start_date=<창 시작>&end_date=<창 끝>&per_page=50`
- 헤더: `Authorization: Bearer <CANVAS_PRIVATE_TOKEN>`
- `Link` 헤더의 `rel="next"`를 따라 끝까지 읽는다.
- 포함: `plannable_type ∈ {assignment, quiz, discussion_topic}`. 그 외(calendar_event, planner_note, wiki_page, announcement)는 버린다.
- 마감: `plannable_date`를 쓰고 없으면 `plannable.due_at`. 둘 다 없으면 버린다.
- `key = plannable_type + ":" + plannable_id`
- `url = CANVAS_BASE_URL + html_url`
- `submitted = submissions?.submitted === true` (submissions가 `false`인 경우 미제출)
- 401 → `CanvasAuthError`, 재시도 없이 즉시 종료.

## 7. 이벤트 매핑 규칙(mapper)

- 과목 약칭: `courseName`에서 앞의 `YYYY-N ` 학기 접두와 뒤의 ` (NNN)` 분반을 제거. 예: `2026-2 전기·정보세미나 3 (001)` → `전기·정보세미나 3`.
- 제목: `[과목 약칭] 과제명`. 제출 완료면 `✅ ` 접두.
- 시간: `end = dueAt`, `start = dueAt − 30분`. Google에는 `dateTime` + `timeZone: "Asia/Seoul"`로 보낸다.
- 설명(줄바꿈 구분): 과목 원문 / 마감: `YYYY-MM-DD (요일) HH:mm` KST / 배점: N점(없으면 생략) / 상태: 미제출|제출완료 / 링크 URL
- 알림: 미제출이면 `useDefault: false, overrides: REMINDER_MINUTES.map(m => ({method: "popup", minutes: m}))`. 제출 완료면 `useDefault: false, overrides: []`.
- `extendedProperties.private = { etlKey, etlHash, etlVersion: "1" }`
- `hash = sha256(JSON.stringify({summary, description, start, end, reminderMinutes}))`

## 8. 동기화 규칙(sync)

- existing은 Google에서 `privateExtendedProperty=etlVersion=1`, `timeMin/timeMax=창`, `singleEvents=true`로 조회한다(2500건씩 pageToken).
- key로 대조:
  - desired에만 있음 → insert
  - 양쪽에 있고 hash 다름 → update(patch)
  - 양쪽에 있고 hash 같음 → 건너뜀
  - existing에만 있음 → delete (Canvas에서 지워졌거나 마감이 빠진 경우)
- existing에 같은 key가 둘 이상이면 첫 번째만 유지하고 나머지는 delete(과거 중복 정리).
- 멱등: 같은 입력으로 두 번 돌리면 두 번째는 변경 0건.

## 9. 설정(환경 변수)

| 변수 | 필수 | 기본 | 설명 |
|---|---|---|---|
| `CANVAS_PRIVATE_TOKEN` | ✔ | | Canvas 개인 액세스 토큰 |
| `CANVAS_BASE_URL` | | `https://myetl.snu.ac.kr` | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✔ | | 데스크톱형 OAuth 클라이언트 |
| `GOOGLE_REFRESH_TOKEN` | ✔(sync) | | `auth` 명령 출력 |
| `GOOGLE_CALENDAR_ID` | | | 있으면 이름 검색 생략. `auth`가 출력 |
| `REMINDER_MINUTES` | | `1440` | 쉼표 구분, 예 `1440,60` |

상수: 창 −7/+120일, 캘린더 이름 `eTL 과제`, 시간대 `Asia/Seoul`.
로컬은 `node --env-file-if-exists=.env`, Actions는 Secrets → env.

## 10. CLI

- `sync` (기본): 계획 수립 후 반영. 요약 한 줄(`fetched N, existing M, +a ~u -d`)과 변경 건별 한 줄 로그.
- `sync --dry-run`: 계획만 출력, Google 쓰기 없음.
- `auth`: 127.0.0.1 임의 포트에 콜백 서버를 띄우고 동의 URL을 출력·브라우저 실행(`access_type=offline`, `prompt=consent`). 코드 교환 후 캘린더를 find-or-create하고 `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`를 출력한다.

## 11. 오류 처리

| 상황 | 처리 |
|---|---|
| Canvas 401 | 재시도 없이 종료(exit 1). 메시지: 토큰 재발급 후 `CANVAS_PRIVATE_TOKEN` 시크릿 갱신 안내 |
| Google `invalid_grant` | 종료(exit 1). 메시지: `pnpm auth` 재실행 후 `GOOGLE_REFRESH_TOKEN` 갱신 안내 |
| 429 / 5xx / 네트워크 | 지수 백오프 3회 재시도 |
| 캘린더 없음(ID 지정됐는데 404) | 종료, 메시지로 `GOOGLE_CALENDAR_ID` 확인 안내 |
| 이벤트 단위 쓰기 실패 | 건별 try/catch, 나머지는 계속, 마지막에 실패 목록 출력 후 exit 1 |

실패는 GitHub Actions 실패 알림 이메일로 사용자에게 도달한다. 이것이 원 설계의 "401 → 재인증" 루프를 대체한다.

## 12. 테스트

- vitest.
- `mapper.test.ts`: 과목 약칭 추출, 제목·시간·설명, 알림 배열, 제출 완료 분기, 해시 안정성.
- `sync.test.ts`: insert/update/skip/delete, 중복 key 정리, 멱등성.
- `canvas.test.ts`: fetch를 흉내 내어 Link 페이지네이션, 타입 필터, 마감 없는 항목 제외, 401 → CanvasAuthError.
- `google.ts`는 얇은 어댑터로 두고 `sync --dry-run`과 첫 실제 동기화로 스모크 확인.
- `pnpm typecheck`(`tsc --noEmit`)를 CI 전 단계로 둔다.

## 13. 운영

- `.github/workflows/sync.yml`: `schedule: "23 */3 * * *"`(정시 혼잡 회피), `workflow_dispatch`(입력 `dry_run`), `concurrency` 그룹으로 중복 실행 방지, `timeout-minutes: 10`, Node 24 + pnpm.
- Secrets: `CANVAS_PRIVATE_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`.
- 비공개 저장소는 비활성으로 인한 스케줄 자동 중지 대상이 아니다(공개 저장소만 60일 규칙).
- 사용자 셋업 절차는 `docs/SETUP.md`.

## 14. 저장소 구조

```
src/            config.ts retry.ts canvas.ts mapper.ts sync.ts google.ts index.ts
test/           mapper.test.ts sync.test.ts canvas.test.ts
.github/workflows/sync.yml
docs/SETUP.md   docs/superpowers/specs/
package.json tsconfig.json .env.example .gitignore
```

TypeScript는 Node 24 타입 스트리핑 호환 문법만 쓴다(`enum`·namespace·parameter property 금지, `.ts` 확장자 import, `erasableSyntaxOnly`).
