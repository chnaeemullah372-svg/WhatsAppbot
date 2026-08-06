import { eq, and, sql, desc, asc, count, isNull } from "drizzle-orm";
import { createHash } from "crypto";
import {
  db,
  waChatsTable,
  waMessagesTable,
  waCallLogsTable,
  waAccountsTable,
  appLogsTable,
  adminUsersTable,
  type WaChat,
} from "@workspace/db";
import { multiWA, type HydrateChat, type WAChatMsg, type WACall } from "./multiWhatsapp";

/**
 * The whole app is built around ONE panel user. We pin every WhatsApp session
 * to this fixed id so the single user always drives the same Baileys engine.
 */
export const PANEL_USER_ID = 1;

let started = false;

/** ANTI-DELETE timing safety: ids seen as deleted-for-everyone BEFORE their
 *  original message was persisted. Any later-arriving original with one of these
 *  ids is written as already-deleted, so a revoke can never "lose" to an
 *  out-of-order original (e.g. during history sync). */
const pendingDeletes = new Set<string>();

/** Append a line to the application log table (best-effort, never throws). */
export async function logEvent(message: string, level = "info", source = "system") {
  try {
    await db.insert(appLogsTable).values({ message, level, source });
  } catch (err) {
    console.error("[log] failed to persist log:", err);
  }
}

/** Persist a single message + upsert its chat row. Best-effort.
 *  When `history` is true the message came from a WhatsApp history sync, so we
 *  never bump the unread counter (those messages are old) and only advance the
 *  chat's last-message preview when this message is actually newer. */
async function persistMessage(jid: string, phone: string, msg: WAChatMsg, history = false, name?: string) {
  if (process.env.WA_DEBUG_PROTO === "1") console.log("[WA DEBUG] persistMessage CALLED jid=" + jid + " id=" + msg.id + " fromMe=" + msg.fromMe + " history=" + history);
  try {
    // The WhatsApp number that is currently linked — every chat we capture is
    // tagged with it so the admin can browse each connected number separately.
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    // PER-NUMBER ISOLATION: account_phone is part of the primary/unique key now,
    // so we can never persist without knowing which number captured the message.
    // Capture only happens while a number is connected, so a null here means we
    // briefly lost the session — skip rather than risk an unkeyed/cross-number row.
    if (!accountPhone) {
      if (process.env.WA_DEBUG_PROTO === "1") console.log("[WA DEBUG] persist SKIPPED (no connected account) jid=" + jid + " id=" + msg.id);
      return;
    }
    // If a revoke for this id arrived before the original, honour it now.
    const isDeleted = (msg.deleted ?? false) || pendingDeletes.has(msg.id);
    await db
      .insert(waMessagesTable)
      .values({
        waMessageId: msg.id,
        jid,
        text: msg.text,
        fromMe: msg.fromMe,
        ts: msg.ts,
        status: msg.status,
        deleted: isDeleted,
        deletedAt: isDeleted ? new Date() : null,
        quotedText: msg.quotedText,
        quotedId: msg.quotedId,
        quotedSender: msg.quotedSender,
        quotedKind: msg.quotedKind,
        media: msg.media,
        mediaMime: msg.mediaMime,
        mediaKind: msg.mediaKind,
        fileName: msg.fileName,
        participant: msg.participant ?? null,
        accountPhone,
      })
      .onConflictDoUpdate({
        target: [waMessagesTable.accountPhone, waMessagesTable.waMessageId],
        // ANTI-DELETE: once a message is flagged deleted we KEEP the original
        // text + media (don't overwrite). Otherwise refresh the text (e.g. an
        // old row saved as "Media" before the envelope-unwrap fix) and backfill
        // media when a re-seen row finally downloaded its payload.
        set: {
          text: sql`CASE WHEN ${waMessagesTable.deleted} OR ${isDeleted} THEN ${waMessagesTable.text} ELSE ${msg.text} END`,
          deleted: sql`${waMessagesTable.deleted} OR ${isDeleted}`,
          deletedAt: sql`COALESCE(${waMessagesTable.deletedAt}, ${isDeleted ? new Date() : null})`,
          quotedText: msg.quotedText,
          quotedId: msg.quotedId,
          quotedSender: sql`COALESCE(${waMessagesTable.quotedSender}, ${msg.quotedSender ?? null})`,
          quotedKind: sql`COALESCE(${waMessagesTable.quotedKind}, ${msg.quotedKind ?? null})`,
          media: sql`COALESCE(${waMessagesTable.media}, ${msg.media ?? null})`,
          mediaMime: sql`COALESCE(${waMessagesTable.mediaMime}, ${msg.mediaMime ?? null})`,
          mediaKind: sql`COALESCE(${waMessagesTable.mediaKind}, ${msg.mediaKind ?? null})`,
          fileName: sql`COALESCE(${waMessagesTable.fileName}, ${msg.fileName ?? null})`,
          participant: sql`COALESCE(${waMessagesTable.participant}, ${msg.participant ?? null})`,
          // accountPhone is part of the conflict key now — it never changes on
          // update, so it is intentionally not in the SET list.
        },
      });

    await db
      .insert(waChatsTable)
      .values({
        jid,
        phone,
        name: name ?? null,
        lastMsg: msg.text,
        lastMsgTs: msg.ts,
        unread: 0,
        accountPhone,
      })
      .onConflictDoUpdate({
        target: [waChatsTable.accountPhone, waChatsTable.jid],
        set: {
          // Only move the preview forward for newer messages (history syncs can
          // arrive out of order).
          lastMsg: sql`CASE WHEN ${msg.ts} >= ${waChatsTable.lastMsgTs} THEN ${msg.text} ELSE ${waChatsTable.lastMsg} END`,
          lastMsgTs: sql`GREATEST(${waChatsTable.lastMsgTs}, ${msg.ts})`,
          // Fill in / refresh the readable chat title when we learn it.
          name: sql`COALESCE(${name ?? null}, ${waChatsTable.name})`,
          // accountPhone is part of the conflict key now (each connected number
          // owns its OWN chat row for a contact), so it never migrates between
          // numbers and is intentionally not in the SET list.
          unread:
            history || msg.fromMe
              ? sql`${waChatsTable.unread}`
              : sql`${waChatsTable.unread} + 1`,
          updatedAt: new Date(),
        },
      });
    if (process.env.WA_DEBUG_PROTO === "1") console.log("[WA DEBUG] persisted-OK jid=" + jid + " id=" + msg.id + " fromMe=" + msg.fromMe);
  } catch (err) {
    console.error("[WA DEBUG] persist FAILED jid=" + jid + " id=" + msg.id + ":", err);
  }
}

