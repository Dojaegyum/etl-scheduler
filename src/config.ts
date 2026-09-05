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
