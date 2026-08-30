import {
  EVENT_TYPE_LABEL,
  SCHEDULE_EVENT_TYPES,
  SCHEDULE_SOURCE_TYPES,
  SCHEDULE_STATUSES,
  type ScheduleEvent,
  type ScheduleEventType,
  type ScheduleRange,
  type ScheduleSourceType,
  type ScheduleStatus,
} from "./types";

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `evt_${Date.now()}_${Math.random()}`);

function startOfDay(ts: number, timeZone = "Asia/Taipei"): number {
  const date = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return new Date(`${parts}T00:00:00+08:00`).getTime();
}

export function weekStart(ts: number, timeZone = "Asia/Taipei"): number {
  const start = startOfDay(ts, timeZone);
  const day = new Date(start).getUTCDay() || 7;
  return start - (day - 1) * 86400000;
}

export function isScheduleEventType(value: unknown): value is ScheduleEventType {
  return typeof value === "string" && (SCHEDULE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isScheduleStatus(value: unknown): value is ScheduleStatus {
  return typeof value === "string" && (SCHEDULE_STATUSES as readonly string[]).includes(value);
}

export function createScheduleEvent(input: {
  roomId: string;
  createdBy: string;
  title: string;
  startAt: number;
  description?: string;
  eventType?: ScheduleEventType;
  endAt?: number;
  allDay?: boolean;
  status?: ScheduleStatus;
  assigneeId?: string;
  assigneeName?: string;
  sourceType?: ScheduleSourceType;
  sourceId?: string;
  color?: string;
  timezone?: string;
  id?: string;
}): ScheduleEvent {
  const title = input.title.trim().slice(0, 240);
  if (!title) throw new Error("EMPTY_TITLE");
  const now = Date.now();
  const startAt = Number.isFinite(input.startAt) ? input.startAt : now;
  const endAt = input.endAt != null && Number.isFinite(input.endAt) ? input.endAt : undefined;
  if (endAt != null && endAt < startAt) throw new Error("END_BEFORE_START");
  return {
    id: input.id ?? uid(),
    roomId: input.roomId,
    createdBy: input.createdBy,
    title,
    description: (input.description ?? "").slice(0, 2000),
    eventType: input.eventType && isScheduleEventType(input.eventType) ? input.eventType : "activity",
    startAt,
    endAt,
    timezone: input.timezone ?? "Asia/Taipei",
    allDay: input.allDay !== false,
    status: input.status && isScheduleStatus(input.status) ? input.status : "open",
    assigneeId: input.assigneeId,
    assigneeName: input.assigneeName ?? "",
    sourceType: input.sourceType && (SCHEDULE_SOURCE_TYPES as readonly string[]).includes(input.sourceType)
      ? input.sourceType
      : undefined,
    sourceId: input.sourceId,
    color: input.color ?? "#c45c4a",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function patchScheduleEvent(event: ScheduleEvent, patch: Partial<Pick<ScheduleEvent, "title" | "description" | "startAt" | "endAt" | "status" | "assigneeName" | "eventType" | "allDay">>): ScheduleEvent {
  const next = {
    ...event,
    ...patch,
    title: patch.title != null ? patch.title.trim().slice(0, 240) : event.title,
    updatedAt: Date.now(),
    version: event.version + 1,
  };
  if (!next.title) throw new Error("EMPTY_TITLE");
  if (next.endAt != null && next.endAt < next.startAt) throw new Error("END_BEFORE_START");
  return next;
}

export function deleteScheduleEvent(events: ScheduleEvent[], id: string): ScheduleEvent[] {
  return events.filter((item) => item.id !== id);
}

export function eventsInRange(events: ScheduleEvent[], range: ScheduleRange, now = Date.now(), timeZone = "Asia/Taipei"): ScheduleEvent[] {
  if (range === "list" || range === "timeline") {
    return [...events].sort((a, b) => a.startAt - b.startAt);
  }
  const start = range === "today" ? startOfDay(now, timeZone) : weekStart(now, timeZone);
  const end = range === "today" ? start + 86400000 : start + 7 * 86400000;
  return events
    .filter((item) => {
      const stop = item.endAt ?? item.startAt;
      return item.startAt < end && stop >= start;
    })
    .sort((a, b) => a.startAt - b.startAt);
}

export type AgendaDay = { dayStart: number; label: string; events: ScheduleEvent[] };

export function agendaDays(events: ScheduleEvent[], now = Date.now(), timeZone = "Asia/Taipei"): AgendaDay[] {
  const start = weekStart(now, timeZone);
  const days: AgendaDay[] = [];
  for (let i = 0; i < 7; i += 1) {
    const dayStart = start + i * 86400000;
    const dayEnd = dayStart + 86400000;
    const label = new Intl.DateTimeFormat("zh-Hant", { timeZone, weekday: "short", month: "numeric", day: "numeric" }).format(new Date(dayStart));
    days.push({
      dayStart,
      label,
      events: events.filter((item) => {
        const stop = item.endAt ?? item.startAt;
        return item.startAt < dayEnd && stop >= dayStart;
      }).sort((a, b) => a.startAt - b.startAt),
    });
  }
  return days;
}

export function eventTypeLabel(type: ScheduleEventType): string {
  return EVENT_TYPE_LABEL[type];
}

export function moveEventToDay(event: ScheduleEvent, dayStart: number): ScheduleEvent {
  const duration = (event.endAt ?? event.startAt) - event.startAt;
  return patchScheduleEvent(event, { startAt: dayStart, endAt: duration > 0 ? dayStart + duration : undefined });
}