/**
 * Record (or refresh) a connected WhatsApp number in the account registry.
 * Called whenever a session reaches the "connected" state with a phone number.
 */
export async function recordAccount(phone: string) {
  try {
    await db
      .insert(waAccountsTable)
      .values({ phone })
      .onConflictDoUpdate({
        target: waAccountsTable.phone,
        set: {
          lastConnectedAt: new Date(),
          connectCount: sql`${waAccountsTable.connectCount} + 1`,
        },
      });
  } catch (err) {
    console.error("[persist] failed to record account:", err);
  }
}

/** All connected numbers + how many chats belong to each. */
export async function getAccounts() {
  const accounts = await db
    .select()
    .from(waAccountsTable)
    .orderBy(desc(waAccountsTable.lastConnectedAt));
  const counts = await db
    .select({ accountPhone: waChatsTable.accountPhone, value: count() })
    .from(waChatsTable)
    .groupBy(waChatsTable.accountPhone);
  const byPhone = new Map(counts.map((c) => [c.accountPhone, Number(c.value)]));
  return accounts.map((a) => ({ ...a, chatCount: byPhone.get(a.phone) ?? 0 }));
}

/** Update the delivery/read status of a stored message. */
async function persistStatus(waMessageId: string, status: number) {
  try {
    // Status (ticks) only ever concerns the live number's OWN messages, so scope
    // the update to the connected account — a message id is unique per account.
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    const where = accountPhone
      ? and(eq(waMessagesTable.waMessageId, waMessageId), eq(waMessagesTable.accountPhone, accountPhone))
      : eq(waMessagesTable.waMessageId, waMessageId);
    await db.update(waMessagesTable).set({ status }).where(where);
  } catch (err) {
    console.error("[persist] failed to update status:", err);
  }
}

/** Mark a chat's unread counter back to zero (when the user opens it). Scoped to
 *  the connected number so it only touches THAT number's copy of the chat. */
