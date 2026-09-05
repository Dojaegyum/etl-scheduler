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
