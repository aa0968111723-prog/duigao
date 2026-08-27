import type { RoomRole } from "../../cloud/roomRepository";
import type { BoardPermission, Whiteboard } from "./types";

export function boardPermission(role: RoomRole | null, allowBoardEdit: boolean, board?: Whiteboard | null): BoardPermission {
  if (role === "owner" || role === "editor") return "collaborate";
  if (allowBoardEdit || board?.allowEdit) return "collaborate";
  return "view";
}

export function canEditBoard(role: RoomRole | null, allowBoardEdit: boolean, board?: Whiteboard | null): boolean {
  if (board?.archivedAt) return false;
  return boardPermission(role, allowBoardEdit, board) === "collaborate";
}

/** Creating / archiving a whole board is an owner/editor power. Reviewers never get it by default. */
export function canManageBoards(role: RoomRole | null, localRoom: boolean): boolean {
  if (localRoom && !role) return true;
  return role === "owner" || role === "editor";
}

export function canParticipateInDiscussion(role: RoomRole | null, localRoom: boolean): boolean {
  if (localRoom) return true;
  return role === "owner" || role === "editor" || role === "reviewer";
}

export function canFinalizeDecision(role: RoomRole | null, localRoom: boolean): boolean {
  return canManageBoards(role, localRoom);
}

export function canToggleOpenEdit(role: RoomRole | null, localRoom: boolean): boolean {
  if (localRoom && !role) return true;
  return role === "owner";
}