export async function clearUnread(jid: string, accountPhone: string) {
  try {
    await db
      .update(waChatsTable)
      .set({ unread: 0 })
      .where(and(eq(waChatsTable.jid, jid), eq(waChatsTable.accountPhone, accountPhone)));
  } catch (err) {
    console.error("[persist] failed to clear unread:", err);
  }
}

/** Flag a stored message as deleted-for-everyone WITHOUT losing its content.
 *  ANTI-DELETE: the original text + media stay on the server for monitoring;
 *  we only set the flag + the time it was deleted. */
export async function markDeleted(waMessageId: string) {
  // Remember it even if the row isn't stored yet, so an out-of-order original
  // (e.g. arriving later via history sync) is written as already-deleted.
  pendingDeletes.add(waMessageId);
  try {
    // A revoke always concerns the live number's view of the chat — scope the
    // flag to the connected account so it only touches that number's copy.
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    const where = accountPhone
      ? and(eq(waMessagesTable.waMessageId, waMessageId), eq(waMessagesTable.accountPhone, accountPhone))
      : eq(waMessagesTable.waMessageId, waMessageId);
    await db
      .update(waMessagesTable)
      .set({ deleted: true, deletedAt: new Date() })
      .where(where);
  } catch (err) {
    console.error("[persist] failed to mark deleted:", err);
  }
}

/** Local "delete for me": soft-hide a single message from the panel view only.
 *  The stored row + any anti-delete record are preserved; we just stamp WHEN it
 *  was hidden so getChatMessagesDb stops returning it. */
export async function hideMessage(waMessageId: string, accountPhone: string) {
  try {
    await db
      .update(waMessagesTable)
      .set({ hiddenAt: new Date() })
      .where(and(eq(waMessagesTable.waMessageId, waMessageId), eq(waMessagesTable.accountPhone, accountPhone)));
  } catch (err) {
    console.error("[persist] failed to hide message:", err);
  }
}

/** Read ONE connected number's chat history from DB, shaped for the engine's
 *  hydrate(). Scoped to accountPhone so the in-memory store only ever mirrors the
 *  number that is currently connected — never another number's chats. */
export async function loadHistory(accountPhone: string): Promise<HydrateChat[]> {
  const chats = await db
    .select()
    .from(waChatsTable)
    .where(eq(waChatsTable.accountPhone, accountPhone))
    .orderBy(desc(waChatsTable.lastMsgTs));

  const result: HydrateChat[] = [];
  for (const c of chats) {
    // Load message METADATA only — never the heavy base64 `media` blob. The
    // in-memory store is used for dedup/lastMsg/ticks, never to serve media
    // (clients fetch bytes lazily via /media/:id). Selecting `media` here would
    // pull the entire media history (often >1GB) into RAM on startup.
    const msgs = await db
      .select({
        waMessageId: waMessagesTable.waMessageId,
        text: waMessagesTable.text,
        fromMe: waMessagesTable.fromMe,
        ts: waMessagesTable.ts,
        status: waMessagesTable.status,
        deleted: waMessagesTable.deleted,
        quotedText: waMessagesTable.quotedText,
        quotedId: waMessagesTable.quotedId,
        quotedSender: waMessagesTable.quotedSender,
        quotedKind: waMessagesTable.quotedKind,
        mediaMime: waMessagesTable.mediaMime,
        mediaKind: waMessagesTable.mediaKind,
        fileName: waMessagesTable.fileName,
      })
      .from(waMessagesTable)
      .where(and(eq(waMessagesTable.jid, c.jid), eq(waMessagesTable.accountPhone, accountPhone)))
      .orderBy(asc(waMessagesTable.ts))
      .limit(300);
    result.push({
      meta: {
        jid: c.jid,
        phone: c.phone,
        name: c.name ?? undefined,
        lastMsg: c.lastMsg,
        lastMsgTs: c.lastMsgTs,
        unread: c.unread,
      },
      msgs: msgs.map((m) => ({
        id: m.waMessageId,
        text: m.text,
        fromMe: m.fromMe,
        ts: m.ts,
        status: m.status,
        deleted: m.deleted,
        quotedText: m.quotedText ?? undefined,
        quotedId: m.quotedId ?? undefined,
        quotedSender: m.quotedSender ?? undefined,
        quotedKind: m.quotedKind ?? undefined,
        mediaMime: m.mediaMime ?? undefined,
        mediaKind: m.mediaKind ?? undefined,
        fileName: m.fileName ?? undefined,
      })),
    });
  }
  return result;
}

