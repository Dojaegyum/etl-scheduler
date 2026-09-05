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
