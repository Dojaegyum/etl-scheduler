# 셋업 절차 (사용자가 직접 하는 일)

순서대로 하면 된다. 1~3단계는 코드와 무관하게 지금 바로 할 수 있고, 4단계부터는 코드가 완성된 뒤에 한다.

## 0. 이미 끝난 것

- Canvas 개인 액세스 토큰 → `.env`의 `CANVAS_PRIVATE_TOKEN` ✔
  - 확인 한 가지: myetl 설정 → 승인된 통합 → 해당 토큰의 "만료" 칸. 만료일을 넣었다면 그날 재발급이 필요하다. 비워 뒀다면 폐기 전까지 유효하다.

## 1. Google Cloud 프로젝트 만들기 (약 5분)

알림을 받고 싶은 캘린더의 Google 계정으로 로그인해서 진행한다.

1. https://console.cloud.google.com 접속 → 상단 프로젝트 선택 → **새 프로젝트** → 이름 `etl-scheduler` → 만들기 → 방금 만든 프로젝트 선택.
2. 왼쪽 메뉴 **API 및 서비스 → 라이브러리** → `Google Calendar API` 검색 → **사용**.

## 2. OAuth 동의 화면 (Google Auth Platform)

1. 왼쪽 메뉴 **Google Auth Platform → 개요 → 시작하기**.
2. 앱 정보: 앱 이름 `eTL Calendar Sync`, 사용자 지원 이메일은 본인.
3. 대상(Audience):
   - 개인 Gmail 계정이면 **외부**.
   - 회사/학교 Workspace 계정이고 프로젝트가 그 조직 안에 있으면 **내부**(이 경우 6단계 게시가 필요 없다).
4. 연락처 이메일 입력 → 약관 동의 → 만들기.
5. **데이터 액세스** 메뉴 → **범위 추가 또는 삭제** → 필터에 `calendar.app.created` 입력 → `https://www.googleapis.com/auth/calendar.app.created` 체크 → 업데이트 → 저장.
   - 이 범위는 "앱이 만든 보조 캘린더만" 접근한다. 기존 개인 캘린더는 건드릴 수 없다.
6. **대상** 메뉴 → 게시 상태가 "테스트"이면 **앱 게시**를 눌러 **프로덕션**으로 바꾼다.
   - 이유: 테스트 상태의 refresh token은 7일 뒤 만료된다. 프로덕션이면 만료되지 않는다.
   - 위 범위는 민감 범위가 아니라서 검증 절차 없이 게시된다. 만약 검증을 요구하는 화면이 뜨면 진행하지 말고 알려 달라(대안: 테스트 사용자에 본인 이메일 추가 후 7일마다 `pnpm auth` 재실행).

## 3. OAuth 클라이언트 ID 만들기

1. **Google Auth Platform → 클라이언트 → 클라이언트 만들기**.
2. 애플리케이션 유형 **데스크톱 앱**, 이름 `etl-scheduler-cli` → 만들기.
3. 표시되는 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 `.env`에 넣는다.

```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
```

## 4. 로컬에서 Google 동의 받고 첫 동기화 (코드 완성 후)

```
pnpm install
pnpm auth
```

브라우저가 열리면 1단계에서 쓴 계정으로 로그인하고 **허용**한다. 터미널에 아래 두 줄이 출력되면 `.env`에 붙여 넣는다.

```
GOOGLE_REFRESH_TOKEN=1//xxxxxxxx
GOOGLE_CALENDAR_ID=xxxxxxxx@group.calendar.google.com
```

이어서:

```
pnpm sync:dry    # 만들 이벤트 목록만 보여 준다. 아직 쓰지 않는다.
pnpm sync        # 실제로 반영한다.
```

Google Calendar 웹에서 왼쪽 목록에 **eTL 과제** 캘린더가 생겼는지, 이벤트 하나를 열어 알림이 **1일 전**으로 잡혀 있는지 확인한다.

## 5. GitHub 저장소와 Secrets

gh CLI가 이미 로그인돼 있으므로 아래 두 줄이면 된다(요청하면 대신 실행한다).

```
gh repo create etl-scheduler --private --source . --push
gh secret set -f .env
```

두 번째 명령은 `.env`의 모든 키를 저장소 Secrets로 올린다. `.env` 파일 자체는 `.gitignore`에 있어 커밋되지 않는다.

그다음 GitHub 저장소 → **Actions** 탭 → `Sync eTL to Google Calendar` → **Run workflow**로 한 번 수동 실행해 초록불을 확인한다. 이후 3시간마다 자동으로 돈다.

실패 알림: GitHub은 기본적으로 실패한 워크플로만 이메일로 알린다(GitHub 설정 → Notifications → Actions에서 확인).

## 6. 나중에 깨졌을 때

| 증상 | 조치 |
|---|---|
| 로그에 "Canvas 토큰이 거부되었습니다" | myetl에서 토큰 재발급 → `.env` 갱신 → `gh secret set CANVAS_PRIVATE_TOKEN` |
| 로그에 "Google refresh token이 만료" (`invalid_grant`) | `pnpm auth` 재실행 → `.env` 갱신 → `gh secret set GOOGLE_REFRESH_TOKEN` |
| 캘린더를 실수로 지움 | `.env`에서 `GOOGLE_CALENDAR_ID` 줄을 비우고 `pnpm auth` 재실행 → 새로 만든다 → 새 ID를 `.env`와 Secrets에 반영. `pnpm sync`는 ID가 없으면 캘린더를 만들지 않고 멈춘다 |
