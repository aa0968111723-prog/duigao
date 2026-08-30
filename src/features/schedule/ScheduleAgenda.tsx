import { useMemo, useState } from "react";
import { ModalSheet } from "../../components/BottomSheet";
import { agendaDays, createScheduleEvent, eventTypeLabel, eventsInRange, moveEventToDay, patchScheduleEvent } from "./events";
import { sourceOpenTarget } from "./links";
import type { ScheduleEvent, ScheduleRange } from "./types";
import { STATUS_LABEL } from "./types";
import "./schedule.css";

export type ScheduleAgendaApi = {
  roomId: string;
  userId: string;
  canWrite: boolean;
  events: ScheduleEvent[];
  splitWith?: "chat" | "board" | null;
  onUpsert: (event: ScheduleEvent) => void;
  onDelete: (id: string) => void;
  onOpenSource: (event: ScheduleEvent) => void;
};

export function ScheduleAgenda({ api }: { api: ScheduleAgendaApi }) {
  const [range, setRange] = useState<ScheduleRange>("today");
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dayStart, setDayStart] = useState(() => Date.now());
  const visible = useMemo(() => eventsInRange(api.events, range === "today" ? "week" : range), [api.events, range]);
  const days = useMemo(() => agendaDays(api.events), [api.events]);
  const sheetEvents = pickedDay == null ? [] : days.find((day) => day.dayStart === pickedDay)?.events ?? [];

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
        </nav>
      </header>
      <ol className="sched-days">
        {days.map((day) => (
          <li key={day.dayStart}>
            <button type="button" className="sched-day" data-testid="schedule-day" onClick={() => setPickedDay(day.dayStart)}>
              <strong>{day.label}</strong>
              <span>{day.events.length ? `${day.events.length} 件事` : "沒有行程"}</span>
            </button>
            {(range === "today" || range === "week") && day.events.slice(0, 3).map((event) => (
              <button
                key={event.id}
                type="button"
                className="sched-card"
                data-testid="schedule-event"
                onClick={() => api.onOpenSource(event)}
                onContextMenu={(ev) => { ev.preventDefault(); api.onUpsert(moveEventToDay(event, day.dayStart + 86400000)); }}
              >
                <b>{event.title}</b>
                <small>{eventTypeLabel(event.eventType)} · {STATUS_LABEL[event.status]}{event.assigneeName ? ` · ${event.assigneeName}` : ""}</small>
              </button>
            ))}
          </li>
        ))}
      </ol>
      {range === "list" && (
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
        <button type="button" className="sched-add" data-testid="schedule-add" onClick={() => setDraftOpen(true)}>＋ 新增活動或截止日期</button>
      )}
      {pickedDay != null && (
        <ModalSheet onClose={() => setPickedDay(null)} title="這天的行程">
          <div className="sched-sheet" data-testid="schedule-day-sheet">
            {sheetEvents.length ? sheetEvents.map((event) => (
              <button key={event.id} type="button" className="sched-card" onClick={() => { api.onOpenSource(event); setPickedDay(null); }}>
                <b>{event.title}</b>
                <small>{sourceOpenTarget(event).surface === "none" ? "沒有來源連結" : "打開來源"}</small>
              </button>
            )) : <p>這天還沒有行程。</p>}
            {api.canWrite && (
              <button type="button" onClick={() => { setDayStart(pickedDay); setDraftOpen(true); }}>在這天新增</button>
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
              api.onUpsert(createScheduleEvent({ roomId: api.roomId, createdBy: api.userId, title, startAt: dayStart, eventType: "activity" }));
              setTitle("");
              setDraftOpen(false);
            }}
          >
            <label>標題<input value={title} onChange={(ev) => setTitle(ev.target.value)} required minLength={1} /></label>
            <button type="submit">保存</button>
          </form>
        </ModalSheet>
      )}
    </section>
  );
}

void patchScheduleEvent;
