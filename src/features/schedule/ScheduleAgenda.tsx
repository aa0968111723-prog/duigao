import { useMemo, useRef, useState } from "react";
import { ModalSheet } from "../../components/BottomSheet";
import {
  agendaDays,
  createScheduleEvent,
  eventTypeLabel,
  eventsInRange,
  moveEventToDay,
  patchScheduleEvent,
} from "./events";
import { sourceOpenTarget } from "./links";
import type { ScheduleEvent, ScheduleEventType, ScheduleRange } from "./types";
import { EVENT_TYPE_LABEL, STATUS_LABEL } from "./types";
import "./schedule.css";

export type ScheduleAgendaApi = {
  roomId: string;
  userId: string;
  canWrite: boolean;
  events: ScheduleEvent[];
  splitWith?: "chat" | "board" | null;
  onSplitWith?: (pane: "chat" | "board") => void;
  onUpsert: (event: ScheduleEvent) => void;
  onDelete: (id: string) => void;
  onOpenSource: (event: ScheduleEvent) => void;
};

const DRAFT_TYPES: ScheduleEventType[] = ["activity", "deadline", "task", "copy_due"];

function dayInputValue(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

function parseDayInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return Date.now();
  return new Date(`${value}T00:00:00+08:00`).getTime();
}

