# eTL → Google Calendar 동기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canvas(myetl.snu.ac.kr) planner API에서 내 과제 마감을 읽어 Google Calendar 전용 캘린더 "eTL 과제"에 이벤트로 넣고, 하루 전 알림을 받게 하는 CLI와 GitHub Actions 크론을 만든다.

**Architecture:** DB 없는 단일 CLI. Canvas → 정규화(`EtlItem`) → 이벤트 본문(`DesiredEvent`) → Google에서 우리가 만든 이벤트를 읽어(`ManagedEvent`) key로 대조 → insert/update/delete. 상태는 Google 이벤트의 `extendedProperties.private`(etlKey, etlHash)에만 있다. 순수 함수(mapper, sync)와 I/O 어댑터(canvas, google)를 분리해 순수 함수는 단위 테스트, 어댑터는 가짜 객체로 테스트한다.

**Tech Stack:** Node 24(내장 TypeScript 타입 스트리핑, `--env-file-if-exists`), pnpm 10, TypeScript 5.9, vitest 3, `@googleapis/calendar` + `google-auth-library`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-etl-calendar-sync-design.md`

## Global Constraints

- Node `>=24`, `"type": "module"`. 빌드 단계 없음: `node src/index.ts`로 직접 실행한다.
- Node 타입 스트리핑 호환 문법만 쓴다: `enum`, `namespace`, 생성자 parameter property 금지. 상대 import는 반드시 `.ts` 확장자를 붙인다(`./config.ts`). 타입만 쓰는 import는 `import type` 또는 인라인 `type`.
- tsconfig: `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `noUncheckedIndexedAccess`.
- 런타임 의존성은 `@googleapis/calendar`, `google-auth-library` 둘뿐. 개발 의존성은 `typescript`, `vitest`, `@types/node`.
- 상수(정확히 이 값): `CALENDAR_NAME = "eTL 과제"`, `TIME_ZONE = "Asia/Seoul"`, `LOOKBACK_DAYS = 7`, `LOOKAHEAD_DAYS = 120`, `GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created"`, `ETL_VERSION = "1"`, 이벤트 길이 30분(마감 30분 전 ~ 마감).
- 사용자에게 보이는 메시지는 한국어. 로그 요약 형식: `fetched N, existing M, +a ~u -d`.
- 환경 변수 이름: `CANVAS_PRIVATE_TOKEN`, `CANVAS_BASE_URL`(기본 `https://myetl.snu.ac.kr`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `REMINDER_MINUTES`(기본 `1440`).
- 매 태스크 끝에 커밋. 커밋 메시지 끝에 아래 두 줄을 붙인다.
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao
  ```
- `.env`는 절대 커밋하지 않는다(이미 `.gitignore`에 있음). 토큰 값을 로그나 문서에 출력하지 않는다.

## File Structure

| 파일 | 책임 |
|---|---|
| `package.json`, `tsconfig.json` | 스크립트·의존성·컴파일 옵션 |
| `src/config.ts` | 환경 변수 → `Config`, 상수, 조회 창 계산 |
| `src/retry.ts` | `HttpError`, 상태코드 추출, 재시도 래퍼 |
| `src/canvas.ts` | planner API 호출·페이지네이션·정규화 → `EtlItem[]` |
| `src/mapper.ts` | `EtlItem` → `DesiredEvent`(제목·시간·설명·알림·해시) |
| `src/sync.ts` | `DesiredEvent[]` vs `ManagedEvent[]` → `SyncPlan` |
| `src/google.ts` | OAuth 클라이언트, 캘린더 find-or-create, 이벤트 list/apply |
| `src/auth.ts` | 로컬 루프백 OAuth 동의 플로우 |
| `src/index.ts` | CLI 진입점(`sync [--dry-run]`, `auth`), 오류 → 메시지·exit code |
| `test/*.test.ts` | 각 모듈 단위 테스트 |
| `.github/workflows/sync.yml`, `.github/workflows/ci.yml` | 크론 실행, 푸시 시 테스트 |
| `README.md` | 사용법 요약, `docs/SETUP.md` 링크 |

---

### Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `package.json`, `tsconfig.json`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `pnpm test`, `pnpm typecheck` 명령이 동작하는 빈 프로젝트.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "etl-scheduler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.30.2",
  "engines": { "node": ">=24" },
  "scripts": {
    "sync": "node --env-file-if-exists=.env src/index.ts sync",
    "sync:dry": "node --env-file-if-exists=.env src/index.ts sync --dry-run",
    "auth": "node --env-file-if-exists=.env src/index.ts auth",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 의존성 설치**

Run:
```bash
pnpm add @googleapis/calendar google-auth-library
pnpm add -D typescript vitest @types/node
```
Expected: `node_modules/` 생성, `pnpm-lock.yaml` 생성. `package.json`에 dependencies/devDependencies가 추가됨.

- [ ] **Step 4: 스모크 테스트 작성** — `test/smoke.test.ts`

```ts
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs TypeScript tests", () => {
    const sum = (a: number, b: number): number => a + b;
    expect(sum(1, 2)).toBe(3);
  });
});
```

- [ ] **Step 5: 테스트와 타입체크 실행**

Run: `pnpm test && pnpm typecheck`
Expected: `1 passed`, tsc 오류 없음.

- [ ] **Step 6: Node 직접 실행 확인** — 타입 스트리핑이 켜져 있는지 본다.

Run: `node -e "console.log(process.versions.node)"` → `24.x`
Run: `printf 'const x: number = 1; console.log(x);\n' > /tmp/ts-check.ts && node /tmp/ts-check.ts` (PowerShell이면 `"const x: number = 1; console.log(x);" | Set-Content ts-check.ts; node ts-check.ts; Remove-Item ts-check.ts`)
Expected: `1`

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json test/smoke.test.ts
git commit -m "chore: Node 24 + pnpm + vitest 스캐폴딩" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 2: 설정 로더 `src/config.ts`

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Config = {
    canvasToken: string; canvasBaseUrl: string;
    googleClientId: string; googleClientSecret: string;
    googleRefreshToken: string | null; googleCalendarId: string | null;
    reminderMinutes: number[];
  };
  export type SyncWindow = { start: Date; end: Date };
  export class ConfigError extends Error {}
  export function loadConfig(env?: Record<string, string | undefined>): Config;
  export function parseReminderMinutes(raw: string | undefined): number[];
  export function syncWindow(now?: Date): SyncWindow;
  export const CALENDAR_NAME, TIME_ZONE, LOOKBACK_DAYS, LOOKAHEAD_DAYS, GOOGLE_SCOPE;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseReminderMinutes, syncWindow, LOOKAHEAD_DAYS, LOOKBACK_DAYS } from "../src/config.ts";

const base = {
  CANVAS_PRIVATE_TOKEN: "tok",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
};

describe("loadConfig", () => {
  it("applies defaults for optional values", () => {
    const c = loadConfig(base);
    expect(c.canvasBaseUrl).toBe("https://myetl.snu.ac.kr");
    expect(c.googleRefreshToken).toBeNull();
    expect(c.googleCalendarId).toBeNull();
    expect(c.reminderMinutes).toEqual([1440]);
  });

  it("strips trailing slash from CANVAS_BASE_URL", () => {
    expect(loadConfig({ ...base, CANVAS_BASE_URL: "https://x.test/" }).canvasBaseUrl).toBe("https://x.test");
  });

  it("throws ConfigError naming the missing variable", () => {
    expect(() => loadConfig({ ...base, CANVAS_PRIVATE_TOKEN: "  " })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: undefined })).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("parseReminderMinutes", () => {
  it("defaults to one day", () => {
    expect(parseReminderMinutes(undefined)).toEqual([1440]);
    expect(parseReminderMinutes("")).toEqual([1440]);
  });
  it("parses a comma list", () => {
    expect(parseReminderMinutes("1440, 60")).toEqual([1440, 60]);
  });
  it("rejects garbage", () => {
    expect(() => parseReminderMinutes("soon")).toThrow(ConfigError);
    expect(() => parseReminderMinutes("-5")).toThrow(ConfigError);
  });
});

describe("syncWindow", () => {
  it("spans lookback..lookahead around now", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const w = syncWindow(now);
    expect(w.start.toISOString()).toBe(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString());
    expect(w.end.toISOString()).toBe(new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000).toISOString());
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.ts'`

- [ ] **Step 3: 구현** — `src/config.ts`

```ts
export const CALENDAR_NAME = "eTL 과제";
export const TIME_ZONE = "Asia/Seoul";
export const LOOKBACK_DAYS = 7;
export const LOOKAHEAD_DAYS = 120;
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

export type Config = {
  canvasToken: string;
  canvasBaseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string | null;
  googleCalendarId: string | null;
  reminderMinutes: number[];
};

export type SyncWindow = { start: Date; end: Date };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`환경 변수 ${key}가 비어 있습니다. .env 또는 GitHub Secrets를 확인하세요.`);
  }
  return value;
}

function optional(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function parseReminderMinutes(raw: string | undefined): number[] {
  const text = raw?.trim();
  if (!text) return [1440];
  const values = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const valid = values.length > 0 && values.every((n) => Number.isInteger(n) && n >= 0);
  if (!valid) {
    throw new ConfigError(`REMINDER_MINUTES 형식이 잘못되었습니다: "${raw}". 예: 1440 또는 1440,60`);
  }
  return values;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    canvasToken: required(env, "CANVAS_PRIVATE_TOKEN"),
    canvasBaseUrl: (optional(env, "CANVAS_BASE_URL") ?? "https://myetl.snu.ac.kr").replace(/\/+$/, ""),
    googleClientId: required(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    googleRefreshToken: optional(env, "GOOGLE_REFRESH_TOKEN"),
    googleCalendarId: optional(env, "GOOGLE_CALENDAR_ID"),
    reminderMinutes: parseReminderMinutes(env["REMINDER_MINUTES"]),
  };
}

const DAY_MS = 86_400_000;

export function syncWindow(now: Date = new Date()): SyncWindow {
  return {
    start: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS),
    end: new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/config.test.ts && pnpm typecheck`
Expected: 8 passed, tsc 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): 환경 변수 로더와 상수, 조회 창 계산" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 3: 재시도 래퍼 `src/retry.ts`

**Files:**
- Create: `src/retry.ts`, `test/retry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class HttpError extends Error { readonly status: number; constructor(status: number, message: string) }
  export function statusOf(err: unknown): number | undefined;   // HttpError, gaxios(response.status), code 숫자/3자리 문자열
  export function isRetryableError(err: unknown): boolean;      // 429, 5xx, 네트워크 오류
  export function errorMessage(err: unknown): string;
  export type RetryOptions = { retries?: number; baseDelayMs?: number; isRetryable?: (e: unknown) => boolean; sleep?: (ms: number) => Promise<void> };
  export function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/retry.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { HttpError, isRetryableError, statusOf, withRetry, errorMessage } from "../src/retry.ts";

const noSleep = async () => {};

describe("statusOf / isRetryableError", () => {
  it("reads HttpError status", () => {
    expect(statusOf(new HttpError(503, "x"))).toBe(503);
    expect(isRetryableError(new HttpError(503, "x"))).toBe(true);
    expect(isRetryableError(new HttpError(429, "x"))).toBe(true);
    expect(isRetryableError(new HttpError(404, "x"))).toBe(false);
  });
  it("reads gaxios-style errors", () => {
    expect(statusOf({ response: { status: 500 } })).toBe(500);
    expect(statusOf({ code: "502" })).toBe(502);
    expect(statusOf({ code: 403 })).toBe(403);
    expect(statusOf({ code: "ECONNRESET" })).toBeUndefined();
  });
  it("treats network errors as retryable and plain errors as not", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn(async () => 42);
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries retryable errors up to `retries` times with exponential delays", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => { throw new HttpError(500, "down"); });
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } }))
      .rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([10, 20, 40]);
  });
  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn(async () => { throw new HttpError(401, "nope"); });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls < 2) throw new TypeError("fetch failed"); return "ok"; };
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
  });
});

describe("errorMessage", () => {
  it("extracts a message from anything", () => {
    expect(errorMessage(new Error("a"))).toBe("a");
    expect(errorMessage("b")).toBe("b");
    expect(errorMessage({ message: "c" })).toBe("c");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/retry.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/retry.ts`

```ts
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

type ErrorLike = { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: unknown };

export function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  const e = (err ?? {}) as ErrorLike;
  for (const candidate of [e.response?.status, e.status, e.code]) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

export function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const e = (err ?? {}) as ErrorLike;
  // fetch 네트워크 오류는 TypeError, Node 소켓 오류는 code가 "ECONNRESET" 같은 문자열
  return err instanceof TypeError || typeof e.code === "string";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const e = (err ?? {}) as ErrorLike;
  return typeof e.message === "string" ? e.message : String(err);
}

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(base * 2 ** attempt);
      attempt++;
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/retry.test.ts && pnpm typecheck`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/retry.ts test/retry.test.ts
git commit -m "feat(retry): HTTP 오류 분류와 지수 백오프 재시도" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 4: Canvas planner 클라이언트 `src/canvas.ts`

**Files:**
- Create: `src/canvas.ts`, `test/canvas.test.ts`

**Interfaces:**
- Consumes: `Config`, `SyncWindow` (Task 2), `withRetry`, `HttpError` (Task 3)
- Produces:
  ```ts
  export type EtlItem = { key: string; courseId: number; courseName: string; title: string; dueAt: string; url: string; submitted: boolean; pointsPossible: number | null };
  export type PlannerItem = { plannable_type: string; plannable_id: number; course_id?: number; context_name?: string; plannable_date?: string | null; html_url?: string; submissions?: false | { submitted?: boolean }; plannable?: { title?: string; name?: string; due_at?: string | null; points_possible?: number | null } };
  export type FetchLike = typeof fetch;
  export class CanvasAuthError extends Error {}
  export function parseNextLink(linkHeader: string | null): string | null;
  export function normalizeItem(raw: PlannerItem, baseUrl: string): EtlItem | null;
  export function fetchPlannerItems(config: Pick<Config, "canvasToken" | "canvasBaseUrl">, window: SyncWindow, fetchImpl?: FetchLike): Promise<EtlItem[]>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/canvas.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { CanvasAuthError, fetchPlannerItems, normalizeItem, parseNextLink, type PlannerItem } from "../src/canvas.ts";

const config = { canvasToken: "tok", canvasBaseUrl: "https://lms.test" };
const window = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const assignment: PlannerItem = {
  plannable_type: "assignment",
  plannable_id: 375398,
  course_id: 306086,
  context_name: "2026-2 전기·정보세미나 3 (001)",
  plannable_date: "2026-09-10T14:59:59Z",
  html_url: "/courses/306086/assignments/375398",
  submissions: { submitted: false },
  plannable: { title: "2주차 소감문 제출", due_at: "2026-09-10T14:59:59Z", points_possible: 0 },
};

describe("parseNextLink", () => {
  it("finds rel=next among several links", () => {
    const header = '<https://lms.test/api/v1/planner/items?page=first>; rel="current",<https://lms.test/api/v1/planner/items?page=2>; rel="next",<https://lms.test/x?page=first>; rel="first"';
    expect(parseNextLink(header)).toBe("https://lms.test/api/v1/planner/items?page=2");
  });
  it("returns null without next", () => {
    expect(parseNextLink('<https://a>; rel="current"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("normalizeItem", () => {
  it("normalizes an assignment", () => {
    expect(normalizeItem(assignment, config.canvasBaseUrl)).toEqual({
      key: "assignment:375398",
      courseId: 306086,
      courseName: "2026-2 전기·정보세미나 3 (001)",
      title: "2주차 소감문 제출",
      dueAt: "2026-09-10T14:59:59.000Z",
      url: "https://lms.test/courses/306086/assignments/375398",
      submitted: false,
      pointsPossible: 0,
    });
  });
  it("reads submitted=true and submissions=false", () => {
    expect(normalizeItem({ ...assignment, submissions: { submitted: true } }, config.canvasBaseUrl)?.submitted).toBe(true);
    expect(normalizeItem({ ...assignment, submissions: false }, config.canvasBaseUrl)?.submitted).toBe(false);
  });
  it("drops unsupported types and items without a due date", () => {
    expect(normalizeItem({ ...assignment, plannable_type: "calendar_event" }, config.canvasBaseUrl)).toBeNull();
    expect(normalizeItem({ ...assignment, plannable_date: null, plannable: { title: "x", due_at: null } }, config.canvasBaseUrl)).toBeNull();
  });
  it("falls back to plannable.due_at and keeps quiz/discussion", () => {
    const quiz: PlannerItem = { ...assignment, plannable_type: "quiz", plannable_id: 7, plannable_date: undefined, plannable: { title: "퀴즈", due_at: "2026-09-12T00:00:00Z" } };
    expect(normalizeItem(quiz, config.canvasBaseUrl)?.key).toBe("quiz:7");
    expect(normalizeItem({ ...assignment, plannable_type: "discussion_topic" }, config.canvasBaseUrl)?.key).toBe("discussion_topic:375398");
  });
});

describe("fetchPlannerItems", () => {
  it("sends bearer token and window, follows Link next, filters items", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
      if (url.includes("page=2")) return json([{ ...assignment, plannable_id: 2 }]);
      return json([assignment, { ...assignment, plannable_type: "announcement" }], { link: `<${config.canvasBaseUrl}/api/v1/planner/items?page=2>; rel="next"` });
    }) as unknown as typeof fetch;

    const items = await fetchPlannerItems(config, window, fetchImpl);
    expect(items.map((i) => i.key)).toEqual(["assignment:375398", "assignment:2"]);
    const first = new URL(calls[0]!);
    expect(first.pathname).toBe("/api/v1/planner/items");
    expect(first.searchParams.get("start_date")).toBe(window.start.toISOString());
    expect(first.searchParams.get("end_date")).toBe(window.end.toISOString());
    expect(first.searchParams.get("per_page")).toBe("50");
    expect(calls).toHaveLength(2);
  });
  it("throws CanvasAuthError on 401 without retrying", async () => {
    const fetchImpl = vi.fn(async () => json({ errors: [{ message: "사용자 인증 필요" }] }, {}, 401)) as unknown as typeof fetch;
    await expect(fetchPlannerItems(config, window, fetchImpl)).rejects.toBeInstanceOf(CanvasAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/canvas.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/canvas.ts`

```ts
import type { Config, SyncWindow } from "./config.ts";
import { HttpError, withRetry } from "./retry.ts";

export type EtlItem = {
  key: string;
  courseId: number;
  courseName: string;
  title: string;
  dueAt: string;
  url: string;
  submitted: boolean;
  pointsPossible: number | null;
};

export type PlannerItem = {
  plannable_type: string;
  plannable_id: number;
  course_id?: number;
  context_name?: string;
  plannable_date?: string | null;
  html_url?: string;
  submissions?: false | { submitted?: boolean };
  plannable?: { title?: string; name?: string; due_at?: string | null; points_possible?: number | null };
};

export type FetchLike = typeof fetch;

export class CanvasAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasAuthError";
  }
}

const INCLUDED_TYPES = new Set(["assignment", "quiz", "discussion_topic"]);

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function normalizeItem(raw: PlannerItem, baseUrl: string): EtlItem | null {
  if (!INCLUDED_TYPES.has(raw.plannable_type)) return null;
  const due = raw.plannable_date ?? raw.plannable?.due_at ?? null;
  if (!due) return null;
  const submissions = raw.submissions;
  return {
    key: `${raw.plannable_type}:${raw.plannable_id}`,
    courseId: raw.course_id ?? 0,
    courseName: raw.context_name ?? "",
    title: raw.plannable?.title ?? raw.plannable?.name ?? "(제목 없음)",
    dueAt: new Date(due).toISOString(),
    url: raw.html_url ? new URL(raw.html_url, baseUrl).toString() : baseUrl,
    submitted: typeof submissions === "object" && submissions !== null && submissions.submitted === true,
    pointsPossible: raw.plannable?.points_possible ?? null,
  };
}

export async function fetchPlannerItems(
  config: Pick<Config, "canvasToken" | "canvasBaseUrl">,
  window: SyncWindow,
  fetchImpl: FetchLike = fetch,
): Promise<EtlItem[]> {
  const first = new URL("/api/v1/planner/items", config.canvasBaseUrl);
  first.searchParams.set("start_date", window.start.toISOString());
  first.searchParams.set("end_date", window.end.toISOString());
  first.searchParams.set("per_page", "50");

  const items: EtlItem[] = [];
  let next: string | null = first.toString();
  while (next) {
    const url: string = next;
    const res = await withRetry(async () => {
      const r = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.canvasToken}`, Accept: "application/json" },
      });
      if (r.status === 401) {
        throw new CanvasAuthError(
          "Canvas 토큰이 거부되었습니다(401). myetl 설정 → 승인된 통합에서 새 토큰을 발급해 CANVAS_PRIVATE_TOKEN을 갱신하세요.",
        );
      }
      if (!r.ok) throw new HttpError(r.status, `Canvas 요청 실패 ${r.status}: ${url}`);
      return r;
    });
    const page = (await res.json()) as PlannerItem[];
    for (const raw of page) {
      const item = normalizeItem(raw, config.canvasBaseUrl);
      if (item) items.push(item);
    }
    next = parseNextLink(res.headers.get("link"));
  }
  return items;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/canvas.test.ts && pnpm typecheck`
Expected: 8 passed.

- [ ] **Step 5: 실제 Canvas로 스모크 확인** (읽기 전용, `.env` 토큰 사용)

Run: `node --env-file=.env -e "const {fetchPlannerItems}=await import('./src/canvas.ts');const {loadConfig,syncWindow}=await import('./src/config.ts');const items=await fetchPlannerItems(loadConfig(),syncWindow());console.log(items.length, items.slice(0,2))" --input-type=module`
Expected: 건수와 앞 2건이 출력됨(2026-09-05 기준 7건). 401이면 CanvasAuthError 메시지.

- [ ] **Step 6: Commit**

```bash
git add src/canvas.ts test/canvas.test.ts
git commit -m "feat(canvas): planner API 조회, 페이지네이션, EtlItem 정규화" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 5: 이벤트 매퍼 `src/mapper.ts`

**Files:**
- Create: `src/mapper.ts`, `test/mapper.test.ts`

**Interfaces:**
- Consumes: `EtlItem` (Task 4), `TIME_ZONE` (Task 2)
- Produces:
  ```ts
  export type DesiredEvent = { key: string; hash: string; summary: string; description: string; start: string; end: string; reminderMinutes: number[] };
  export function shortCourseName(name: string): string;
  export function formatKst(iso: string): string;            // "2026-09-10 (목) 23:59"
  export function toDesiredEvent(item: EtlItem, reminderMinutes: number[]): DesiredEvent;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/mapper.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { EtlItem } from "../src/canvas.ts";
import { formatKst, shortCourseName, toDesiredEvent } from "../src/mapper.ts";

const item: EtlItem = {
  key: "assignment:375398",
  courseId: 306086,
  courseName: "2026-2 전기·정보세미나 3 (001)",
  title: "2주차 소감문 제출",
  dueAt: "2026-09-10T14:59:59.000Z",
  url: "https://myetl.snu.ac.kr/courses/306086/assignments/375398",
  submitted: false,
  pointsPossible: 10,
};

describe("shortCourseName", () => {
  it("strips semester prefix and section suffix", () => {
    expect(shortCourseName("2026-2 전기·정보세미나 3 (001)")).toBe("전기·정보세미나 3");
    expect(shortCourseName("2026-3 (공유)반도체소자 (001)")).toBe("(공유)반도체소자");
  });
  it("leaves names without those parts alone", () => {
    expect(shortCourseName("디지털 시스템 설계")).toBe("디지털 시스템 설계");
    expect(shortCourseName("")).toBe("");
  });
});

describe("formatKst", () => {
  it("renders Korean date with weekday in Asia/Seoul", () => {
    expect(formatKst("2026-09-10T14:59:59Z")).toBe("2026-09-10 (목) 23:59");
    expect(formatKst("2026-09-10T15:00:00Z")).toBe("2026-09-11 (금) 00:00");
  });
});

describe("toDesiredEvent", () => {
  it("builds summary, 30-minute block, description, reminders", () => {
    const e = toDesiredEvent(item, [1440, 60]);
    expect(e.key).toBe("assignment:375398");
    expect(e.summary).toBe("[전기·정보세미나 3] 2주차 소감문 제출");
    expect(e.start).toBe("2026-09-10T14:29:59.000Z");
    expect(e.end).toBe("2026-09-10T14:59:59.000Z");
    expect(e.reminderMinutes).toEqual([1440, 60]);
    expect(e.description.split("\n")).toEqual([
      "2026-2 전기·정보세미나 3 (001)",
      "마감: 2026-09-10 (목) 23:59 KST",
      "배점: 10점",
      "상태: 미제출",
      "https://myetl.snu.ac.kr/courses/306086/assignments/375398",
    ]);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("marks submitted items and drops reminders", () => {
    const e = toDesiredEvent({ ...item, submitted: true, pointsPossible: null }, [1440]);
    expect(e.summary).toBe("✅ [전기·정보세미나 3] 2주차 소감문 제출");
    expect(e.reminderMinutes).toEqual([]);
    expect(e.description).not.toContain("배점");
    expect(e.description).toContain("상태: 제출완료");
  });
  it("hash is stable for same input and changes with any field", () => {
    const a = toDesiredEvent(item, [1440]);
    const b = toDesiredEvent({ ...item }, [1440]);
    expect(a.hash).toBe(b.hash);
    expect(toDesiredEvent(item, [60]).hash).not.toBe(a.hash);
    expect(toDesiredEvent({ ...item, title: "x" }, [1440]).hash).not.toBe(a.hash);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/mapper.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/mapper.ts`

```ts
import { createHash } from "node:crypto";
import type { EtlItem } from "./canvas.ts";
import { TIME_ZONE } from "./config.ts";

export type DesiredEvent = {
  key: string;
  hash: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  reminderMinutes: number[];
};

const EVENT_LENGTH_MS = 30 * 60 * 1000;

export function shortCourseName(name: string): string {
  const stripped = name.replace(/^\d{4}-\d\s+/, "").replace(/\s*\(\d+\)\s*$/, "").trim();
  return stripped || name;
}

const kstFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatKst(iso: string): string {
  const parts = kstFormatter.formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} (${get("weekday")}) ${get("hour")}:${get("minute")}`;
}

export function toDesiredEvent(item: EtlItem, reminderMinutes: number[]): DesiredEvent {
  const course = shortCourseName(item.courseName);
  const summary = `${item.submitted ? "✅ " : ""}[${course}] ${item.title}`;
  const end = new Date(item.dueAt);
  const start = new Date(end.getTime() - EVENT_LENGTH_MS);
  const lines = [
    item.courseName,
    `마감: ${formatKst(item.dueAt)} KST`,
    ...(item.pointsPossible !== null ? [`배점: ${item.pointsPossible}점`] : []),
    `상태: ${item.submitted ? "제출완료" : "미제출"}`,
    item.url,
  ];
  const body = {
    summary,
    description: lines.join("\n"),
    start: start.toISOString(),
    end: end.toISOString(),
    reminderMinutes: item.submitted ? [] : [...reminderMinutes],
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { key: item.key, hash, ...body };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/mapper.test.ts && pnpm typecheck`
Expected: 6 passed. `formatKst` 테스트가 요일 때문에 실패하면 Node ICU 문제이므로 `node -p "new Intl.DateTimeFormat('ko-KR',{weekday:'short',timeZone:'Asia/Seoul'}).format(new Date('2026-09-10T14:59:59Z'))"`가 `목`을 찍는지 확인한다.

- [ ] **Step 5: Commit**

```bash
git add src/mapper.ts test/mapper.test.ts
git commit -m "feat(mapper): EtlItem → 캘린더 이벤트 본문과 변경 감지 해시" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 6: 동기화 계획 `src/sync.ts`

**Files:**
- Create: `src/sync.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: `DesiredEvent` (Task 5)
- Produces:
  ```ts
  export type ManagedEvent = { id: string; key: string; hash: string };
  export type SyncPlan = { inserts: DesiredEvent[]; updates: { id: string; event: DesiredEvent }[]; deletes: ManagedEvent[] };
  export function planSync(desired: DesiredEvent[], existing: ManagedEvent[]): SyncPlan;
  export function isEmptyPlan(plan: SyncPlan): boolean;
  export function describePlan(plan: SyncPlan): string[];
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/sync.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { DesiredEvent } from "../src/mapper.ts";
import { describePlan, isEmptyPlan, planSync, type ManagedEvent } from "../src/sync.ts";

function desired(key: string, hash: string): DesiredEvent {
  return { key, hash, summary: `S ${key}`, description: "", start: "2026-09-10T14:29:59.000Z", end: "2026-09-10T14:59:59.000Z", reminderMinutes: [1440] };
}
const managed = (id: string, key: string, hash: string): ManagedEvent => ({ id, key, hash });

describe("planSync", () => {
  it("inserts new, updates changed, skips same, deletes missing", () => {
    const plan = planSync(
      [desired("a", "h1"), desired("b", "h2-new"), desired("c", "h3")],
      [managed("id-b", "b", "h2-old"), managed("id-c", "c", "h3"), managed("id-d", "d", "h4")],
    );
    expect(plan.inserts.map((e) => e.key)).toEqual(["a"]);
    expect(plan.updates).toEqual([{ id: "id-b", event: desired("b", "h2-new") }]);
    expect(plan.deletes).toEqual([managed("id-d", "d", "h4")]);
  });
  it("is idempotent: same state yields empty plan", () => {
    const plan = planSync([desired("a", "h1")], [managed("id-a", "a", "h1")]);
    expect(isEmptyPlan(plan)).toBe(true);
  });
  it("keeps first duplicate managed event and deletes the rest", () => {
    const plan = planSync([desired("a", "h1")], [managed("id-1", "a", "h1"), managed("id-2", "a", "h1")]);
    expect(plan.deletes.map((m) => m.id)).toEqual(["id-2"]);
    expect(plan.updates).toEqual([]);
  });
  it("dedupes desired by key (last wins)", () => {
    const plan = planSync([desired("a", "h1"), desired("a", "h2")], []);
    expect(plan.inserts).toEqual([desired("a", "h2")]);
  });
});

describe("describePlan", () => {
  it("lists one line per change", () => {
    const plan = planSync([desired("a", "h1"), desired("b", "h2")], [managed("id-b", "b", "old"), managed("id-z", "z", "h")]);
    expect(describePlan(plan)).toEqual([
      "+ S a (2026-09-10T14:59:59.000Z)",
      "~ S b (2026-09-10T14:59:59.000Z)",
      "- z",
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/sync.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/sync.ts`

```ts
import type { DesiredEvent } from "./mapper.ts";

export type ManagedEvent = { id: string; key: string; hash: string };

export type SyncPlan = {
  inserts: DesiredEvent[];
  updates: { id: string; event: DesiredEvent }[];
  deletes: ManagedEvent[];
};

export function planSync(desired: DesiredEvent[], existing: ManagedEvent[]): SyncPlan {
  const desiredByKey = new Map<string, DesiredEvent>();
  for (const d of desired) desiredByKey.set(d.key, d);

  const existingByKey = new Map<string, ManagedEvent>();
  const deletes: ManagedEvent[] = [];
  for (const e of existing) {
    if (existingByKey.has(e.key)) deletes.push(e); // 과거 중복 정리
    else existingByKey.set(e.key, e);
  }

  const inserts: DesiredEvent[] = [];
  const updates: SyncPlan["updates"] = [];
  for (const [key, d] of desiredByKey) {
    const e = existingByKey.get(key);
    if (!e) inserts.push(d);
    else if (e.hash !== d.hash) updates.push({ id: e.id, event: d });
  }
  for (const [key, e] of existingByKey) {
    if (!desiredByKey.has(key)) deletes.push(e);
  }
  return { inserts, updates, deletes };
}

export function isEmptyPlan(plan: SyncPlan): boolean {
  return plan.inserts.length + plan.updates.length + plan.deletes.length === 0;
}

export function describePlan(plan: SyncPlan): string[] {
  return [
    ...plan.inserts.map((e) => `+ ${e.summary} (${e.end})`),
    ...plan.updates.map((u) => `~ ${u.event.summary} (${u.event.end})`),
    ...plan.deletes.map((m) => `- ${m.key}`),
  ];
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/sync.test.ts && pnpm typecheck`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts test/sync.test.ts
git commit -m "feat(sync): desired/existing 대조로 insert·update·delete 계획 수립" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 7: Google Calendar 어댑터 `src/google.ts`

**Files:**
- Create: `src/google.ts`, `test/google.test.ts`

**Interfaces:**
- Consumes: `Config`, `ConfigError`, `CALENDAR_NAME`, `TIME_ZONE`, `SyncWindow` (Task 2), `withRetry`, `statusOf`, `errorMessage` (Task 3), `DesiredEvent` (Task 5), `ManagedEvent`, `SyncPlan` (Task 6)
- Produces:
  ```ts
  export const ETL_VERSION = "1";
  export type CalendarApi = calendar_v3.Calendar;
  export type ApplyResult = { ok: number; failures: { action: "insert" | "update" | "delete"; key: string; error: string }[] };
  export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client;
  export function createGoogleClient(config: Config): { api: CalendarApi; oauth: OAuth2Client };   // refresh token 없으면 ConfigError
  export function toGoogleEventBody(e: DesiredEvent): calendar_v3.Schema$Event;
  export function fromGoogleEvent(ev: calendar_v3.Schema$Event): ManagedEvent | null;
  export function findOrCreateCalendar(api: CalendarApi, calendarId: string | null): Promise<{ id: string; created: boolean }>;
  export function listManagedEvents(api: CalendarApi, calendarId: string, window: SyncWindow): Promise<ManagedEvent[]>;
  export function applyPlan(api: CalendarApi, calendarId: string, plan: SyncPlan, log: (line: string) => void): Promise<ApplyResult>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/google.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.ts";
import type { DesiredEvent } from "../src/mapper.ts";
import {
  applyPlan, createGoogleClient, findOrCreateCalendar, fromGoogleEvent, listManagedEvents, toGoogleEventBody, type CalendarApi,
} from "../src/google.ts";

const event: DesiredEvent = {
  key: "assignment:1", hash: "abc", summary: "[과목] 과제", description: "d",
  start: "2026-09-10T14:29:59.000Z", end: "2026-09-10T14:59:59.000Z", reminderMinutes: [1440],
};
const window = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

describe("toGoogleEventBody / fromGoogleEvent", () => {
  it("maps fields, reminders and private properties", () => {
    const body = toGoogleEventBody(event);
    expect(body.summary).toBe("[과목] 과제");
    expect(body.start).toEqual({ dateTime: event.start, timeZone: "Asia/Seoul" });
    expect(body.end).toEqual({ dateTime: event.end, timeZone: "Asia/Seoul" });
    expect(body.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] });
    expect(body.extendedProperties?.private).toEqual({ etlKey: "assignment:1", etlHash: "abc", etlVersion: "1" });
  });
  it("sends empty overrides when no reminders", () => {
    expect(toGoogleEventBody({ ...event, reminderMinutes: [] }).reminders).toEqual({ useDefault: false, overrides: [] });
  });
  it("round-trips managed metadata and ignores foreign events", () => {
    expect(fromGoogleEvent({ id: "g1", extendedProperties: { private: { etlKey: "assignment:1", etlHash: "abc" } } })).toEqual({ id: "g1", key: "assignment:1", hash: "abc" });
    expect(fromGoogleEvent({ id: "g2", summary: "생일" })).toBeNull();
  });
});

describe("createGoogleClient", () => {
  it("requires a refresh token", () => {
    expect(() => createGoogleClient({
      canvasToken: "t", canvasBaseUrl: "https://x", googleClientId: "id", googleClientSecret: "s",
      googleRefreshToken: null, googleCalendarId: null, reminderMinutes: [1440],
    })).toThrow(ConfigError);
  });
});

function fakeApi(overrides: Record<string, unknown>): CalendarApi {
  return overrides as unknown as CalendarApi;
}

describe("findOrCreateCalendar", () => {
  it("uses configured id when it exists", async () => {
    const get = vi.fn(async () => ({ data: { id: "cal-1" } }));
    const api = fakeApi({ calendars: { get } });
    await expect(findOrCreateCalendar(api, "cal-1")).resolves.toEqual({ id: "cal-1", created: false });
    expect(get).toHaveBeenCalledWith({ calendarId: "cal-1" });
  });
  it("explains a missing configured id", async () => {
    const api = fakeApi({ calendars: { get: vi.fn(async () => { throw { response: { status: 404 } }; }) } });
    await expect(findOrCreateCalendar(api, "gone")).rejects.toThrow(/GOOGLE_CALENDAR_ID/);
  });
  it("finds by name, else creates", async () => {
    const list = vi.fn(async () => ({ data: { items: [{ id: "other", summary: "휴가" }, { id: "cal-etl", summary: "eTL 과제" }] } }));
    const api = fakeApi({ calendarList: { list } });
    await expect(findOrCreateCalendar(api, null)).resolves.toEqual({ id: "cal-etl", created: false });

    const insert = vi.fn(async () => ({ data: { id: "cal-new" } }));
    const api2 = fakeApi({ calendarList: { list: vi.fn(async () => ({ data: { items: [] } })) }, calendars: { insert } });
    await expect(findOrCreateCalendar(api2, null)).resolves.toEqual({ id: "cal-new", created: true });
    expect(insert).toHaveBeenCalledWith({ requestBody: expect.objectContaining({ summary: "eTL 과제", timeZone: "Asia/Seoul" }) });
  });
});

describe("listManagedEvents", () => {
  it("pages through results and keeps only managed events", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ data: { items: [{ id: "g1", extendedProperties: { private: { etlKey: "a", etlHash: "h" } } }, { id: "x" }], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { items: [{ id: "g2", extendedProperties: { private: { etlKey: "b", etlHash: "h" } } }] } });
    const api = fakeApi({ events: { list } });
    const out = await listManagedEvents(api, "cal", window);
    expect(out.map((m) => m.id)).toEqual(["g1", "g2"]);
    expect(list.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      calendarId: "cal", privateExtendedProperty: ["etlVersion=1"], singleEvents: true, maxResults: 2500,
      timeMin: window.start.toISOString(), timeMax: window.end.toISOString(),
    }));
    expect(list.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ pageToken: "p2" }));
  });
});

describe("applyPlan", () => {
  it("inserts, updates, deletes and collects failures without stopping", async () => {
    const insert = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => { throw new Error("quota"); });
    const del = vi.fn(async () => { throw { response: { status: 410 } }; });
    const api = fakeApi({ events: { insert, update, delete: del } });
    const lines: string[] = [];
    const result = await applyPlan(api, "cal", {
      inserts: [event],
      updates: [{ id: "g1", event: { ...event, key: "assignment:2" } }],
      deletes: [{ id: "g9", key: "assignment:9", hash: "h" }],
    }, (l) => lines.push(l));
    expect(insert).toHaveBeenCalledWith({ calendarId: "cal", requestBody: toGoogleEventBody(event) });
    expect(update).toHaveBeenCalledWith({ calendarId: "cal", eventId: "g1", requestBody: toGoogleEventBody({ ...event, key: "assignment:2" }) });
    expect(del).toHaveBeenCalledWith({ calendarId: "cal", eventId: "g9" });
    expect(result.ok).toBe(2); // insert + delete(410은 이미 없음 → 성공 취급)
    expect(result.failures).toEqual([{ action: "update", key: "assignment:2", error: "quota" }]);
    expect(lines).toEqual(["+ [과목] 과제", "- assignment:9"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/google.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/google.ts`

```ts
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import { CALENDAR_NAME, ConfigError, TIME_ZONE, type Config, type SyncWindow } from "./config.ts";
import type { DesiredEvent } from "./mapper.ts";
import { errorMessage, statusOf, withRetry } from "./retry.ts";
import type { ManagedEvent, SyncPlan } from "./sync.ts";

export const ETL_VERSION = "1";
export type CalendarApi = calendar_v3.Calendar;

export type ApplyResult = {
  ok: number;
  failures: { action: "insert" | "update" | "delete"; key: string; error: string }[];
};

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client {
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function createGoogleClient(config: Config): { api: CalendarApi; oauth: OAuth2Client } {
  if (!config.googleRefreshToken) {
    throw new ConfigError("GOOGLE_REFRESH_TOKEN이 없습니다. 먼저 `pnpm auth`를 실행해 발급하세요.");
  }
  const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret);
  oauth.setCredentials({ refresh_token: config.googleRefreshToken });
  return { api: calendar({ version: "v3", auth: oauth }), oauth };
}

export function toGoogleEventBody(e: DesiredEvent): calendar_v3.Schema$Event {
  return {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start, timeZone: TIME_ZONE },
    end: { dateTime: e.end, timeZone: TIME_ZONE },
    reminders: {
      useDefault: false,
      overrides: e.reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
    },
    extendedProperties: { private: { etlKey: e.key, etlHash: e.hash, etlVersion: ETL_VERSION } },
  };
}

export function fromGoogleEvent(ev: calendar_v3.Schema$Event): ManagedEvent | null {
  const props = ev.extendedProperties?.private;
  if (!ev.id || !props?.etlKey) return null;
  return { id: ev.id, key: props.etlKey, hash: props.etlHash ?? "" };
}

export async function findOrCreateCalendar(api: CalendarApi, calendarId: string | null): Promise<{ id: string; created: boolean }> {
  if (calendarId) {
    try {
      await withRetry(() => api.calendars.get({ calendarId }));
      return { id: calendarId, created: false };
    } catch (err) {
      if (statusOf(err) === 404) {
        throw new Error(`GOOGLE_CALENDAR_ID(${calendarId}) 캘린더를 찾을 수 없습니다. 값을 확인하거나 비워 두면 새로 만듭니다.`);
      }
      throw err;
    }
  }
  const list = await withRetry(() => api.calendarList.list({ minAccessRole: "writer" }));
  const found = list.data.items?.find((c) => c.summary === CALENDAR_NAME);
  if (found?.id) return { id: found.id, created: false };

  const created = await withRetry(() =>
    api.calendars.insert({
      requestBody: { summary: CALENDAR_NAME, timeZone: TIME_ZONE, description: "eTL(Canvas) 과제 마감 자동 동기화" },
    }),
  );
  const id = created.data.id;
  if (!id) throw new Error("캘린더를 만들었지만 ID를 받지 못했습니다.");
  return { id, created: true };
}

export async function listManagedEvents(api: CalendarApi, calendarId: string, window: SyncWindow): Promise<ManagedEvent[]> {
  const out: ManagedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(() =>
      api.events.list({
        calendarId,
        privateExtendedProperty: [`etlVersion=${ETL_VERSION}`],
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        pageToken,
      }),
    );
    for (const ev of res.data.items ?? []) {
      const managed = fromGoogleEvent(ev);
      if (managed) out.push(managed);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function applyPlan(api: CalendarApi, calendarId: string, plan: SyncPlan, log: (line: string) => void): Promise<ApplyResult> {
  const result: ApplyResult = { ok: 0, failures: [] };

  for (const e of plan.inserts) {
    try {
      await withRetry(() => api.events.insert({ calendarId, requestBody: toGoogleEventBody(e) }));
      result.ok++;
      log(`+ ${e.summary}`);
    } catch (err) {
      result.failures.push({ action: "insert", key: e.key, error: errorMessage(err) });
    }
  }
  for (const { id, event } of plan.updates) {
    try {
      await withRetry(() => api.events.update({ calendarId, eventId: id, requestBody: toGoogleEventBody(event) }));
      result.ok++;
      log(`~ ${event.summary}`);
    } catch (err) {
      result.failures.push({ action: "update", key: event.key, error: errorMessage(err) });
    }
  }
  for (const m of plan.deletes) {
    try {
      await withRetry(() => api.events.delete({ calendarId, eventId: m.id }));
      result.ok++;
      log(`- ${m.key}`);
    } catch (err) {
      const status = statusOf(err);
      if (status === 404 || status === 410) {
        result.ok++;
        log(`- ${m.key}`);
        continue;
      }
      result.failures.push({ action: "delete", key: m.key, error: errorMessage(err) });
    }
  }
  return result;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/google.test.ts && pnpm typecheck`
Expected: 8 passed. 타입 오류가 `calendar({ version: "v3", auth })`에서 나면 `auth: oauth as never` 대신 `google-auth-library`의 `OAuth2Client`가 `@googleapis/calendar`가 기대하는 버전과 같은지 `pnpm why google-auth-library`로 확인하고, 다르면 `@googleapis/calendar`가 끌어오는 버전으로 맞춘다.

- [ ] **Step 5: Commit**

```bash
git add src/google.ts test/google.test.ts
git commit -m "feat(google): OAuth 클라이언트, 캘린더 find-or-create, 이벤트 조회·반영" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 8: 로컬 OAuth 동의 플로우 `src/auth.ts`

**Files:**
- Create: `src/auth.ts`, `test/auth.test.ts`

**Interfaces:**
- Consumes: `GOOGLE_SCOPE`, `Config` (Task 2), `createOAuthClient`, `findOrCreateCalendar` (Task 7)
- Produces:
  ```ts
  export function receiveCodeViaLoopback(onReady: (redirectUri: string) => void | Promise<void>): Promise<{ code: string; redirectUri: string }>;
  export function openBrowser(url: string): void;
  export function runAuth(config: Pick<Config, "googleClientId" | "googleClientSecret" | "googleCalendarId">, opts: { log: (line: string) => void; openBrowser?: (url: string) => void }): Promise<{ refreshToken: string; calendarId: string }>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/auth.test.ts` (루프백 서버만 테스트. Google 호출은 하지 않는다.)

```ts
import { describe, expect, it } from "vitest";
import { receiveCodeViaLoopback } from "../src/auth.ts";

describe("receiveCodeViaLoopback", () => {
  it("opens a 127.0.0.1 port, resolves with the code from the callback", async () => {
    let uri = "";
    const pending = receiveCodeViaLoopback((redirectUri) => { uri = redirectUri; });
    // onReady는 listen 직후 호출되므로 한 틱 기다린다
    await new Promise((r) => setTimeout(r, 50));
    expect(uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${uri}/?code=abc123&scope=x`);
    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: "abc123", redirectUri: uri });
  });
  it("rejects when Google returns an error", async () => {
    let uri = "";
    const pending = receiveCodeViaLoopback((redirectUri) => { uri = redirectUri; });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${uri}/?error=access_denied`);
    await expect(pending).rejects.toThrow(/access_denied/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run test/auth.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/auth.ts`

```ts
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { calendar } from "@googleapis/calendar";
import { GOOGLE_SCOPE, type Config } from "./config.ts";
import { createOAuthClient, findOrCreateCalendar } from "./google.ts";

export function receiveCodeViaLoopback(
  onReady: (redirectUri: string) => void | Promise<void>,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(code
        ? "<h2>인증 완료. 이 창을 닫고 터미널로 돌아가세요.</h2>"
        : `<h2>인증 실패: ${error}</h2>`);
      server.close();
      if (code) resolve({ code, redirectUri });
      else reject(new Error(`Google 인증이 거부되었습니다: ${error}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("로컬 콜백 포트를 열 수 없습니다."));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}`;
      Promise.resolve(onReady(redirectUri)).catch(reject);
    });
  });
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // cmd의 & 해석을 피하려고 URL을 따옴표로 감싼 채 그대로 넘긴다
      spawn("cmd.exe", ["/c", "start", '""', `"${url}"`], { windowsVerbatimArguments: true, stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // 브라우저를 못 열어도 URL은 터미널에 출력되므로 사용자가 직접 열 수 있다
  }
}

export async function runAuth(
  config: Pick<Config, "googleClientId" | "googleClientSecret" | "googleCalendarId">,
  opts: { log: (line: string) => void; openBrowser?: (url: string) => void },
): Promise<{ refreshToken: string; calendarId: string }> {
  const open = opts.openBrowser ?? openBrowser;
  const { code, redirectUri } = await receiveCodeViaLoopback((uri) => {
    const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret, uri);
    const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GOOGLE_SCOPE] });
    opts.log("브라우저가 열립니다. 알림을 받을 Google 계정으로 로그인해 허용하세요.");
    opts.log(`브라우저가 안 열리면 이 주소를 직접 여세요:\n${url}\n`);
    open(url);
  });

  const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret, redirectUri);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "refresh token을 받지 못했습니다. Google 계정 → 보안 → 서드파티 앱에서 이 앱의 접근을 삭제한 뒤 다시 실행하세요.",
    );
  }
  oauth.setCredentials(tokens);
  const api = calendar({ version: "v3", auth: oauth });
  const cal = await findOrCreateCalendar(api, config.googleCalendarId);
  return { refreshToken: tokens.refresh_token, calendarId: cal.id };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run test/auth.test.ts && pnpm typecheck`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat(auth): 루프백 서버로 Google OAuth 동의를 받아 refresh token 발급" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

---

### Task 9: CLI 진입점 `src/index.ts`, README, 스모크 실행

**Files:**
- Create: `src/index.ts`, `README.md`
- Modify: `docs/SETUP.md` (4단계 명령이 실제 스크립트 이름과 같은지 확인만)

**Interfaces:**
- Consumes: 모든 이전 태스크의 export
- Produces: `pnpm sync`, `pnpm sync:dry`, `pnpm auth` 동작. exit code 0 성공 / 1 실패 / 2 사용법 오류.

- [ ] **Step 1: 구현** — `src/index.ts` (I/O 조립만 있으므로 단위 테스트 대신 스모크로 검증한다)

```ts
import { runAuth } from "./auth.ts";
import { CanvasAuthError, fetchPlannerItems } from "./canvas.ts";
import { ConfigError, loadConfig, syncWindow } from "./config.ts";
import { applyPlan, createGoogleClient, findOrCreateCalendar, listManagedEvents } from "./google.ts";
import { toDesiredEvent } from "./mapper.ts";
import { errorMessage } from "./retry.ts";
import { describePlan, isEmptyPlan, planSync } from "./sync.ts";

const log = (line: string): void => { console.log(line); };

async function commandSync(dryRun: boolean): Promise<number> {
  const config = loadConfig();
  const window = syncWindow();

  const items = await fetchPlannerItems(config, window);
  const desired = items.map((item) => toDesiredEvent(item, config.reminderMinutes));

  const { api } = createGoogleClient(config);
  const cal = await findOrCreateCalendar(api, config.googleCalendarId);
  if (cal.created) {
    log(`캘린더 "eTL 과제"를 새로 만들었습니다. 아래 값을 GOOGLE_CALENDAR_ID에 저장하세요:\n${cal.id}`);
  }
  const existing = await listManagedEvents(api, cal.id, window);
  const plan = planSync(desired, existing);

  log(`fetched ${items.length}, existing ${existing.length}, +${plan.inserts.length} ~${plan.updates.length} -${plan.deletes.length}${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) {
    for (const line of describePlan(plan)) log(line);
    return 0;
  }
  if (isEmptyPlan(plan)) {
    log("변경 없음");
    return 0;
  }
  const result = await applyPlan(api, cal.id, plan, log);
  if (result.failures.length > 0) {
    console.error(`실패 ${result.failures.length}건:`);
    for (const f of result.failures) console.error(`  ${f.action} ${f.key}: ${f.error}`);
    return 1;
  }
  return 0;
}

async function commandAuth(): Promise<number> {
  const config = loadConfig();
  const { refreshToken, calendarId } = await runAuth(config, { log });
  log("\n인증 완료. 아래 두 줄을 .env에 넣고, GitHub에 올릴 때는 Secrets에도 넣으세요:\n");
  log(`GOOGLE_REFRESH_TOKEN=${refreshToken}`);
  log(`GOOGLE_CALENDAR_ID=${calendarId}`);
  return 0;
}

function isInvalidGrant(err: unknown): boolean {
  const e = (err ?? {}) as { message?: unknown; response?: { data?: { error?: unknown } } };
  return e.response?.data?.error === "invalid_grant" || (typeof e.message === "string" && e.message.includes("invalid_grant"));
}

export async function main(argv: string[]): Promise<number> {
  const [command = "sync", ...rest] = argv;
  try {
    if (command === "sync") return await commandSync(rest.includes("--dry-run"));
    if (command === "auth") return await commandAuth();
    console.error(`알 수 없는 명령: ${command}\n사용법: node src/index.ts sync [--dry-run] | auth`);
    return 2;
  } catch (err) {
    if (err instanceof CanvasAuthError || err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    if (isInvalidGrant(err)) {
      console.error("Google refresh token이 만료되었거나 폐기되었습니다(invalid_grant). `pnpm auth`를 다시 실행해 GOOGLE_REFRESH_TOKEN을 갱신하세요.");
      return 1;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : errorMessage(err));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 2: README.md 작성**

```markdown
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
```

- [ ] **Step 3: 사용법 오류와 설정 오류 스모크**

Run: `node src/index.ts bogus; echo "exit=$?"`
Expected: `알 수 없는 명령: bogus` + `exit=2`

Run: `pnpm sync:dry`
Expected(아직 `pnpm auth` 전이므로): `GOOGLE_REFRESH_TOKEN이 없습니다. 먼저 \`pnpm auth\`를 실행해 발급하세요.` 그리고 exit 1. Canvas 조회는 그 전에 성공해야 하므로 401 메시지가 나오면 토큰을 먼저 확인한다.

- [ ] **Step 4: 전체 테스트·타입체크**

Run: `pnpm test && pnpm typecheck`
Expected: 모든 테스트 통과.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat(cli): sync/auth 명령, 오류 메시지와 exit code" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

- [ ] **Step 6: 사용자와 함께 실제 동의·첫 동기화** (사용자 개입 필요)

Run: `pnpm auth` → 브라우저에서 허용 → 출력된 두 줄을 `.env`에 추가.
Run: `pnpm sync:dry` → `fetched N, existing 0, +N ~0 -0 (dry-run)`과 `+ [과목] 과제명` 줄들.
Run: `pnpm sync` → 같은 건수가 `+`로 반영. 다시 `pnpm sync` → `변경 없음`(멱등 확인).
Google Calendar 웹에서 "eTL 과제" 캘린더와 이벤트의 알림 "1일 전"을 확인한다.

---

### Task 10: GitHub Actions 워크플로

**Files:**
- Create: `.github/workflows/sync.yml`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `pnpm sync`, `pnpm sync:dry`, `pnpm test`, `pnpm typecheck` (Task 1, 9)
- Produces: 3시간마다 자동 동기화, 푸시마다 테스트.

- [ ] **Step 1: 크론 워크플로 작성** — `.github/workflows/sync.yml`

```yaml
name: Sync eTL to Google Calendar

on:
  schedule:
    - cron: "23 */3 * * *"   # UTC 기준 3시간마다, 정시 혼잡 회피
  workflow_dispatch:
    inputs:
      dry_run:
        description: "변경 목록만 출력하고 쓰지 않음"
        type: boolean
        default: false

concurrency:
  group: etl-sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      CANVAS_PRIVATE_TOKEN: ${{ secrets.CANVAS_PRIVATE_TOKEN }}
      CANVAS_BASE_URL: https://myetl.snu.ac.kr
      GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
      GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
      GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}
      GOOGLE_CALENDAR_ID: ${{ secrets.GOOGLE_CALENDAR_ID }}
      REMINDER_MINUTES: ${{ vars.REMINDER_MINUTES }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Sync (dry-run)
        if: ${{ inputs.dry_run }}
        run: pnpm sync:dry
      - name: Sync
        if: ${{ !inputs.dry_run }}
        run: pnpm sync
```

- [ ] **Step 2: CI 워크플로 작성** — `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: YAML 문법 확인**

Run: `node -e "const y=require('node:fs').readFileSync('.github/workflows/sync.yml','utf8'); console.log(y.split('\n').length,'lines')"` (구문 검사는 GitHub이 하므로 여기서는 파일 존재만 확인). `pnpm/action-setup@v4`는 `package.json`의 `packageManager` 필드로 pnpm 버전을 읽으므로 `version` 입력이 없어야 한다.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/sync.yml .github/workflows/ci.yml
git commit -m "ci: 3시간마다 동기화하는 크론과 푸시 시 테스트 워크플로" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BFVkwN6VETqqDxFFb133Ao"
```

- [ ] **Step 5: GitHub에 올리고 Secrets 등록** (사용자 확인 후 실행. 저장소 생성은 외부에 남는 작업이므로 먼저 묻는다)

```bash
gh repo create etl-scheduler --private --source . --push
gh secret set -f .env
gh workflow run "Sync eTL to Google Calendar" -f dry_run=true
gh run watch
```
Expected: 저장소가 비공개로 생성되고, Secrets에 `.env`의 7개 키가 들어가며, 수동 실행이 초록불로 끝난다. `REMINDER_MINUTES`는 Secrets가 아니라 Variables에 두는 게 맞지만 Secrets에 있어도 무해하다(코드는 `vars.REMINDER_MINUTES`를 읽고 비어 있으면 기본 1440).

---

## Self-Review

**Spec coverage:**
- §5 구성 요소 7개 파일 → Task 2~9에 하나씩 대응. `src/auth.ts`는 스펙 §10의 `auth` 명령을 별도 파일로 뺀 것(스펙 §14의 구조에 파일 하나 추가).
- §6 Canvas 규칙(타입 필터, plannable_date 우선, 401) → Task 4.
- §7 매핑 규칙(약칭, ✅, 30분, 설명 5줄, 알림, extendedProperties, 해시) → Task 5 + Task 7의 `toGoogleEventBody`.
- §8 동기화 규칙(창 조회, key 대조, 중복 정리, 멱등) → Task 6 + Task 7의 `listManagedEvents`.
- §9 환경 변수 → Task 2. §10 CLI → Task 9. §11 오류 처리 → Task 3(재시도), Task 4(401), Task 7(404/410, 건별 실패), Task 9(invalid_grant, exit code).
- §12 테스트 → 각 태스크 Step 1. §13 운영 → Task 10.

**Placeholder scan:** 없음. 모든 코드 스텝에 실제 코드가 있다.

**Type consistency:** `EtlItem`(canvas) → `toDesiredEvent`(mapper) → `DesiredEvent` → `planSync`(sync) → `SyncPlan` → `applyPlan`(google). `ManagedEvent`는 sync.ts에 정의하고 google.ts가 import. `CalendarApi = calendar_v3.Calendar`. `statusOf`/`errorMessage`는 retry.ts에서 export되어 google.ts와 index.ts가 사용. 이름 불일치 없음.
