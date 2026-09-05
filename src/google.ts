import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import { CALENDAR_NAME, ConfigError, TIME_ZONE, type Config, type SyncWindow } from "./config.ts";
import type { DesiredEvent } from "./mapper.ts";
import { errorMessage, statusOf, withRetry } from "./retry.ts";
import type { ManagedEvent, SyncPlan } from "./sync.ts";

export const ETL_VERSION = "1";
export type CalendarApi = calendar_v3.Calendar;
// @googleapis/calendar가 함께 내보내는 OAuth2 클라이언트를 써서 google-auth-library 버전 충돌을 피한다
export type OAuth2Client = InstanceType<typeof auth.OAuth2>;

export type ApplyResult = {
  ok: number;
  failures: { action: "insert" | "update" | "delete"; key: string; error: string }[];
};

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string): OAuth2Client {
  return new auth.OAuth2({ clientId, clientSecret, redirectUri });
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

export async function findOrCreateCalendar(
  api: CalendarApi,
  calendarId: string | null,
): Promise<{ id: string; created: boolean }> {
  if (calendarId) {
    try {
      await withRetry(() => api.calendars.get({ calendarId }));
      return { id: calendarId, created: false };
    } catch (err) {
      if (statusOf(err) === 404) {
        throw new Error(
          `GOOGLE_CALENDAR_ID(${calendarId}) 캘린더를 찾을 수 없습니다. 값을 확인하거나 비워 두면 새로 만듭니다.`,
        );
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

export async function applyPlan(
  api: CalendarApi,
  calendarId: string,
  plan: SyncPlan,
  log: (line: string) => void,
): Promise<ApplyResult> {
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
