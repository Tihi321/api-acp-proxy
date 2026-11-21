// Pure history logic of the playground (no DOM, no storage): migration, sections, ordering, pinning, trimming. Nothing here mutates its input.

export interface ChatLike { id: string; title: string; updated: number; pinned?: boolean; order?: number; messages: Array<{ role: string; content: string }> }
export type DateGroup = "today" | "yesterday" | "week" | "older";
export interface Section { key: "pinned" | DateGroup; label: string; ids: string[] }

const LABELS: Record<Section["key"], string> = { pinned: "Pinned", today: "Today", yesterday: "Yesterday", week: "Previous 7 days", older: "Older" };
const GROUPS: DateGroup[] = ["today", "yesterday", "week", "older"];

const orderOf = (chat: ChatLike): number => (typeof chat.order === "number" && Number.isFinite(chat.order) ? chat.order : 0);
const maxOrder = (chats: readonly ChatLike[]): number => chats.reduce((max, chat) => Math.max(max, orderOf(chat)), 0);

/** Keeps the entries that have an array `messages`; `pinned` defaults to false; a missing or non-finite `order` becomes `length - index` so the visible order of an old (most recent first) array is kept. */
export function normalizeChats<T extends ChatLike>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const length = raw.length;
  const out: T[] = [];
  raw.forEach((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || !Array.isArray((entry as { messages?: unknown }).messages)) return;
    const chat = entry as T;
    const order = typeof chat.order === "number" && Number.isFinite(chat.order) ? chat.order : length - index;
    out.push({ ...chat, pinned: chat.pinned === true, order });
  });
  return out;
}

/** Which date bucket `updated` falls in, by local calendar days: same day = today, 1 = yesterday, 2 to 7 = week, more = older (a time in the future counts as today). */
export function dateGroup(updated: number, now: number): DateGroup {
  const a = new Date(updated), b = new Date(now);
  const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days <= 7 ? "week" : "older";
}

/** The ids of a section's chats, by `order` descending (ties keep the array order). */
function sectionIds(chats: readonly ChatLike[], key: Section["key"], now: number): string[] {
  return chats
    .map((chat, index) => ({ chat, index }))
    .filter(({ chat }) => (key === "pinned" ? chat.pinned === true : chat.pinned !== true && dateGroup(chat.updated, now) === key))
    .sort((x, y) => orderOf(y.chat) - orderOf(x.chat) || x.index - y.index)
    .map(({ chat }) => chat.id);
}

/** Pinned first, then Today, Yesterday, Previous 7 days, Older; empty sections are left out. The query (trimmed, case-insensitive) matches the title or any message content. */
export function historySections(chats: readonly ChatLike[], now: number, query = ""): Section[] {
  const needle = query.trim().toLowerCase();
  const shown = needle ? chats.filter((chat) => chat.title.toLowerCase().includes(needle) || chat.messages.some((m) => m.content.toLowerCase().includes(needle))) : chats;
  const keys: Array<Section["key"]> = ["pinned", ...GROUPS];
  return keys.map((key) => ({ key, label: LABELS[key], ids: sectionIds(shown, key, now) })).filter((section) => section.ids.length > 0);
}

/** Activity in a chat: `updated = now`; an unpinned chat also gets `order = max + 1` (top of Today), a pinned chat keeps its place. */
export function touchChat<T extends ChatLike>(chats: readonly T[], id: string, now: number): T[] {
  const top = maxOrder(chats) + 1;
  return chats.map((chat) => (chat.id === id ? { ...chat, updated: now, ...(chat.pinned === true ? {} : { order: top }) } : chat));
}

/** Pins (to the top of Pinned) or unpins (to the top of the bucket of its own `updated`). */
export function setPinned<T extends ChatLike>(chats: readonly T[], id: string, pinned: boolean, now: number): T[] {
  void now; // the target bucket follows from `updated`; `order = max + 1` is the top of any section
  const top = maxOrder(chats) + 1;
  return chats.map((chat) => (chat.id === id ? { ...chat, pinned, order: top } : chat));
}

/**
 * Moves a chat to a section. `target.index` is the position it has in that section's list afterwards (clamped). Only the target section is renumbered.
 * An unpinned chat can go to Pinned (it is pinned there) or stay in its own date bucket; any other date bucket is forbidden and returns the input unchanged.
 * A pinned chat dropped on a date bucket is unpinned and lands at the top of the bucket of its own `updated` (`index` ignored).
 */
export function moveChat<T extends ChatLike>(chats: readonly T[], id: string, target: { section: Section["key"]; index: number }, now: number): T[] {
  const chat = chats.find((entry) => entry.id === id);
  if (!chat) return [...chats];
  if (target.section !== "pinned") {
    if (chat.pinned === true) return setPinned(chats, id, false, now);
    if (dateGroup(chat.updated, now) !== target.section) return [...chats];
  }
  const ids = sectionIds(chats, target.section, now).filter((other) => other !== id);
  ids.splice(clamp(target.index, 0, ids.length), 0, id);
  const rank = new Map(ids.map((other, position) => [other, ids.length - position]));
  return chats.map((entry) => {
    const next = rank.get(entry.id);
    if (next === undefined) return entry;
    return entry.id === id && target.section === "pinned" ? { ...entry, pinned: true, order: next } : { ...entry, order: next };
  });
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }

/** Keeps every pinned chat plus the newest unpinned chats (by `updated`) until `max` in total (the pinned ones are not limited); the array order is kept. */
export function trimChats<T extends ChatLike>(chats: readonly T[], max = 50): T[] {
  const pinned = chats.filter((chat) => chat.pinned === true).length;
  const room = Math.max(0, max - pinned);
  const keep = new Set(chats.filter((chat) => chat.pinned !== true).map((chat, index) => ({ chat, index })).sort((x, y) => y.chat.updated - x.chat.updated || x.index - y.index).slice(0, room).map(({ chat }) => chat));
  return chats.filter((chat) => chat.pinned === true || keep.has(chat));
}