/** All chats (for admin overview), optionally filtered to one connected number.
 *  The heavy base64 `avatarMedia` column is intentionally EXCLUDED — clients
 *  fetch each picture on demand via the avatar endpoint using `hasAvatar`. */
export async function getAllChats(accountPhone?: string) {
  const cols = {
    jid: waChatsTable.jid,
    phone: waChatsTable.phone,
    name: waChatsTable.name,
    savedName: waChatsTable.savedName,
    lastMsg: waChatsTable.lastMsg,
    lastMsgTs: waChatsTable.lastMsgTs,
    unread: waChatsTable.unread,
    accountPhone: waChatsTable.accountPhone,
    updatedAt: waChatsTable.updatedAt,
    hasAvatar: sql<boolean>`${waChatsTable.avatarMedia} IS NOT NULL`,
  };
  const q = db.select(cols).from(waChatsTable);
  if (accountPhone) {
    return q.where(eq(waChatsTable.accountPhone, accountPhone)).orderBy(desc(waChatsTable.lastMsgTs));
  }
  return q.orderBy(desc(waChatsTable.lastMsgTs));
}

/** Persist a contact's address-book (saved) name. Only updates existing chat
 *  rows; a contact with no messages yet has no row, and the engine keeps the
 *  name in memory until a message creates one. Saved name also drives display. */
export async function saveContactName(jid: string, savedName: string) {
  try {
    // A saved (address-book) name is MY phonebook's name for the contact, so it is
    // per-connected-number — scope the write to the live account so one number's
    // saved name can't appear under another number's copy of the same chat.
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    const where = accountPhone
      ? and(eq(waChatsTable.jid, jid), eq(waChatsTable.accountPhone, accountPhone))
      : eq(waChatsTable.jid, jid);
    await db.update(waChatsTable)
      .set({ savedName, name: savedName, updatedAt: new Date() })
      .where(where);
  } catch (err) {
    console.error("[persist] saveContactName failed:", err);
  }
}

/** Every known saved name, so the engine can keep saved names taking precedence
 *  over pushName after a restart (Baileys may not re-sync the full contact list
 *  on a reconnect from saved creds). */
export async function loadSavedNames(): Promise<Array<{ jid: string; savedName: string }>> {
  try {
    const rows = await db
      .select({ jid: waChatsTable.jid, savedName: waChatsTable.savedName })
      .from(waChatsTable)
      .where(sql`${waChatsTable.savedName} IS NOT NULL`);
    return rows.filter((r): r is { jid: string; savedName: string } => !!r.savedName);
  } catch (err) {
    console.error("[persist] loadSavedNames failed:", err);
    return [];
  }
}

/** Cache a freshly downloaded profile picture. */
export async function saveAvatar(jid: string, avatarMedia: string, avatarMime: string) {
  try {
    await db.update(waChatsTable)
      .set({ avatarMedia, avatarMime, avatarFetchedAt: new Date(), avatarErrorAt: null, updatedAt: new Date() })
      .where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] saveAvatar failed:", err);
  }
}

/** Record a failed profile-picture fetch (no photo / private) so we don't retry
 *  it on every request — throttled by avatarErrorAt. */
export async function markAvatarError(jid: string) {
  try {
    await db.update(waChatsTable).set({ avatarErrorAt: new Date() }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] markAvatarError failed:", err);
  }
}

/** Avatar bytes for serving over HTTP. */
export async function getAvatarBytes(jid: string): Promise<{ avatarMedia: string | null; avatarMime: string | null } | null> {
  try {
    const [row] = await db
      .select({ avatarMedia: waChatsTable.avatarMedia, avatarMime: waChatsTable.avatarMime })
      .from(waChatsTable)
      .where(eq(waChatsTable.jid, jid))
      .limit(1);
    return row ?? null;
  } catch (err) {
    console.error("[persist] getAvatarBytes failed:", err);
    return null;
  }
}

// ---- Lazy profile-picture fetching (rate-limited, TTL-throttled) ------------
const AVATAR_TTL_OK = 24 * 60 * 60 * 1000; // re-check a fetched avatar after 24h
const AVATAR_TTL_ERR = 60 * 60 * 1000;     // re-try a missing/private one after 1h
const AVATAR_MAX_BYTES = 1_500_000;
const AVATAR_CONCURRENCY = 2;
const avatarInFlight = new Set<string>();
const avatarQueue: string[] = [];
let avatarActive = 0;

