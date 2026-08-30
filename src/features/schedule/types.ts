/** 專案時程事件。任務截止日期與活動時間共用此形狀，不另建 task store。 */

export const SCHEDULE_EVENT_TYPES = [
  "deadline",
  "activity",
  "plan_stage",
  "video_milestone",
  "copy_due",
  "board_due",
  "task",
  "decision",
] as const;
export type ScheduleEventType = (typeof SCHEDULE_EVENT_TYPES)[number];

export const SCHEDULE_STATUSES = ["open", "doing", "done", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_SOURCE_TYPES = [
  "discussion",
  "whiteboard_node",
  "task",
  "decision",
  "branch",
  "version",
  "manual",
  "ai_proposal",
] as const;
export type ScheduleSourceType = (typeof SCHEDULE_SOURCE_TYPES)[number];

export type ScheduleEvent = {
  id: string;
  roomId: string;
  createdBy: string;
  title: string;
  description: string;
  eventType: ScheduleEventType;
  startAt: number;
  endAt?: number;
  timezone: string;
  allDay: boolean;
  status: ScheduleStatus;
  assigneeId?: string;
  assigneeName: string;
  sourceType?: ScheduleSourceType;
  sourceId?: string;
  color: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleRange = "today" | "week" | "list" | "timeline";

export const EVENT_TYPE_LABEL: Record<ScheduleEventType, string> = {
  deadline: "截止日期",
  activity: "活動時間",
  plan_stage: "企劃階段",
  video_milestone: "影片製作節點",
  copy_due: "文宣交稿",
  board_due: "白板節點期限",
  task: "任務",
  decision: "決策期限",
};

export const STATUS_LABEL: Record<ScheduleStatus, string> = {
  open: "未開始",
  doing: "進行中",
  done: "完成",
  cancelled: "取消",
};
