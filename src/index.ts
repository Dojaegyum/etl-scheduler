import { runAuth } from "./auth.ts";
import { CanvasAuthError, fetchPlannerItems } from "./canvas.ts";
import { ConfigError, loadConfig, syncWindow } from "./config.ts";
import { applyPlan, createGoogleClient, findOrCreateCalendar, listManagedEvents } from "./google.ts";
import { toDesiredEvent } from "./mapper.ts";
import { errorMessage } from "./retry.ts";
import { describePlan, isEmptyPlan, planSync } from "./sync.ts";

const log = (line: string): void => {
  console.log(line);
};

async function commandSync(dryRun: boolean): Promise<number> {
  const config = loadConfig();
  const window = syncWindow();

  const items = await fetchPlannerItems(config, window);
  const desired = items.map((item) => toDesiredEvent(item, config.reminderMinutes));

  // 동기화는 캘린더를 만들지 않는다. 크론이 돌 때마다 새 캘린더가 생기는 사고를 막기 위해 ID를 요구한다.
  if (!config.googleCalendarId) {
    throw new ConfigError("GOOGLE_CALENDAR_ID가 없습니다. `pnpm auth`를 실행하면 캘린더를 만들고 ID를 출력합니다.");
  }
  const { api } = createGoogleClient(config);
  const cal = await findOrCreateCalendar(api, config.googleCalendarId);
  const existing = await listManagedEvents(api, cal.id, window);
  const plan = planSync(desired, existing);

  log(
    `fetched ${items.length}, existing ${existing.length}, +${plan.inserts.length} ~${plan.updates.length} -${plan.deletes.length}${dryRun ? " (dry-run)" : ""}`,
  );
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
  const result = await runAuth(config, { log });
  // 캘린더 생성이 실패해도 토큰은 반드시 출력한다. 다음 실행은 동의 없이 캘린더만 다시 시도한다.
  log("\n아래 값을 .env에 넣고, GitHub에 올릴 때는 Secrets에도 넣으세요:\n");
  log(`GOOGLE_REFRESH_TOKEN=${result.refreshToken}`);
  if (result.calendarId) {
    log(`GOOGLE_CALENDAR_ID=${result.calendarId}`);
    return 0;
  }
  console.error(`\n캘린더를 만들지 못했습니다: ${result.calendarError}`);
  console.error("원인을 해결한 뒤 `pnpm auth`를 다시 실행하세요. 위 토큰이 .env에 있으면 브라우저 동의 없이 캘린더 생성만 다시 시도합니다.");
  return 1;
}

function isInvalidGrant(err: unknown): boolean {
  const e = (err ?? {}) as { message?: unknown; response?: { data?: { error?: unknown } } };
  return (
    e.response?.data?.error === "invalid_grant" ||
    (typeof e.message === "string" && e.message.includes("invalid_grant"))
  );
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
      console.error(
        "Google refresh token이 만료되었거나 폐기되었습니다(invalid_grant). `pnpm auth`를 다시 실행해 GOOGLE_REFRESH_TOKEN을 갱신하세요.",
      );
      return 1;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : errorMessage(err));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