/** Request a profile-picture (re)fetch for a jid. No-ops when fresh/in-flight.
 *  Globally rate-limited so a full inbox doesn't hammer WhatsApp at once. */
export function queueAvatar(jid: string) {
  if (!jid || avatarInFlight.has(jid) || avatarQueue.includes(jid)) return;
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@g.us")) return;
  avatarQueue.push(jid);
  pumpAvatars();
}
function pumpAvatars() {
  while (avatarActive < AVATAR_CONCURRENCY && avatarQueue.length) {
    const jid = avatarQueue.shift()!;
    avatarActive++;
    void ensureAvatar(jid).finally(() => { avatarActive--; pumpAvatars(); });
  }
}
async function ensureAvatar(jid: string) {
  if (avatarInFlight.has(jid)) return;
  const fresh = await getAvatarFreshness(jid);
  const now = Date.now();
  if (fresh) {
    if (fresh.hasAvatar && fresh.fetchedAt && now - fresh.fetchedAt.getTime() < AVATAR_TTL_OK) return;
    if (fresh.errorAt && now - fresh.errorAt.getTime() < AVATAR_TTL_ERR) return;
  }
  avatarInFlight.add(jid);
  try {
    // profilePictureUrl is a covert read query — it never broadcasts our presence
    // and never sends a read receipt. Throws / returns null when no visible photo.
    const url = await multiWA.getProfilePictureUrl(PANEL_USER_ID, jid);
    if (!url) { await markAvatarError(jid); return; }
    const resp = await fetch(url);
    if (!resp.ok) { await markAvatarError(jid); return; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > AVATAR_MAX_BYTES) { await markAvatarError(jid); return; }
    const mime = resp.headers.get("content-type") || "image/jpeg";
    await saveAvatar(jid, buf.toString("base64"), mime);
  } catch {
    await markAvatarError(jid);
  } finally {
    avatarInFlight.delete(jid);
  }
}

/** Avatar freshness metadata so we can decide whether to (re)fetch. */
async function getAvatarFreshness(jid: string): Promise<{ hasAvatar: boolean; fetchedAt: Date | null; errorAt: Date | null } | null> {
  try {
    const [row] = await db
      .select({
        hasAvatar: sql<boolean>`${waChatsTable.avatarMedia} IS NOT NULL`,
        fetchedAt: waChatsTable.avatarFetchedAt,
        errorAt: waChatsTable.avatarErrorAt,
      })
      .from(waChatsTable)
      .where(eq(waChatsTable.jid, jid))
      .limit(1);
    return row ?? null;
  } catch (err) {
    console.error("[persist] getAvatarFreshness failed:", err);
    return null;
  }
}

/** All messages for a chat (from DB — survives restart). The heavy base64
 *  `media` column is intentionally excluded; clients fetch each payload on
 *  demand via the media endpoint using `hasMedia`/`mediaKind`. */