export function ScheduleAgenda({ api }: { api: ScheduleAgendaApi }) {
  const [range, setRange] = useState<ScheduleRange>("today");
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const [editing, setEditing] = useState<ScheduleEvent | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [eventType, setEventType] = useState<ScheduleEventType>("activity");
  const [dayStart, setDayStart] = useState(() => Date.now());
  const [timelineOpen, setTimelineOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const visible = useMemo(() => eventsInRange(api.events, range === "today" ? "week" : range), [api.events, range]);
  const days = useMemo(() => agendaDays(api.events), [api.events]);
  const sheetEvents = pickedDay == null ? [] : days.find((day) => day.dayStart === pickedDay)?.events ?? [];

  const openDraft = (day: number, type: ScheduleEventType = "activity") => {
    setDayStart(day);
    setEventType(type);
    setTitle("");
    setDraftOpen(true);
  };

  return (
    <section className={`sched ${api.splitWith ? `is-split is-split-${api.splitWith}` : ""}`} data-testid="schedule-agenda">
      <header className="sched-head">
        <p className="sched-kicker">專案時程</p>
        <h2>今日／本週</h2>
        <nav className="sched-ranges" aria-label="時程範圍">
          {(["today", "week", "list"] as const).map((item) => (
            <button key={item} type="button" className={range === item ? "is-active" : ""} onClick={() => setRange(item)}>
              {item === "today" ? "今日" : item === "week" ? "本週" : "列表"}
            </button>
          ))}
          <button type="button" className={timelineOpen ? "is-active" : ""} data-testid="schedule-timeline-toggle" onClick={() => setTimelineOpen((open) => !open)}>
            時間軸
          </button>
        </nav>
        {api.onSplitWith && (
          <nav className="sched-split-toggle" aria-label="分割檢視" data-testid="schedule-split-toggle">
            <button type="button" className={api.splitWith === "chat" ? "is-active" : ""} onClick={() => api.onSplitWith?.("chat")}>對話＋日曆</button>
            <button type="button" className={api.splitWith === "board" ? "is-active" : ""} onClick={() => api.onSplitWith?.("board")}>白板＋日曆</button>
          </nav>
        )}
      </header>
      <ol className="sched-days">
        {days.map((day) => (
          <li
            key={day.dayStart}
            data-testid="schedule-day-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/schedule-event");
              const current = api.events.find((item) => item.id === id);
              if (current && api.canWrite) api.onUpsert(moveEventToDay(current, day.dayStart));
            }}
          >
            <button type="button" className="sched-day" data-testid="schedule-day" onClick={() => setPickedDay(day.dayStart)}>
              <strong>{day.label}</strong>
              <span>{day.events.length ? `${day.events.length} 件事` : "沒有行程"}</span>
            </button>
            {(range === "today" || range === "week" || timelineOpen) && day.events.slice(0, timelineOpen ? 12 : 3).map((event) => (
              <button
                key={event.id}
                type="button"
                className="sched-card"
                data-testid="schedule-event"
                draggable={api.canWrite}
                onDragStart={(ev) => ev.dataTransfer.setData("text/schedule-event", event.id)}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  api.onOpenSource(event);
                }}
                onPointerDown={() => {
                  if (!api.canWrite) return;
                  suppressClick.current = false;
                  if (pressTimer.current) window.clearTimeout(pressTimer.current);
                  pressTimer.current = window.setTimeout(() => {
                    suppressClick.current = true;
                    setEditing(event);
                    pressTimer.current = null;
                  }, 480);
                }}
                onPointerUp={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
                onPointerCancel={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
              >
                <b>{event.title}</b>
                <small>{eventTypeLabel(event.eventType)} · {STATUS_LABEL[event.status]}{event.assigneeName ? ` · ${event.assigneeName}` : ""}</small>
              </button>
            ))}
          </li>
        ))}
      </ol>
      {range === "list" && !timelineOpen && (
        <ol className="sched-list">
          {visible.map((event) => (
            <li key={event.id}>
              <button type="button" className="sched-card" onClick={() => api.onOpenSource(event)}>
                <b>{event.title}</b>
                <small>{eventTypeLabel(event.eventType)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      {api.canWrite && (
        <button type="button" className="sched-add" data-testid="schedule-add" onClick={() => openDraft(Date.now(), "activity")}>＋ 新增活動或截止日期</button>
      )}
      {pickedDay != null && (
        <ModalSheet onClose={() => setPickedDay(null)} title="這天的行程">
          <div className="sched-sheet" data-testid="schedule-day-sheet">
            {sheetEvents.length ? sheetEvents.map((event) => (
              <div key={event.id} className="sched-sheet-row">
                <button type="button" className="sched-card" onClick={() => { api.onOpenSource(event); setPickedDay(null); }}>
                  <b>{event.title}</b>
                  <small>{sourceOpenTarget(event).surface === "none" ? "沒有來源連結" : "打開來源"}</small>
                </button>
                {api.canWrite && (
                  <button type="button" data-testid="schedule-edit" onClick={() => { setEditing(event); setPickedDay(null); }}>編輯</button>
                )}
              </div>
            )) : <p>這天還沒有行程。</p>}
            {api.canWrite && (
              <button type="button" onClick={() => { openDraft(pickedDay, "deadline"); setPickedDay(null); }}>在這天新增</button>
            )}
          </div>
        </ModalSheet>
      )}
      {draftOpen && (
        <ModalSheet onClose={() => setDraftOpen(false)} title="加入時程">
          <form
            className="sched-draft"
            data-testid="schedule-draft"
            onSubmit={(event) => {
              event.preventDefault();
              api.onUpsert(createScheduleEvent({
                roomId: api.roomId,
                createdBy: api.userId,
                title,
                startAt: dayStart,
                eventType,
              }));
              setTitle("");
              setDraftOpen(false);
            }}
          >
            <label>標題<input value={title} onChange={(ev) => setTitle(ev.target.value)} required minLength={1} /></label>
            <label>類型
              <select value={eventType} onChange={(ev) => setEventType(ev.target.value as ScheduleEventType)} data-testid="schedule-type">
                {DRAFT_TYPES.map((type) => <option key={type} value={type}>{EVENT_TYPE_LABEL[type]}</option>)}
              </select>
            </label>
            <label>日期
              <input type="date" value={dayInputValue(dayStart)} onChange={(ev) => setDayStart(parseDayInput(ev.target.value))} />
            </label>
            <button type="submit">保存</button>
          </form>
        </ModalSheet>
      )}
      {editing && (
        <ModalSheet onClose={() => setEditing(null)} title="編輯時程">
          <form
            className="sched-draft"
            data-testid="schedule-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const nextTitle = String(new FormData(form).get("title") ?? editing.title);
              const nextDay = parseDayInput(String(new FormData(form).get("day") ?? dayInputValue(editing.startAt)));
              const nextType = String(new FormData(form).get("type") ?? editing.eventType) as ScheduleEventType;
              api.onUpsert(patchScheduleEvent(editing, { title: nextTitle, startAt: nextDay, eventType: nextType }));
              setEditing(null);
            }}
          >
            <label>標題<input name="title" defaultValue={editing.title} required minLength={1} /></label>
            <label>類型
              <select name="type" defaultValue={editing.eventType}>
                {DRAFT_TYPES.map((type) => <option key={type} value={type}>{EVENT_TYPE_LABEL[type]}</option>)}
              </select>
            </label>
            <label>日期<input type="date" name="day" defaultValue={dayInputValue(editing.startAt)} /></label>
            <button type="submit">保存</button>
            <button
              type="button"
              className="sched-delete"
              data-testid="schedule-delete"
              onClick={() => { api.onDelete(editing.id); setEditing(null); }}
            >刪除</button>
          </form>
        </ModalSheet>
      )}
    </section>
  );
}