export async function getChatMessagesDb(jid: string, accountPhone?: string) {
  const base = accountPhone
    ? and(eq(waMessagesTable.jid, jid), eq(waMessagesTable.accountPhone, accountPhone))
    : eq(waMessagesTable.jid, jid);
  // Skip messages the admin locally "deleted for me" (soft-hidden).
  const where = and(base, isNull(waMessagesTable.hiddenAt));
  const rows = await db
    .select({
      id: waMessagesTable.id,
      waMessageId: waMessagesTable.waMessageId,
      jid: waMessagesTable.jid,
      text: waMessagesTable.text,
      fromMe: waMessagesTable.fromMe,
      ts: waMessagesTable.ts,
      status: waMessagesTable.status,
      deleted: waMessagesTable.deleted,
      deletedAt: waMessagesTable.deletedAt,
      quotedText: waMessagesTable.quotedText,
      quotedId: waMessagesTable.quotedId,
      quotedSender: waMessagesTable.quotedSender,
      quotedKind: waMessagesTable.quotedKind,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    .where(where)
    .orderBy(asc(waMessagesTable.ts));
  return rows;
}

/** Fetch a single message's media payload (base64) for the serve endpoint. When
 *  `accountPhone` is given the lookup is scoped to that linked number, so the
 *  USER panel can never fetch an OLD number's media by guessing a message id
 *  (the admin panel calls this WITHOUT a filter to serve ALL media). */
export async function getMediaById(waMessageId: string, accountPhone?: string) {
  const where = accountPhone
    ? and(eq(waMessagesTable.waMessageId, waMessageId), eq(waMessagesTable.accountPhone, accountPhone))
    : eq(waMessagesTable.waMessageId, waMessageId);
  const [row] = await db
    .select({
      media: waMessagesTable.media,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
    })
    .from(waMessagesTable)
    .where(where)
    .limit(1);
  return row ?? null;
}

// ── Calls + Status ──────────────────────────────────────────────────

/** Persist (upsert) a WhatsApp call-log entry. Events for the same call share a
 *  callId (offer → terminal state), so we upsert and never let a late/duplicate
 *  ringing event downgrade a terminal outcome (missed/rejected/accepted). */
export async function saveCallLog(call: WACall) {
  try {
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    await db
      .insert(waCallLogsTable)
      .values({
        callId: call.callId,
        jid: call.jid,
        phone: call.phone,
        name: call.name ?? null,
        accountPhone,
        outgoing: call.outgoing,
        isVideo: call.isVideo,
        isGroup: call.isGroup,
        outcome: call.outcome,
        rawStatus: call.rawStatus,
        ts: call.ts,
        durationSec: call.durationSec ?? null,
      })
      .onConflictDoUpdate({
        target: waCallLogsTable.callId,
        set: {
          outcome: sql`CASE WHEN ${waCallLogsTable.outcome} IN ('missed','rejected','accepted') THEN ${waCallLogsTable.outcome} ELSE ${call.outcome} END`,
          rawStatus: call.rawStatus,
          name: sql`COALESCE(${waCallLogsTable.name}, ${call.name ?? null})`,
          isVideo: call.isVideo,
          // Fill the duration once we learn it (arrives on terminate, after the
          // earlier offer/accept rows); keep an existing value otherwise.
          durationSec: sql`COALESCE(${call.durationSec ?? null}, ${waCallLogsTable.durationSec})`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error("[persist] failed to persist call log:", err);
  }
}

/** Recent call log, newest first. Optionally scoped to one connected account. */
export async function getCallLogs(limit = 200, accountPhone?: string) {
  const q = db.select().from(waCallLogsTable);
  if (accountPhone) {
    return q.where(eq(waCallLogsTable.accountPhone, accountPhone)).orderBy(desc(waCallLogsTable.ts)).limit(limit);
  }
  return q.orderBy(desc(waCallLogsTable.ts)).limit(limit);
}

/** Status (stories) grouped by the contact who posted them. WhatsApp stores all
 *  statuses under status@broadcast; we group by the captured poster JID and
 *  resolve a display name from the chat registry. */
export async function getStatusGroups(accountPhone?: string) {
  const where = accountPhone
    ? and(eq(waMessagesTable.jid, "status@broadcast"), eq(waMessagesTable.accountPhone, accountPhone))
    : eq(waMessagesTable.jid, "status@broadcast");
  const rows = await db
    .select({
      waMessageId: waMessagesTable.waMessageId,
      participant: waMessagesTable.participant,
      text: waMessagesTable.text,
      ts: waMessagesTable.ts,
      deleted: waMessagesTable.deleted,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    .where(where)
    .orderBy(desc(waMessagesTable.ts));

  // Resolve poster display names from the chat registry. Prefer the SAME connected
  // number's saved names when scoped, so a poster shows under the name THIS number
  // has for them — never a name only another number's phonebook knows.
  const chats = accountPhone
    ? await db
        .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name })
        .from(waChatsTable)
        .where(eq(waChatsTable.accountPhone, accountPhone))
    : await db
        .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name })
        .from(waChatsTable);
  const nameByJid = new Map(chats.map((c) => [c.jid, c.name]));
  const nameByPhone = new Map(chats.map((c) => [c.phone, c.name]));

  type StatusItem = {
    waMessageId: string;
    text: string;
    ts: number;
    deleted: boolean;
    mediaMime: string | null;
    mediaKind: string | null;
    fileName: string | null;
    hasMedia: boolean;
  };
  type StatusGroup = {
    participant: string;
    phone: string;
    name: string | null;
    latestTs: number;
    count: number;
    items: StatusItem[];
  };

  const groups = new Map<string, StatusGroup>();
  for (const r of rows) {
    // Skip revoked (deleted-for-everyone) statuses so a group's count matches
    // what the viewer can actually show; groups left empty are never created.
    if (r.deleted) continue;
    const pj = r.participant ?? "unknown";
    const phone = pj.includes("@") ? pj.split("@")[0].split(":")[0] : "";
    let g = groups.get(pj);
    if (!g) {
      const name =
        nameByJid.get(pj) ??
        (phone ? nameByPhone.get(phone) ?? null : null) ??
        null;
      g = { participant: pj, phone, name, latestTs: r.ts, count: 0, items: [] };
      groups.set(pj, g);
    }
    g.count++;
    if (r.ts > g.latestTs) g.latestTs = r.ts;
    g.items.push({
      waMessageId: r.waMessageId,
      text: r.text,
      ts: r.ts,
      deleted: r.deleted,
      mediaMime: r.mediaMime,
      mediaKind: r.mediaKind,
      fileName: r.fileName,
      hasMedia: r.hasMedia,
    });
  }
  return [...groups.values()].sort((a, b) => b.latestTs - a.latestTs);
}

/**
 * Ensure at least one admin account exists so the admin panel is usable.
 * Self-hosted personal tool: seeds from ADMIN_USERNAME/ADMIN_PASSWORD env vars,
 * or falls back to admin / admin123 (logged so the owner can change it).
 */
async function seedDefaultAdmin() {
  try {
    const admins = await db.select().from(adminUsersTable).limit(1);
    if (admins.length) return;
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin123";
    await db
      .insert(adminUsersTable)
      .values({ username, passwordHash: createHash("sha256").update(password).digest("hex") } as any)
      .onConflictDoNothing();
    console.log(`[seed] created default admin "${username}" — change the password after first login`);
    await logEvent(`Default admin account "${username}" created`, "warn", "auth");
  } catch (err) {
    console.error("[seed] failed to seed admin:", err);
  }
}

/**
 * Wire engine → DB and load saved history into the engine. Idempotent.
 */
export async function startPersistence() {
  if (started) return;
  started = true;

  await seedDefaultAdmin();

  multiWA.addPersistListener((_uid, jid, phone, msg, history, name) => {
    void persistMessage(jid, phone, msg, history, name);
  });
  // Persist saved (address-book) contact names as WhatsApp syncs them.
  multiWA.addContactNameListener((_uid, jid, savedName) => {
    void saveContactName(jid, savedName);
  });
  multiWA.addStatusListener((_uid, update) => {
    void persistStatus(update.waMessageId, update.status);
  });
  // ANTI-DELETE: when WhatsApp revokes a message (deleted for everyone), flag it
  // in the DB but keep the original content for monitoring.
  multiWA.addDeleteListener((_uid, waMessageId) => {
    void markDeleted(waMessageId);
  });
  // Calls log: persist every call notification (incoming / missed / rejected).
  multiWA.addCallListener((_uid, call) => {
    void saveCallLog(call);
  });
  // Per-account registry: record every number that reaches the connected state.
  multiWA.addGlobalListener((state) => {
    if (state.status === "connected" && state.phoneNumber) {
      void recordAccount(state.phoneNumber);
    }
  });

  // PER-NUMBER ISOLATION: we no longer hydrate at startup. At boot no number is
  // connected yet, so loading "all chats" would mix numbers in memory. Instead we
  // register a provider the engine calls on every successful connect to load ONLY
  // the connected number's history into the in-memory store (see the open handler
  // in multiWhatsapp.ts). Memory therefore always mirrors exactly the live number.
  multiWA.setHydrateProvider((accountPhone) => loadHistory(accountPhone));

  // Seed saved contact names so they keep precedence over pushName even before
  // WhatsApp re-syncs contacts after a reconnect from saved creds.
  try {
    const saved = await loadSavedNames();
    if (saved.length) {
      multiWA.seedSavedNames(PANEL_USER_ID, saved);
      console.log(`[persist] seeded ${saved.length} saved contact names`);
    }
  } catch (err) {
    console.error("[persist] failed to seed saved names:", err);
  }

  await logEvent("Persistence started; engine wired to DB", "info", "system");
}
