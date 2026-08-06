import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
  type WASocket,
  type ConnectionState,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_BASE = path.join(__dirname, "../../.user-sessions");

const silentLogger = pino({ level: "silent" });
// When WA_DEBUG_PROTO=1, surface Baileys' OWN warn/error logs ("failed to decrypt
// message", session / Bad-MAC errors, retry-receipt activity) so we can see the
// REAL reason a live message arrives with no content. Baileys never logs message
// plaintext, so this stays metadata-only. Fully silent in normal production.
const waLogger = process.env.WA_DEBUG_PROTO === "1" ? pino({ level: "warn" }) : silentLogger;

let cachedVersion: [number, number, number] | null = null;
async function getWAVersion(): Promise<[number, number, number]> {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    return version;
  } catch {
    return [2, 2413, 51];
  }
}

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected";

export interface UserWAState {
  userId: number;
  status: WAStatus;
  qr: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface WAChatMsg {
  id: string;
  text: string;
  fromMe: boolean;
  ts: number;
  status: number; // 0=pending, 1=sent, 2=delivered, 3=read, 4=played
  deleted?: boolean;
  quotedText?: string;
  quotedId?: string;
  /** Display label of the quoted message's original sender ("You" / contact name
   *  / phone) and the quoted message's media kind, so a reply renders WhatsApp-
   *  style (accent bar + sender + "Photo"/"Voice message"). */
  quotedSender?: string;
  quotedKind?: string;
  media?: string; // base64-encoded media payload (downloaded photos/voice/etc.)
  mediaMime?: string;
  mediaKind?: string; // image | video | audio | sticker | document
  fileName?: string;
  /** JID of the actual poster/sender — set for status@broadcast (stories) and
   *  group messages, so Status updates can be grouped by poster. */
  participant?: string;
}

/** Normalize a phone number to international digits-only form for pairing.
 *  Accepts local formats (e.g. 0300-1234567 → 923001234567) and already-
 *  international ones (+92…, 0092…, 92…). Defaults a leading 0 to Pakistan. */
export function normalizePhone(input: string): string {
  let d = (input || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // 0092… → 92…
  else if (d.startsWith("0")) d = "92" + d.slice(1); // 0300… → 92300…
  return d;
}

/** Cap base64 media we keep in the DB so a huge video can't bloat a row.
 *  25 MB covers the vast majority of WhatsApp photos/voice notes/videos. */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024; // 25 MB raw

/** Format a duration in seconds as "M:SS" (or "H:MM:SS" for long calls). */
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

/** Download a media message to base64. Re-uploads expired media via the socket
 *  so even older history photos can usually be fetched. Never throws. */
async function downloadMediaBase64(msg: any, sock: WASocket): Promise<string | null> {
  try {
    const buffer: any = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: silentLogger as any, reuploadRequest: sock.updateMediaMessage },
    );
    if (!buffer || buffer.length === 0) return null;
    if (buffer.length > MEDIA_MAX_BYTES) {
      if (process.env.WA_DEBUG_PROTO === "1") console.log(`[wa-media] skip oversize ${buffer.length} bytes`);
      return null;
    }
    return Buffer.from(buffer).toString("base64");
  } catch (err) {
    if (process.env.WA_DEBUG_PROTO === "1") {
      console.log("[wa-media] download failed:", (err as any)?.message ?? String(err));
    }
    return null;
  }
}

/** Global media-download concurrency limiter. When a contact sends a BURST of
 *  media (e.g. 50 photos at once), firing 50 parallel downloads saturates the
 *  single WhatsApp media connection and every stream fails ("Failed to fetch
 *  stream") — which is exactly why view-once/photo capture "worked yesterday
 *  (a few pics) but not today (many at once)". Cap how many downloads run at the
 *  same moment; the rest queue and run as slots free up, so each gets a healthy
 *  slice of the socket and succeeds. */
const MEDIA_CONCURRENCY = 3;   // total simultaneous downloads sharing the WA socket
const HISTORY_MAX = 1;         // at most ONE of those may be a low-priority backfill
let mediaActive = 0;
let historyActive = 0;
// Two lanes: LIVE (incoming / view-once — one-shot, must win the socket) and
// HISTORY (bulk backfill from a history sync — can wait). Live waiters are ALWAYS
// served first, and history is capped (HISTORY_MAX) so a sync burst can never
// starve a live view-once capture happening at the same moment.
const liveWaiters: Array<() => void> = [];
const historyWaiters: Array<() => void> = [];
function pumpMedia(): void {
  while (mediaActive < MEDIA_CONCURRENCY && liveWaiters.length) {
    mediaActive++; liveWaiters.shift()!();
  }
  while (mediaActive < MEDIA_CONCURRENCY && historyActive < HISTORY_MAX && historyWaiters.length) {
    mediaActive++; historyActive++; historyWaiters.shift()!();
  }
}
function acquireMediaSlot(history = false): Promise<void> {
  return new Promise<void>((resolve) => {
    (history ? historyWaiters : liveWaiters).push(resolve);
    pumpMedia();
  });
}
function releaseMediaSlot(history = false): void {
  mediaActive--;
  if (history) historyActive--;
  pumpMedia();
}

/** View-once / fresh media occasionally isn't decryptable on the very FIRST
 *  attempt (keys still settling, or a brief media-reupload race). Retry a couple
 *  of times with a short backoff before giving up — there is only ever ONE copy
 *  of a view-once item, so a transient miss must not lose it. Runs inside the
 *  global concurrency limiter so a burst of media can't congest the socket and
 *  fail every download. Never throws. */
async function downloadMediaWithRetry(msg: any, sock: WASocket, attempts = 4, history = false): Promise<string | null> {
  await acquireMediaSlot(history);
  try {
    for (let i = 0; i < attempts; i++) {
      const b64 = await downloadMediaBase64(msg, sock);
      if (b64) return b64;
      // Tight early backoff (keys often settle within ~1s); a view-once item has
      // only ONE copy so we retry quickly rather than waiting it out.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return null;
  } finally {
    releaseMediaSlot(history);
  }
}

export interface WAChat {
  jid: string;
  phone: string;
  name?: string;
  lastMsg: string;
  lastMsgTs: number;
  unread: number;
}

export interface IncomingWAMsg {
  waMessageId: string;
  text: string;
  ts: number;
  quotedWaId?: string;
  quotedText?: string;
}
export interface StatusUpdate {
  waMessageId: string;
  jid: string;
  status: number; // 1=sent, 2=delivered, 3=read, 4=played
}

type Listener = (state: UserWAState) => void;
type MsgListener = (userId: number, senderPhone: string, msg: IncomingWAMsg) => void;
type StatusListener = (userId: number, update: StatusUpdate) => void;
/** Fired for EVERY new message (incoming + outgoing) so it can be persisted to DB.
 * `history` is true when the message comes from a WhatsApp history sync (so the
 * persister knows not to bump unread counters for old messages). */
type PersistListener = (userId: number, jid: string, phone: string, msg: WAChatMsg, history?: boolean, name?: string) => void;
type ContactNameListener = (userId: number, jid: string, savedName: string) => void;
/** Fired when a message is deleted-for-everyone, so the DB can flag it while
 *  keeping the original content (anti-delete monitoring). */
type DeleteListener = (userId: number, waMessageId: string) => void;

/** A WhatsApp call notification captured from a linked device. A linked device
 *  receives only call NOTIFICATIONS (offer + terminal state), so the talk
 *  duration of a call answered on the phone is generally unavailable. */
export interface WACall {
  callId: string;
  jid: string;
  phone: string;
  name?: string;
  isVideo: boolean;
  isGroup: boolean;
  outgoing: boolean;
  rawStatus: string;
  outcome: "incoming" | "missed" | "rejected" | "accepted" | "ongoing" | "unknown";
  ts: number;
  /** Best-effort talk duration (seconds). Only set when BOTH an accept and a
   *  later terminate notification reach this linked device — usually unavailable
   *  for calls answered on the phone, so it stays undefined. */
  durationSec?: number;
}
/** Fired for every WhatsApp call notification so the DB can log it. */
type CallListener = (userId: number, call: WACall) => void;

/** A contact's presence (online/offline/typing) captured AFTER we explicitly
 *  presenceSubscribe to a chat. Covert-safe: subscribing only requests updates,
 *  it never makes the monitored account appear online or send read receipts. */
export interface WAPresence {
  jid: string;
  /** available | unavailable | composing | recording | paused */
  presence: string;
  /** Unix ms — only when WhatsApp shares "last seen" (usually on going offline). */
  lastSeen?: number;
}
type PresenceListener = (userId: number, p: WAPresence) => void;

export interface HydrateChat {
  meta: WAChat;
  msgs: WAChatMsg[];
}

class UserSession {
  private sock: WASocket | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pairingRequested = false;
  private pairingPhone: string | null = null;
  private brandCode: string | null = null;
  private didPair = false;
  // One-shot guard: a `badSession` (500) close is often a transient bad-MAC (e.g.
  // during call signaling), NOT a real logout. We try ONE reconnect with the saved
  // creds before wiping the link, so a blip doesn't force the user to re-scan a QR.
  // Reset to false on a clean `open`.
  private badSessionRetried = false;
  public state: UserWAState;
  private listeners: Set<Listener> = new Set();
  private msgListeners: Set<MsgListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private persistListeners: Set<PersistListener> = new Set();
  private deleteListeners: Set<DeleteListener> = new Set();
  private callListeners: Set<CallListener> = new Set();
  private presenceListeners: Set<PresenceListener> = new Set();
  private contactNameListeners: Set<ContactNameListener> = new Set();
  /** Address-book (saved) names — take precedence over pushName for display. */
  private savedNames = new Map<string, string>();
  /** In-memory contact presence: canonical PN jid -> last-known presence. Filled
   *  by 'presence.update' AFTER we presenceSubscribe a chat. Never persisted. */
  private presence = new Map<string, { presence: string; lastSeen?: number; at: number }>();
  private chatStore = new Map<string, { meta: WAChat; msgs: WAChatMsg[] }>();
  /** Group jids whose subject (title) we've already fetched, so we don't refetch. */
  private groupNamesFetched = new Set<string>();
  /** WhatsApp now addresses many 1:1 chats by an opaque LID ("<id>@lid") instead
   *  of the phone number ("<pn>@s.whatsapp.net"). Map LID→PN so incoming (LID)
   *  and outgoing (PN) land in the SAME thread. Filled from the message key's
   *  `remoteJidAlt` and, as a fallback, the Baileys lid-mapping store. */
  private lidToPn = new Map<string, string>();

  // Last-known outcome per callId, so a late offer/ringing event can never
  // DOWNGRADE the in-chat call bubble from a terminal state (missed/answered)
  // back to "Incoming…". Call handling is also serialized via `callQueue`.
  private callOutcomes = new Map<string, string>();
  private callQueue: Promise<void> = Promise.resolve();
  // Best-effort call timing: callId -> accepted timestamp (ms). Lets us compute a
  // talk duration IF a later terminate notification also reaches this linked
  // device (most answered-on-phone calls never deliver one, so duration stays
  // unknown). Bounded to avoid unbounded growth.
  private callAccepted = new Map<string, number>();
  // First-seen timestamp per callId. The call is shown as ONE in-place bubble; we
  // pin it to when the call STARTED so later accept/terminate events don't make it
  // jump to the bottom of the conversation.
  private callFirstTs = new Map<string, number>();
  // The last WhatsApp number that successfully linked. Persists across reconnects
  // (state.phoneNumber is cleared on close), so a NUMBER SWITCH is still detected
  // on the next "open" even if a disconnect happened in between.
  private lastLinkedPhone: string | null = null;
  // PER-NUMBER ISOLATION: on every successful connect we reload ONLY the connected
  // number's saved history into the in-memory store. The provider (wired by the
  // persistence layer) returns that number's chats from the DB. Stored here so the
  // engine has no direct dependency on the DB module.
  private hydrateProvider: ((accountPhone: string) => Promise<HydrateChat[]>) | null = null;
  setHydrateProvider(fn: (accountPhone: string) => Promise<HydrateChat[]>) { this.hydrateProvider = fn; }

  addMsgListener(fn: MsgListener) { this.msgListeners.add(fn); return () => this.msgListeners.delete(fn); }
  addStatusListener(fn: StatusListener) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  addPersistListener(fn: PersistListener) { this.persistListeners.add(fn); return () => this.persistListeners.delete(fn); }
  addDeleteListener(fn: DeleteListener) { this.deleteListeners.add(fn); return () => this.deleteListeners.delete(fn); }
  addCallListener(fn: CallListener) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
  addPresenceListener(fn: PresenceListener) { this.presenceListeners.add(fn); return () => this.presenceListeners.delete(fn); }
  addContactNameListener(fn: ContactNameListener) { this.contactNameListeners.add(fn); return () => this.contactNameListeners.delete(fn); }
  private notifyPersist(jid: string, msg: WAChatMsg, history = false) {
    const phone = jid.split("@")[0];
    const name = this.chatStore.get(jid)?.meta.name;
    for (const fn of this.persistListeners) { try { fn(this.userId, jid, phone, msg, history, name); } catch {} }
  }
  private notifyDelete(waMessageId: string) {
    for (const fn of this.deleteListeners) { try { fn(this.userId, waMessageId); } catch {} }
  }
  private notifyCall(call: WACall) {
    for (const fn of this.callListeners) { try { fn(this.userId, call); } catch {} }
  }
  private notifyPresence(p: WAPresence) {
    for (const fn of this.presenceListeners) { try { fn(this.userId, p); } catch {} }
  }
  private notifyContactName(jid: string, savedName: string) {
    for (const fn of this.contactNameListeners) { try { fn(this.userId, jid, savedName); } catch {} }
  }
  /** Seed saved names loaded from DB so they keep precedence over pushName after
   *  a restart, and apply them to already-hydrated chats. */
  seedSavedNames(entries: Array<{ jid: string; savedName: string }>) {
    for (const { jid, savedName } of entries) {
      if (!savedName) continue;
      this.savedNames.set(jid, savedName);
      const entry = this.chatStore.get(jid);
      if (entry && entry.meta.name !== savedName) entry.meta.name = savedName;
    }
  }
  /** Covert read of a contact's profile-picture URL (never broadcasts presence
   *  and never sends a read receipt). Null when no visible photo / not linked. */
  async getProfilePictureUrl(jid: string): Promise<string | null> {
    if (!this.sock || this.state.status !== "connected") return null;
    try { return (await this.sock.profilePictureUrl(jid, "image")) ?? null; }
    catch { return null; }
  }
  /** Apply one synced contact: record its address-book name (1:1 only) so it
   *  takes precedence over pushName, update the live chat + persist. */
  private applyContact(c: any) {
    const jid = this.canonicalJid(String(c?.id ?? ""));
    if (!jid.endsWith("@s.whatsapp.net")) return; // 1:1 contacts only
    const saved = String(c?.name ?? c?.verifiedName ?? "").trim();
    if (!saved) return;
    this.savedNames.set(jid, saved);
    const entry = this.chatStore.get(jid);
    if (entry && entry.meta.name !== saved) {
      entry.meta.name = saved;
      const last = entry.msgs[entry.msgs.length - 1];
      if (last) this.notifyPersist(jid, last, true);
    }
    this.notifyContactName(jid, saved);
  }
  /** COVERT-SAFE presence: ONLY subscribe to a contact's presence. We never call
   *  sendPresenceUpdate, so the linked account never appears online/typing and no
   *  read receipts are emitted. Best-effort; safe to call repeatedly. */
  subscribePresence(jid: string) {
    try { void this.sock?.presenceSubscribe(this.canonicalJid(jid)); } catch {}
  }
  getPresence(jid: string): WAPresence | null {
    const key = this.canonicalJid(jid);
    const p = this.presence.get(key);
    return p ? { jid: key, presence: p.presence, lastSeen: p.lastSeen } : null;
  }
  /** Map a Baileys `call` event into a call-log entry. A linked device only
   *  receives call NOTIFICATIONS (an offer + a terminal state), not a full
   *  telephony record — so we record who/what/outcome, never a reliable talk
   *  duration. Outgoing calls placed from the phone are usually not delivered
   *  here at all; we still defensively detect them via our own number. */
  private async handleCall(c: any) {
    const callId: string = c?.id ?? `call-${Date.now()}`;
    const fromJid: string = c?.from ?? c?.chatId ?? "";
    if (!fromJid) return;
    const ownNum = (this.state.phoneNumber ?? "").replace(/\D/g, "");
    const fromNum = fromJid.split("@")[0].split(":")[0];
    const outgoing = !!ownNum && fromNum === ownNum;
    const counterpartRaw = outgoing ? (c?.chatId ?? fromJid) : fromJid;
    // WhatsApp now addresses 1:1 callers by their privacy LID (@lid). Resolve it
    // to the real phone number so the Calls log + the in-chat entry show the
    // actual contact instead of the opaque LID digits.
    const counterpartJid = await this.resolveLidToPnNow(counterpartRaw);
    const phone = (counterpartJid.split("@")[0] || "").split(":")[0];
    const rawStatus = String(c?.status ?? "");
    // Diagnostic (opt-in via WA_DEBUG_PROTO=1): log EVERY call event status so we
    // can see exactly which lifecycle events WhatsApp delivers to this linked
    // device — crucially whether "accept" and "terminate" arrive (needed to
    // compute talk duration). Metadata only, never any media/content.
    if (process.env.WA_DEBUG_PROTO === "1") {
      console.log("[wa-call] " + JSON.stringify({
        status: rawStatus, outgoing, from: fromJid, chatId: c?.chatId ?? null,
        ownNum, fromNum, isVideo: !!c?.isVideo, isGroup: !!c?.isGroup, id: callId,
      }));
    }
    let outcome: WACall["outcome"];
    switch (rawStatus) {
      case "offer":
      case "ringing": outcome = outgoing ? "ongoing" : "incoming"; break;
      case "timeout": outcome = "missed"; break;
      case "reject": outcome = "rejected"; break;
      case "accept": outcome = "accepted"; break;
      // A terminate AFTER we saw an accept means the answered call just ended.
      // A terminate WITHOUT a prior accept carries no outcome of its own, so it
      // maps to "unknown" (the downgrade guard below keeps any existing terminal
      // state intact).
      case "terminate": outcome = this.callAccepted.has(callId) ? "accepted" : "unknown"; break;
      default: outcome = "unknown";
    }
    const name =
      this.chatStore.get(counterpartJid)?.meta.name ??
      this.chatStore.get(`${phone}@s.whatsapp.net`)?.meta.name ??
      undefined;
    const ts = c?.date ? new Date(c.date).getTime() : Date.now();
    // Best-effort talk duration: remember WHEN a call was accepted, and when a
    // later "terminate" arrives compute the elapsed seconds. WhatsApp usually
    // does NOT deliver a terminate (or any duration) to a linked device, so this
    // stays undefined for most answered-on-phone calls — surfaced honestly.
    let durationSec: number | undefined;
    if (rawStatus === "accept") {
      if (!this.callAccepted.has(callId)) this.callAccepted.set(callId, ts);
      if (this.callAccepted.size > 1000) this.callAccepted.clear();
    } else if (rawStatus === "terminate") {
      const acc = this.callAccepted.get(callId);
      // Sanity-bound to 1s‒4h so a clock skew / stale entry can't log a bogus value.
      if (acc && ts > acc) {
        const d = Math.round((ts - acc) / 1000);
        if (d >= 1 && d <= 14400) durationSec = d;
      }
    }
    this.notifyCall({
      callId, jid: counterpartJid, phone, name,
      isVideo: !!c?.isVideo, isGroup: !!c?.isGroup, outgoing, rawStatus, outcome, ts, durationSec,
    });
    // A late offer/ringing event must never overwrite a terminal state already
    // recorded for this call (missed/rejected/accepted). Guard the in-chat bubble.
    const TERMINAL = new Set(["missed", "rejected", "accepted"]);
    const prevOutcome = this.callOutcomes.get(callId);
    const downgrade = !!prevOutcome && TERMINAL.has(prevOutcome) && !TERMINAL.has(outcome);
    if (!downgrade) this.callOutcomes.set(callId, outcome);
    if (this.callOutcomes.size > 1000) this.callOutcomes.clear();
    // IN-CHAT call entry (WhatsApp-style) — ONE in-place bubble per call, updated
    // as events arrive. We NEVER print a separate "call end": a linked/companion
    // device receives `accept`+`terminate` together at the MOMENT THE PHONE PICKS
    // UP, and never a real end event, so any "end" bubble would be a lie shown
    // while the call is still ongoing on the phone. We therefore surface only the
    // best-known state, and never fabricate an end (or a duration we can't observe).
    if (!c?.isGroup) {
      // NEUTRAL direction: on a companion device WhatsApp addresses every call by
      // the remote party's @lid and never delivers a reliable "this call was
      // outgoing" signal (the account's own phone number never matches the call's
      // `from`). Claiming "Incoming"/"Outgoing" was therefore wrong half the time,
      // so we drop the direction word and show the honest outcome only.
      const kind = c?.isVideo ? "video" : "voice";        // "Missed voice call"
      const Kind = c?.isVideo ? "Video" : "Voice";        // "Voice call · answered"
      // Effective outcome AFTER the downgrade guard above — callOutcomes holds the
      // best terminal/known state seen for this call so far.
      const eff = this.callOutcomes.get(callId) ?? outcome;
      // Pin the bubble to when the call STARTED so accept/terminate (which arrive
      // seconds later, at pickup) don't make it jump to the bottom of the chat.
      let bubbleTs = this.callFirstTs.get(callId);
      if (bubbleTs == null) { bubbleTs = ts; this.callFirstTs.set(callId, ts); }
      if (this.callFirstTs.size > 1000) this.callFirstTs.clear();
      const label =
        eff === "missed"   ? `📞 Missed ${kind} call` :
        eff === "rejected" ? `📞 ${Kind} call · declined` :
        eff === "accepted" ? `📞 ${Kind} call · answered${durationSec != null ? ` · ${fmtDur(durationSec)}` : ""}` :
                             `📞 ${Kind} call`;
      this.upsertMsg(counterpartJid, {
        id: `call:${callId}`, text: label, fromMe: false, ts: bubbleTs, status: 1,
        mediaKind: "call",
      }, label);
    }
  }

  /** Load a connected number's saved history into the in-memory store. Called on
   *  every successful connect (right after the store is cleared for the live
   *  number). MERGE-SAFE: if a live message slipped in during the brief async
   *  window before this ran, we keep it and only add historical messages it doesn't
   *  already have — nothing live is clobbered and nothing duplicates. */
  hydrate(chats: HydrateChat[]) {
    for (const c of chats) {
      const existing = this.chatStore.get(c.meta.jid);
      if (!existing) {
        this.chatStore.set(c.meta.jid, { meta: { ...c.meta }, msgs: [...c.msgs] });
        continue;
      }
      const haveIds = new Set(existing.msgs.map(m => m.id));
      const missing = c.msgs.filter(m => !haveIds.has(m.id));
      if (missing.length) existing.msgs = [...missing, ...existing.msgs].sort((a, b) => a.ts - b.ts);
      if (c.meta.lastMsgTs > existing.meta.lastMsgTs) {
        existing.meta.lastMsg = c.meta.lastMsg;
        existing.meta.lastMsgTs = c.meta.lastMsgTs;
      }
    }
  }
  private notifyMsg(senderPhone: string, msg: IncomingWAMsg) {
    for (const fn of this.msgListeners) { try { fn(this.userId, senderPhone, msg); } catch {} }
  }
  private notifyStatus(update: StatusUpdate) {
    for (const fn of this.statusListeners) { try { fn(this.userId, update); } catch {} }
  }

  getChatList(): WAChat[] {
    return [...this.chatStore.values()]
      .map(c => c.meta)
      .sort((a, b) => b.lastMsgTs - a.lastMsgTs);
  }

  getChatMessages(jid: string): WAChatMsg[] {
    return this.chatStore.get(jid)?.msgs ?? [];
  }

  markRead(jid: string) {
    const c = this.chatStore.get(jid);
    if (c) c.meta.unread = 0;
  }

  async sendToJid(jid: string, text: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    const result = await this.sock.sendMessage(jid, { text });
    const msgId = result?.key.id ?? `local-${Date.now()}`;
    this.upsertMsg(jid, { id: msgId, text, fromMe: true, ts: Date.now(), status: 1 }, text);
    return msgId;
  }

  async deleteForEveryone(jid: string, msgId: string, fromMe: boolean) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: msgId, fromMe, participant: fromMe ? undefined : jid },
    } as any);
    const entry = this.chatStore.get(jid);
    if (entry) {
      const m = entry.msgs.find(x => x.id === msgId);
      // ANTI-DELETE: flag it but keep the original text/media for monitoring.
      if (m) m.deleted = true;
    }
    this.notifyDelete(msgId);
  }

  /** Resolve a group's title (subject) once and store it on the chat so the list
   *  shows a readable name instead of the raw group id. Best-effort + async. */
  private ensureGroupName(jid: string) {
    if (!jid.endsWith("@g.us") || this.groupNamesFetched.has(jid)) return;
    const sock = this.sock;
    if (!sock) return;
    this.groupNamesFetched.add(jid);
    sock.groupMetadata(jid)
      .then((meta: any) => {
        const subject = meta?.subject;
        const entry = this.chatStore.get(jid);
        if (subject && entry) {
          entry.meta.name = subject;
          const last = entry.msgs[entry.msgs.length - 1];
          if (last) this.notifyPersist(jid, last, true);
        }
      })
      .catch(() => { this.groupNamesFetched.delete(jid); });
  }

  private upsertMsg(jid: string, m: WAChatMsg, display: string, history = false, nameHint?: string) {
    let entry = this.chatStore.get(jid);
    if (!entry) {
      const phone = jid.split("@")[0];
      entry = { meta: { jid, phone, lastMsg: "", lastMsgTs: 0, unread: 0 }, msgs: [] };
      this.chatStore.set(jid, entry);
    }
    // A saved (address-book) name always wins over a transient pushName.
    const bestName = this.savedNames.get(jid) ?? nameHint;
    if (bestName && entry.meta.name !== bestName) entry.meta.name = bestName;
    let added = false;
    let corrected = false;
    const existing = entry.msgs.find(x => x.id === m.id);
    if (!existing) {
      entry.msgs.push(m);
      if (entry.msgs.length > 300) entry.msgs.splice(0, entry.msgs.length - 300);
      entry.msgs.sort((a, b) => a.ts - b.ts);
      added = true;
    } else if ((!existing.deleted && existing.text !== m.text && m.text) || (m.media && !existing.media)) {
      // Same message re-seen with better text (e.g. an old row that was parsed
      // as "Media" before the envelope-unwrap fix) or now with downloaded media.
      // Text is corrected ONLY while the message is not deleted, so the original
      // pre-delete snapshot is preserved.
      if (!existing.deleted && m.text) {
        existing.text = m.text;
        existing.quotedText = m.quotedText;
        existing.quotedId = m.quotedId;
      }
      // ANTI-DELETE: media backfill is allowed EVEN on a deleted message. If a
      // sender deletes-for-everyone while the media download is still in flight,
      // we must still keep the bytes we captured — that is the whole point of the
      // covert panel. persistMessage keeps `deleted` via OR, so this never
      // un-deletes the row.
      if (m.media && !existing.media) {
        existing.media = m.media;
        existing.mediaMime = m.mediaMime;
        existing.mediaKind = m.mediaKind;
        existing.fileName = m.fileName;
      }
      corrected = true;
    }
    if (m.ts >= entry.meta.lastMsgTs) {
      entry.meta.lastMsg = display;
      entry.meta.lastMsgTs = m.ts;
    }
    // History messages are old — never inflate the unread badge with them.
    if (added && !m.fromMe && !history) entry.meta.unread++;
    if (added || corrected) this.notifyPersist(jid, m, history);
    // Keep the heavy base64 media OUT of the in-memory store. persistMessage has
    // already written it to the DB (above) and it's served lazily via /media/:id;
    // nothing reads it back from memory. Retaining it balloons RSS (every photo/
    // video held in RAM) on a swapless VPS — the cause of sluggish send/receive.
    // The metadata (mediaKind/mediaMime/fileName) stays so the UI knows media
    // exists and fetches it on demand.
    const stored = entry.msgs.find((x) => x.id === m.id);
    if (stored) stored.media = undefined;
  }

  /** Baileys wraps real content inside envelopes: outgoing messages sent from
   *  the phone arrive as `deviceSentMessage`, disappearing chats as
   *  `ephemeralMessage`, view-once as `viewOnceMessage*`, etc. Unwrap them so
   *  text extraction works (otherwise every message falls back to "Media"). */
  private unwrapMessage(message: any): any {
    // Use Baileys' own normalizer FIRST — it matches THIS library version and
    // strips every envelope variant (ephemeral, view-once, deviceSent,
    // documentWithCaption, edited, plus newer wrappers). The manual loop below
    // stays as a safety net in case a future wrapper slips through. This is the
    // fix for live media arriving as a generic "Media" label: the old hand-rolled
    // unwrap missed a wrapper that the live (messages.upsert) path uses.
    let m: any = message;
    try { m = normalizeMessageContent(message) ?? message; } catch { m = message; }
    for (let i = 0; i < 6 && m; i++) {
      const next =
        m.ephemeralMessage?.message ||
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m.viewOnceMessageV2Extension?.message ||
        m.deviceSentMessage?.message ||
        m.documentWithCaptionMessage?.message ||
        m.editedMessage?.message;
      if (!next) break;
      m = next;
    }
    return m;
  }

  /** Pull text + display label out of a Baileys proto message. Shared by the
   *  live `messages.upsert` and the `messaging-history.set` history sync. */
  /** Normalize a message's chat jid. WhatsApp may deliver a 1:1 incoming message
   *  addressed by LID ("<id>@lid") instead of the phone number. Map it to the PN
   *  jid ("<pn>@s.whatsapp.net") so it threads with outgoing — but NEVER drop it:
   *  if no mapping is known yet, keep the LID jid and resolve it in the
   *  background for next time. Groups (@g.us) and status are returned untouched. */
  /** Baileys getPNForLID()/remoteJidAlt can return a DEVICE-suffixed jid like
   *  "923000000000:0@s.whatsapp.net". Every chat key, participant and call jid
   *  elsewhere uses the bare "923000000000@s.whatsapp.net" form, so strip the
   *  ":device" part — otherwise a resolved contact lands in a duplicate thread. */
  private canonicalJid(jid: string): string {
    if (!jid) return jid;
    const at = jid.indexOf("@");
    if (at < 0) return jid;
    return jid.slice(0, at).split(":")[0] + jid.slice(at);
  }

  private resolveUserJid(msg: any): string {
    const jid: string = msg?.key?.remoteJid ?? "";
    if (!jid.endsWith("@lid")) return jid;
    const alt: string = msg?.key?.remoteJidAlt ?? "";
    if (alt.endsWith("@s.whatsapp.net")) { const c = this.canonicalJid(alt); this.lidToPn.set(jid, c); return c; }
    const cached = this.lidToPn.get(jid);
    if (cached) return cached;
    this.resolveLidPn(jid);
    return jid;
  }

  /** Background-resolve a LID→PN mapping via the Baileys signal store so later
   *  messages from the same contact thread under the phone number. */
  private resolveLidPn(lidJid: string): void {
    if (this.lidToPn.has(lidJid)) return;
    const store: any = (this.sock as any)?.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return;
    Promise.resolve(store.getPNForLID(lidJid))
      .then((pn: string | null) => {
        if (pn && pn.endsWith("@s.whatsapp.net")) {
          this.lidToPn.set(lidJid, this.canonicalJid(pn));
        }
      })
      .catch(() => {});
  }

  /** Awaited LID→PN resolution for one-shot events (calls) that don't carry a
   *  remoteJidAlt. Cache first, then the Baileys signal store. Falls back to the
   *  original jid when no mapping is known yet. */
  private async resolveLidToPnNow(jid: string): Promise<string> {
    if (!jid.endsWith("@lid")) return jid;
    const cached = this.lidToPn.get(jid);
    if (cached) return cached;
    const store: any = (this.sock as any)?.signalRepository?.lidMapping;
    if (store?.getPNForLID) {
      try {
        const pn = await store.getPNForLID(jid);
        if (pn && pn.endsWith("@s.whatsapp.net")) { const c = this.canonicalJid(pn); this.lidToPn.set(jid, c); return c; }
      } catch {}
    }
    return jid;
  }

  /** Resolve a status/group message's poster jid (key.participant) from LID to
   *  the real phone number, mirroring resolveUserJid — so the Status + Calls
   *  views show the actual contact instead of the opaque @lid digits. */
  private resolveParticipant(msg: any): string | undefined {
    const p: string = msg?.key?.participant ?? "";
    if (!p) return undefined;
    if (!p.endsWith("@lid")) return p;
    const alt: string = msg?.key?.participantAlt ?? msg?.key?.participantPn ?? "";
    if (alt.endsWith("@s.whatsapp.net")) { const c = this.canonicalJid(alt); this.lidToPn.set(p, c); return c; }
    const cached = this.lidToPn.get(p);
    if (cached) return cached;
    this.resolveLidPn(p);
    return p;
  }

  private parseWAMessage(msg: any): { jid: string; m: WAChatMsg; display: string; raw: any; nameHint?: string } | null {
    if (!msg?.message) return null;
    const jid = this.resolveUserJid(msg);
    // Show EVERYTHING: individual chats, groups and status/stories. Individual
    // chats may be addressed by phone number (@s.whatsapp.net) OR by WhatsApp's
    // privacy LID (@lid); accept both (LID is threaded under the PN above).
    const isUser = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
    const isGroup = jid.endsWith("@g.us");
    const isStatus = jid === "status@broadcast";
    if (!isUser && !isGroup && !isStatus) return null;
    const fromMe = msg.key?.fromMe ?? false;
    const msgId = msg.key?.id ?? `unknown-${Date.now()}`;
    const ts = ((msg.messageTimestamp as number) ?? 0) * 1000 || Date.now();
    const raw = this.unwrapMessage(msg.message);
    if (!raw) return null;
    const text =
      raw.conversation ||
      raw.extendedTextMessage?.text ||
      raw.imageMessage?.caption ||
      raw.videoMessage?.caption ||
      "";
    // Classify any attached media so the UI can render the real photo/voice/etc.
    let mediaKind: string | undefined;
    let mediaMime: string | undefined;
    let fileName: string | undefined;
    if (raw.imageMessage) { mediaKind = "image"; mediaMime = raw.imageMessage.mimetype || "image/jpeg"; }
    else if (raw.stickerMessage) { mediaKind = "sticker"; mediaMime = raw.stickerMessage.mimetype || "image/webp"; }
    else if (raw.videoMessage) { mediaKind = "video"; mediaMime = raw.videoMessage.mimetype || "video/mp4"; }
    else if (raw.audioMessage) { mediaKind = "audio"; mediaMime = raw.audioMessage.mimetype || "audio/ogg"; }
    else if (raw.documentMessage) {
      mediaKind = "document";
      mediaMime = raw.documentMessage.mimetype || "application/octet-stream";
      fileName = raw.documentMessage.fileName || undefined;
    }
    const display =
      text ||
      (mediaKind === "image" ? "📷 Photo" :
       mediaKind === "video" ? "📹 Video" :
       mediaKind === "audio" ? "🎵 Voice message" :
       mediaKind === "document" ? `📄 ${fileName ?? "Document"}` :
       mediaKind === "sticker" ? "🩷 Sticker" : "📎 Media");
    // Diagnostic (opt-in via WA_DEBUG_PROTO=1): capture the SHAPE of any message
    // we couldn't classify as text or known media, so unrecognized live envelopes
    // can be handled. Logs metadata ONLY — never message text, captions or media.
    if (process.env.WA_DEBUG_PROTO === "1" && !text && !mediaKind) {
      try {
        console.log("[wa-proto] unclassified " + JSON.stringify({
          jidType: isGroup ? "group" : isStatus ? "status" : "user",
          fromMe,
          topKeys: msg.message ? Object.keys(msg.message) : [],
          rawKeys: raw ? Object.keys(raw) : [],
          contentType: getContentType(raw),
        }));
      } catch {}
    }
    // A reply carries the quoted message inside contextInfo, which can hang off a
    // text reply (extendedTextMessage) OR a media reply (image/video/etc.). Look
    // across the known carriers so quoting works for every message type.
    const ctx =
      raw.extendedTextMessage?.contextInfo ||
      raw.imageMessage?.contextInfo ||
      raw.videoMessage?.contextInfo ||
      raw.audioMessage?.contextInfo ||
      raw.documentMessage?.contextInfo ||
      raw.stickerMessage?.contextInfo ||
      undefined;
    const quotedRaw = ctx?.quotedMessage ? this.unwrapMessage(ctx.quotedMessage) : undefined;
    let quotedText: string | undefined;
    let quotedKind: string | undefined;
    let quotedSender: string | undefined;
    if (quotedRaw) {
      if (quotedRaw.imageMessage) quotedKind = "image";
      else if (quotedRaw.stickerMessage) quotedKind = "sticker";
      else if (quotedRaw.videoMessage) quotedKind = "video";
      else if (quotedRaw.audioMessage) quotedKind = "audio";
      else if (quotedRaw.documentMessage) quotedKind = "document";
      quotedText =
        quotedRaw.conversation ||
        quotedRaw.extendedTextMessage?.text ||
        quotedRaw.imageMessage?.caption ||
        quotedRaw.videoMessage?.caption ||
        "";
      // Label the quoted message's ORIGINAL sender like WhatsApp: "You" for our
      // own messages, else the contact's saved name (1:1) or the bare number.
      const ownNum = (this.state.phoneNumber ?? "").replace(/\D/g, "");
      const qpRaw = ctx?.participant ? String(ctx.participant) : "";
      const qpJid = qpRaw ? (this.lidToPn.get(qpRaw) ?? this.canonicalJid(qpRaw)) : "";
      const qpNum = qpJid ? qpJid.split("@")[0].split(":")[0] : "";
      if (qpNum && ownNum && qpNum === ownNum) quotedSender = "You";
      else if (qpNum) quotedSender = this.chatStore.get(jid)?.meta.name || (isGroup ? qpNum : undefined);
    }
    const quotedId = ctx?.stanzaId ?? undefined;
    // A readable chat title: "Status" for stories, the sender's WhatsApp display
    // name (pushName) for individual incoming chats. Group titles are resolved
    // separately (async groupMetadata) because they aren't on the message.
    let nameHint: string | undefined;
    if (isStatus) nameHint = "Status";
    else if (isUser && !fromMe && msg.pushName) nameHint = String(msg.pushName);
    return {
      jid,
      display,
      raw,
      nameHint,
      m: { id: msgId, text: display, fromMe, ts, status: fromMe ? 1 : 0, quotedText, quotedId, quotedSender, quotedKind, mediaKind, mediaMime, fileName, participant: this.resolveParticipant(msg) },
    };
  }

  constructor(public userId: number) {
    this.state = {
      userId, status: "disconnected", qr: null,
      pairingCode: null, phoneNumber: null, lastError: null, connectedAt: null,
    };
  }

  addListener(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { for (const fn of this.listeners) { try { fn(this.state); } catch {} } }
  private set(patch: Partial<UserWAState>) { this.state = { ...this.state, ...patch }; this.notify(); }

  private sessionDir() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private wipe() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  private closeSocket() {
    if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) { try { this.sock.end(undefined); } catch {} this.sock = null; }
    this.pairingRequested = false;
  }

  async connectQR() {
    this.closeSocket();
    this.pairingPhone = null;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(false, "");
  }

  async connectPhone(phone: string, brandCode?: string | null) {
    this.closeSocket();
    this.wipe();
    const cleanPhone = normalizePhone(phone);
    this.pairingPhone = cleanPhone;
    const brand = (brandCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    this.brandCode = brand.length === 8 ? brand : null;
    this.didPair = false;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(true, cleanPhone);
  }

  /** Reconnect with saved creds — clears pairing state to prevent infinite loop */
  private async reconnectSaved() {
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(false, "");
  }

  private async _boot(usePairing: boolean, phone: string, pairingRetry = 0) {
    const dir = this.sessionDir();
    const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
    const version = await getWAVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, silentLogger),
      },
      logger: waLogger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      markOnlineOnConnect: false,
      connectTimeoutMs: 120_000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 20_000,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // EMPIRICAL > theory: Baileys docs say return undefined when uncached, and we
      // tried that — but view-once then arrived as an empty stub (hasMsg:false) and
      // never recovered. Yesterday's WORKING build returned {conversation:""} and
      // view-once recovered with no explicit resend code. Returning a non-undefined
      // message keeps Baileys' retry / placeholder-decryption path alive, which is
      // what lets the empty view-once stub get filled. Covert-safe: getMessage only
      // supplies data when WE resend; it never broadcasts presence/receipts.
      getMessage: async () => ({ conversation: "" }),
    });
    this.sock = sock;
    let codeRequested = false;

    sock.ev.on("creds.update", () => {
      this.didPair = true;
      saveCreds();
    });

    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      // Diagnostic (opt-in via WA_DEBUG_PROTO=1): log every connection transition
      // so we can tell whether the live socket actually stays open. Metadata only.
      if (process.env.WA_DEBUG_PROTO === "1" && (connection || qr || lastDisconnect)) {
        try {
          const sc = (lastDisconnect?.error as any)?.output?.statusCode ?? null;
          const reason = sc != null
            ? ((Object.keys(DisconnectReason) as Array<keyof typeof DisconnectReason>)
                .find((k) => DisconnectReason[k] === sc) ?? null)
            : null;
          console.log("[wa-conn] " + JSON.stringify({
            connection: connection ?? null,
            hasQR: !!qr,
            statusCode: sc,
            reason,
            err: (lastDisconnect?.error as any)?.message ?? null,
          }));
        } catch {}
      }

      if (qr && !usePairing) this.set({ status: "qr_ready", qr });

      // Request pairing code on first non-close event (same pattern as whatsapp.ts)
      if (usePairing && phone && !codeRequested && connection !== "close") {
        codeRequested = true;
        this.pairingTimer = setTimeout(async () => {
          if (this.sock !== sock) return;
          // Never request a code for already-registered creds (Baileys throws).
          if (sock.authState.creds.registered) return;
          try {
            const code = this.brandCode
              ? await sock.requestPairingCode(phone, this.brandCode)
              : await sock.requestPairingCode(phone);
            const display = code.replace(/(.{4})(.{4})/, "$1-$2");
            this.set({ status: "pairing", pairingCode: display, qr: null });
          } catch (e: any) {
            this.set({ status: "disconnected", lastError: `Pairing code nahi mila: ${e?.message ?? "unknown"}` });
          }
        }, 5000);
      }

      if (connection === "open") {
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
        this.badSessionRetried = false;
        const jid = sock.user?.id ?? null;
        const phoneNumber = jid ? jid.split(":")[0].split("@")[0] : null;
        const newPhone = phoneNumber ? `+${phoneNumber}` : null;
        // PER-NUMBER ISOLATION: on EVERY successful connect (first link, reconnect,
        // or a switch to a different number) drop the leak-sensitive live caches so
        // the previous number's chats / presence / call bubbles can never bleed into
        // the newly connected number's view, then reload ONLY this number's saved
        // history from the DB (below). We track lastLinkedPhone separately because
        // state.phoneNumber is cleared on disconnect, so a switch across a reconnect
        // is still detected here. (DB reads are already account-scoped; this clears
        // the in-memory caches that are not.)
        const prevPhone = this.lastLinkedPhone;
        const isSwitch = !!(prevPhone && newPhone && prevPhone !== newPhone);
        this.chatStore.clear();
        this.presence.clear();
        this.callOutcomes.clear();
        this.callAccepted.clear();
        this.callFirstTs.clear();
        // The per-number phonebook/identity caches (saved names, group titles, LID
        // map) legitimately differ between numbers, so we drop them on an actual
        // SWITCH. On a plain reconnect of the SAME number we keep them — WhatsApp may
        // not re-push contacts on a quick reconnect, and they'd otherwise be lost.
        if (isSwitch) {
          this.savedNames.clear();
          this.groupNamesFetched.clear();
          this.lidToPn.clear();
        }
        if (newPhone) this.lastLinkedPhone = newPhone;
        this.set({
          status: "connected", qr: null, pairingCode: null,
          connectedAt: new Date().toISOString(),
          phoneNumber: newPhone,
          lastError: null,
        });
        // Reload the connected number's saved history into memory — best-effort and
        // async so we never block the open path. hydrate() is merge-safe, so any live
        // message arriving in this brief window is preserved. Guarded against a fast
        // switch: only apply if this is still the live number when the DB read lands.
        if (newPhone && this.hydrateProvider) {
          const provider = this.hydrateProvider;
          const forPhone = newPhone;
          void (async () => {
            try {
              const history = await provider(forPhone);
              if (this.lastLinkedPhone === forPhone) {
                this.hydrate(history);
                if (process.env.WA_DEBUG_PROTO === "1") console.log(`[wa-conn] hydrated ${history.length} chats for ${forPhone}`);
              }
            } catch (e) {
              console.error("[wa-conn] hydrate-on-open failed:", e);
            }
          })();
        }
      }

      if (connection === "close") {
        // Ignore close events from stale sockets (e.g. old QR socket killed by closeSocket)
        if (this.sock !== sock) return;
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBadSession = statusCode === DisconnectReason.badSession;

        // A badSession (500) is usually a transient bad-MAC (we saw the link drop
        // mid-call). Try ONE reconnect with the saved creds before nuking the link —
        // only wipe if it comes back badSession a SECOND time (genuinely corrupt).
        if (isBadSession && !this.badSessionRetried) {
          this.badSessionRetried = true;
          this.set({ status: "connecting", lastError: null });
          const snapSock = sock;
          if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this.reconnectSaved();
            }
          }, 3000);
          return;
        }

        // Genuine logout (401), or a badSession that survived the one retry above.
        if (isLoggedOut || isBadSession) {
          this.wipe();
          this.pairingPhone = null;
          this.didPair = false;
          this.set({ status: "disconnected", connectedAt: null, phoneNumber: null, lastError: "Logged out — dobara link karein." });
          return;
        }

        // After pairing code accepted → WA closes initial WS → reconnect with saved creds
        const wasInPairing = this.state.status === "pairing" || this.didPair;
        if (wasInPairing) {
          this.set({ status: "connecting", lastError: null, pairingCode: null });
          const snapSock = sock;
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this.reconnectSaved();
            }
          }, 3000);
          return;
        }

        // If close fired before pairing code was received, retry up to 3 times
        if (usePairing && codeRequested && pairingRetry < 3) {
          this.set({ status: "connecting", lastError: null });
          const snapSock = sock;
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this._boot(true, phone, pairingRetry + 1);
            }
          }, 2000);
          return;
        }

        this.set({ status: "disconnected", connectedAt: null, phoneNumber: null, lastError: "Connection band." });
        // Auto-retry QR (not if phone pairing is in progress)
        if (!usePairing && !this.pairingPhone) {
          this.reconnectTimer = setTimeout(() => this.connectQR(), 8_000);
        }
      }
    });

    // COVERT presence: a contact's online/offline/typing state, ONLY for chats we
    // explicitly presenceSubscribe (when opened in the panel). We never broadcast
    // our own availability, so this never reveals the linked device.
    sock.ev.on("presence.update", async ({ id, presences }: BaileysEventMap["presence.update"]) => {
      // Captured BEFORE the async LID resolution below so out-of-order
      // completions can be detected and a stale (earlier-arriving) update dropped.
      const arrivedAt = Date.now();
      try {
        const canon = this.canonicalJid(id);
        // Resolve an @lid-addressed presence to the contact's real phone-number
        // jid so the PN-keyed panel can find it. resolveLidToPnNow consults the
        // Baileys signal store (not just the local cache), so it resolves far
        // more contacts; an unmapped @lid falls back to itself and is still
        // dual-keyed below so an @lid-keyed lookup keeps working too.
        const pnJid = id.endsWith("@lid")
          ? await this.resolveLidToPnNow(id)
          : (this.lidToPn.get(id) ?? canon);
        // For a 1:1 chat the presences map is keyed by the contact's jid; take the
        // entry for the chat id, else the first available entry.
        const entry = (presences && (presences[id] || Object.values(presences)[0])) || undefined;
        if (!entry) return;
        const presence = String(entry.lastKnownPresence ?? "unavailable");
        const lastSeen = entry.lastSeen ? Number(entry.lastSeen) * 1000 : undefined;
        // Diagnostic (opt-in via WA_DEBUG_PROTO=1): log presence arrivals so we
        // can confirm whether WhatsApp is actually pushing online/last-seen for a
        // subscribed contact (vs. the contact's privacy blocking it entirely).
        if (process.env.WA_DEBUG_PROTO === "1") {
          console.log("[wa-presence] " + JSON.stringify({ id, pnJid, presence, lastSeen }));
        }
        const data = { presence, lastSeen, at: arrivedAt };
        if (this.presence.size > 2000) this.presence.clear();
        // Async LID resolution can finish out of order; never let an update that
        // ARRIVED earlier overwrite a later one for the same contact.
        const prev = this.presence.get(pnJid);
        if (prev && prev.at > arrivedAt) return;
        // Store + emit under BOTH the mapped phone-number jid and the raw event id
        // (which may be an @lid). The panel keys presence by the chat's PN jid, so
        // dual-keying means a presence update is found whether WhatsApp addressed
        // the contact by phone number or by its privacy LID.
        this.presence.set(pnJid, data);
        this.notifyPresence({ jid: pnJid, presence, lastSeen });
        if (canon !== pnJid) {
          this.presence.set(canon, data);
          this.notifyPresence({ jid: canon, presence, lastSeen });
        }
      } catch {}
    });

    // Capture ALL messages (incoming + outgoing) for WhatsApp Web inbox
    sock.ev.on("messages.upsert", async (m: BaileysEventMap["messages.upsert"]) => {
      // Diagnostic (opt-in via WA_DEBUG_PROTO=1): log EVERY upsert with its type
      // and, per message, whether decryptable content is present. A live incoming
      // message that arrives with hasMsg=false means decryption failed and it
      // would be silently dropped. Metadata only — never text/media content.
      if (process.env.WA_DEBUG_PROTO === "1") {
        try {
          console.log("[wa-upsert] " + JSON.stringify({
            type: m.type,
            count: m.messages.length,
            msgs: m.messages.map((x) => {
              const rj = x.key?.remoteJid ?? "";
              return {
                id: x.key?.id ?? null,
                fromMe: x.key?.fromMe ?? false,
                jidType: rj.endsWith("@g.us") ? "group" : rj === "status@broadcast" ? "status" : "user",
                hasMsg: !!x.message,
                topKey: x.message ? Object.keys(x.message)[0] : null,
                viewOnce: (x.key as any)?.isViewOnce ?? null,
                stub: (x as any).messageStubType ?? null,
              };
            }),
          }));
        } catch {}
      }
      // "notify" = a brand-new live message arriving at this device.
      // "append" = a message added to a chat from ELSEWHERE — most importantly the
      //   messages you send from your OWN phone (WhatsApp→WhatsApp). Without
      //   handling it, the panel never shows phone-sent outgoing messages live.
      if (m.type !== "notify" && m.type !== "append") return;
      const isLive = m.type === "notify";
      for (const msg of m.messages) {
        // ANTI-DELETE: a "delete for everyone" arrives as a protocolMessage
        // REVOKE (type 0). It can be wrapped (deviceSent / ephemeral), so unwrap
        // first. Flag the referenced message but KEEP its content, and never
        // store the revoke envelope itself as a junk message.
        const proto = this.unwrapMessage((msg.message as any))?.protocolMessage
          ?? (msg.message as any)?.protocolMessage;
        if (proto && proto.type === 0 && proto.key?.id) {
          const delId: string = proto.key.id;
          const delJid: string = this.resolveUserJid(msg) || proto.key?.remoteJid || "";
          const entry = this.chatStore.get(delJid);
          const target = entry?.msgs.find((x) => x.id === delId);
          if (target) target.deleted = true;
          this.notifyDelete(delId);
          continue;
        }
        // VIEW-ONCE: a view-once photo/video arrives on a companion (linked) device
        // as an EMPTY message (msg.message == null, key.isViewOnce === true).
        // WhatsApp DELIBERATELY withholds view-once media from every companion
        // device — it can only be opened on the primary phone. This is the same
        // reason official WhatsApp Web shows "open this on your phone". We verified
        // LIVE that requestPlaceholderResend does NOT recover it (the phone refuses
        // to resend view-once content to a companion: 3 requests, 0 responses), so
        // we don't waste a protocol round-trip / extra activity on it. Instead we
        // surface an honest, permanent placeholder so the arrival — its time and
        // sender — is still visible. Deduped by key.id (retries reuse the id).
        if (!msg.message) {
          const rj: string = msg.key?.remoteJid ?? "";
          const pid: string = msg.key?.id ?? "";
          const isViewOnce = (msg.key as any)?.isViewOnce === true;
          // Only real conversations (1:1, LID, group). Skip status/newsletter/
          // service JIDs so a null-message system event never spawns a junk chat.
          const isChatJid = /@(s\.whatsapp\.net|lid|g\.us)$/.test(rj);
          if (isLive && isViewOnce && pid && isChatJid) {
            if (process.env.WA_DEBUG_PROTO === "1") {
              console.log(`[wa-viewonce] view-once arrived (not openable on linked device) id=${pid} fromMe=${msg.key?.fromMe ?? false}`);
            }
            const phJid = this.resolveUserJid(msg) || rj;
            const pts = ((msg.messageTimestamp as number) ?? 0) * 1000 || Date.now();
            const fromMe = msg.key?.fromMe ?? false;
            const placeholder = "🔒 View-once — can only be opened on the phone";
            this.upsertMsg(
              phJid,
              { id: pid, text: placeholder, fromMe, ts: pts, status: 1 },
              placeholder,
              false,
              msg.pushName ? String(msg.pushName) : undefined,
            );
          }
          continue;
        }
        const parsed = this.parseWAMessage(msg);
        if (!parsed) continue;
        const { jid, m: chatMsg } = parsed;
        // Show the message IMMEDIATELY (text or media placeholder) so the inbox
        // updates in real time. The actual media bytes are downloaded in the
        // background below and patched in via a second upsert (COALESCE-backfill).
        // append → treat like history (no unread bump); notify → live (counts unread).
        this.upsertMsg(jid, chatMsg, parsed.display, !isLive, parsed.nameHint);
        this.ensureGroupName(jid);
        if (chatMsg.mediaKind && !chatMsg.media) {
          // Pass the UNWRAPPED message so view-once / ephemeral media downloads
          // correctly (Baileys can't find media inside the envelope otherwise).
          // Retry a few times: view-once bytes are sometimes not decryptable on
          // the very first attempt and there's only one chance to capture them.
          downloadMediaWithRetry({ key: msg.key, message: parsed.raw }, sock)
            .then((b64) => {
              if (b64) {
                // `history=true` → this is a media backfill of an already-counted
                // message, so it must NOT increment the unread badge again.
                this.upsertMsg(jid, { ...chatMsg, media: b64 }, parsed.display, true);
              } else if (process.env.WA_DEBUG_PROTO === "1") {
                console.log(`[wa-media] live media unavailable kind=${chatMsg.mediaKind} id=${chatMsg.id}`);
              }
            })
            .catch(() => {});
        }
        if (!chatMsg.fromMe && isLive) {
          // The monitoring panel NEVER sends read receipts: we deliberately
          // never call sock.readMessages anywhere, so a monitored contact is
          // never shown a blue "seen" tick. Notify listeners of the incoming.
          const senderPhone = jid.split("@")[0];
          this.notifyMsg(`+${senderPhone}`, {
            waMessageId: chatMsg.id,
            text: chatMsg.text,
            ts: chatMsg.ts,
            quotedWaId: chatMsg.quotedId,
            quotedText: chatMsg.quotedText,
          });
        }
      }
    });

    // Sync existing chats + messages when the device links (WhatsApp-Web-style
    // inbox). Baileys streams recent history in one or more of these events.
    sock.ev.on("messaging-history.set", async (h: BaileysEventMap["messaging-history.set"]) => {
      for (const c of (h.contacts ?? [])) this.applyContact(c);
      const unreadByJid = new Map<string, number>();
      const nameByJid = new Map<string, string>();
      for (const c of h.chats ?? []) {
        if (!c.id) continue;
        // Count unread for every chat type (individual, group, status).
        unreadByJid.set(c.id, Math.max(0, c.unreadCount ?? 0));
        // WhatsApp gives a chat title here for groups (and named contacts).
        const title = (c as any).name ?? (c as any).subject;
        if (title) nameByJid.set(c.id, String(title));
      }
      for (const msg of h.messages ?? []) {
        const parsed = this.parseWAMessage(msg);
        if (!parsed) continue;
        const { jid, m: chatMsg } = parsed;
        if (chatMsg.mediaKind && !chatMsg.media) {
          // History backfill: download through the shared limiter on the LOW-priority
          // HISTORY lane (capped, never preempts a live view-once) with fewer retries
          // — a bulk sync of old media must not congest the socket or starve a live
          // one-shot capture happening at the same moment.
          const b64 = await downloadMediaWithRetry({ key: msg.key, message: parsed.raw }, sock, 2, true);
          if (b64) chatMsg.media = b64;
        }
        this.upsertMsg(jid, chatMsg, parsed.display, true, nameByJid.get(jid) ?? parsed.nameHint);
        if (jid.endsWith("@g.us") && !nameByJid.get(jid)) this.ensureGroupName(jid);
      }
      // Apply chat titles even for chats with no synced messages yet.
      for (const [jid, name] of nameByJid) {
        const entry = this.chatStore.get(jid);
        if (entry && entry.meta.name !== name) entry.meta.name = name;
      }
      // Apply the real unread counts reported by WhatsApp for each chat.
      for (const [jid, unread] of unreadByJid) {
        const entry = this.chatStore.get(jid);
        if (entry) entry.meta.unread = unread;
      }
    });

    // Track message status updates (sent/delivered/read ticks)
    sock.ev.on("messages.update", (updates: BaileysEventMap["messages.update"]) => {
      for (const update of updates) {
        const jid = this.resolveUserJid(update) || "";
        if (!jid) continue;
        const entry = this.chatStore.get(jid);
        const m = entry?.msgs.find(x => x.id === update.key.id);
        if (m && update.update.status != null) m.status = update.update.status as number;
        if (update.key.id && update.update.status != null) {
          this.notifyStatus({
            waMessageId: update.key.id,
            jid,
            status: update.update.status as number,
          });
        }
      }
    });

    // Sync saved (address-book) contact names so the inbox shows the name you
    // saved a number under — exactly like WhatsApp-Web. Read-only / covert.
    sock.ev.on("contacts.upsert", (contacts: any[]) => { for (const c of contacts) this.applyContact(c); });
    sock.ev.on("contacts.update", (contacts: any[]) => { for (const c of contacts) this.applyContact(c); });

    // Capture call notifications (incoming / missed / rejected / accepted) so the
    // Calls log can mirror WhatsApp. A linked device receives notifications only.
    sock.ev.on("call", (calls: BaileysEventMap["call"]) => {
      // Serialize call handling so an offer is fully processed (and its LID→PN
      // mapping cached) before the terminal event — preventing reordered upserts.
      for (const c of calls) {
        this.callQueue = this.callQueue.then(() => this.handleCall(c)).catch(() => {});
      }
    });
  }

  /**
   * Send a text message to a phone number. Returns the WA message id so
   * callers can persist it for tick/status round-trips.
   *
   * `quoted` lets callers attach a WhatsApp-style quoted reply. We need the
   * original sender's jid + their stanza id + the original text to build
   * Baileys' `quoted` payload.
   */
  async sendMessage(
    toPhone: string,
    text: string,
    quoted?: { waMessageId: string; fromMe: boolean; text: string },
  ): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    const jid = `${toPhone.replace(/\D/g, "")}@s.whatsapp.net`;
    let opts: any = undefined;
    if (quoted?.waMessageId) {
      opts = {
        quoted: {
          key: { remoteJid: jid, fromMe: quoted.fromMe, id: quoted.waMessageId },
          message: { conversation: quoted.text || "" },
        },
      };
    }
    const result = await this.sock.sendMessage(jid, { text }, opts);
    const msgId = result?.key.id ?? `local-${Date.now()}`;
    this.upsertMsg(
      jid,
      { id: msgId, text, fromMe: true, ts: Date.now(), status: 1, quotedText: quoted?.text, quotedId: quoted?.waMessageId },
      text,
    );
    return msgId;
  }

  disconnect() {
    this.closeSocket();
    this.pairingPhone = null;
    this.set({ status: "disconnected", qr: null, pairingCode: null, lastError: "Disconnected", connectedAt: null });
  }

  clearSession() {
    this.closeSocket();
    this.pairingPhone = null;
    this.wipe();
    this.set({ status: "disconnected", qr: null, pairingCode: null, lastError: "Session cleared", connectedAt: null, phoneNumber: null });
  }

  freshStart() {
    this.clearSession();
    setTimeout(() => this.connectQR(), 500);
  }

  /** Session/certificate info: whether WA creds exist on disk + connection meta. */
  getSessionInfo() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    const credsFile = path.join(dir, "creds.json");
    const hasCreds = fs.existsSync(credsFile);
    let credsUpdatedAt: string | null = null;
    if (hasCreds) {
      try { credsUpdatedAt = fs.statSync(credsFile).mtime.toISOString(); } catch {}
    }
    return {
      userId: this.userId,
      status: this.state.status,
      phoneNumber: this.state.phoneNumber,
      connectedAt: this.state.connectedAt,
      lastError: this.state.lastError,
      hasCredentials: hasCreds,
      credentialsUpdatedAt: credsUpdatedAt,
      sessionDir: `user-${this.userId}`,
    };
  }
}

class MultiWhatsAppService {
  private sessions = new Map<number, UserSession>();
  private globalListeners: Set<(state: UserWAState) => void> = new Set();
  private globalMsgListeners: Set<MsgListener> = new Set();
  private globalStatusListeners: Set<StatusListener> = new Set();
  private globalPersistListeners: Set<PersistListener> = new Set();
  private globalDeleteListeners: Set<DeleteListener> = new Set();
  private globalCallListeners: Set<CallListener> = new Set();
  private globalPresenceListeners: Set<PresenceListener> = new Set();
  private globalContactNameListeners: Set<ContactNameListener> = new Set();
  // PER-NUMBER ISOLATION: a single provider that loads ONE number's saved history
  // from the DB, applied to the current + all future sessions so each connect
  // rehydrates the in-memory store with only that number's chats.
  private globalHydrateProvider: ((accountPhone: string) => Promise<HydrateChat[]>) | null = null;

  addGlobalListener(fn: (state: UserWAState) => void) {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  /** Subscribe to EVERY new message (in + out) across all sessions for DB persistence. */
  addPersistListener(fn: PersistListener) {
    this.globalPersistListeners.add(fn);
    return () => this.globalPersistListeners.delete(fn);
  }

  /** Subscribe to delete-for-everyone events across all sessions (anti-delete). */
  addDeleteListener(fn: DeleteListener) {
    this.globalDeleteListeners.add(fn);
    return () => this.globalDeleteListeners.delete(fn);
  }

  /** Subscribe to call notifications across all sessions (Calls log). */
  addCallListener(fn: CallListener) {
    this.globalCallListeners.add(fn);
    return () => this.globalCallListeners.delete(fn);
  }

  /** Subscribe to contact presence updates across all sessions (covert). */
  addPresenceListener(fn: PresenceListener) {
    this.globalPresenceListeners.add(fn);
    return () => this.globalPresenceListeners.delete(fn);
  }

  /** Covert-safe: subscribe-only request for a contact's presence. */
  subscribePresence(userId: number, jid: string) { this.getSession(userId).subscribePresence(jid); }
  getPresence(userId: number, jid: string): WAPresence | null { return this.getSession(userId).getPresence(jid); }

  /** Load DB chat history into a session's in-memory store (call before connect). */
  hydrate(userId: number, chats: HydrateChat[]) { this.getSession(userId).hydrate(chats); }

  /** PER-NUMBER ISOLATION: wire the provider that loads ONE connected number's
   *  saved history from the DB. Applied to the current + every future session so
   *  each successful connect rehydrates memory with only that number's chats. */
  setHydrateProvider(fn: (accountPhone: string) => Promise<HydrateChat[]>) {
    this.globalHydrateProvider = fn;
    for (const s of this.sessions.values()) s.setHydrateProvider(fn);
  }

  addContactNameListener(fn: ContactNameListener) {
    this.globalContactNameListeners.add(fn);
    return () => this.globalContactNameListeners.delete(fn);
  }
  /** Covert read of a contact's profile-picture URL (for lazy avatar caching). */
  getProfilePictureUrl(userId: number, jid: string) { return this.getSession(userId).getProfilePictureUrl(jid); }
  /** Seed saved (address-book) names loaded from DB on startup. */
  seedSavedNames(userId: number, entries: Array<{ jid: string; savedName: string }>) { this.getSession(userId).seedSavedNames(entries); }

  private getSession(userId: number): UserSession {
    if (!this.sessions.has(userId)) {
      const sess = new UserSession(userId);
      sess.addListener(state => {
        for (const fn of this.globalListeners) { try { fn(state); } catch {} }
      });
      sess.addMsgListener((uid, phone, msg) => {
        for (const fn of this.globalMsgListeners) { try { fn(uid, phone, msg); } catch {} }
      });
      sess.addStatusListener((uid, update) => {
        for (const fn of this.globalStatusListeners) { try { fn(uid, update); } catch {} }
      });
      sess.addPersistListener((uid, jid, phone, msg, history, name) => {
        for (const fn of this.globalPersistListeners) { try { fn(uid, jid, phone, msg, history, name); } catch {} }
      });
      sess.addDeleteListener((uid, waMessageId) => {
        for (const fn of this.globalDeleteListeners) { try { fn(uid, waMessageId); } catch {} }
      });
      sess.addCallListener((uid, call) => {
        for (const fn of this.globalCallListeners) { try { fn(uid, call); } catch {} }
      });
      sess.addPresenceListener((uid, p) => {
        for (const fn of this.globalPresenceListeners) { try { fn(uid, p); } catch {} }
      });
      sess.addContactNameListener((uid, jid, savedName) => {
        for (const fn of this.globalContactNameListeners) { try { fn(uid, jid, savedName); } catch {} }
      });
      if (this.globalHydrateProvider) sess.setHydrateProvider(this.globalHydrateProvider);
      this.sessions.set(userId, sess);
    }
    return this.sessions.get(userId)!;
  }

  getState(userId: number): UserWAState { return this.getSession(userId).state; }
  getSessionInfo(userId: number) { return this.getSession(userId).getSessionInfo(); }
  getAllStates(): UserWAState[] { return [...this.sessions.values()].map(s => s.state); }
  addUserListener(userId: number, fn: (state: UserWAState) => void) { return this.getSession(userId).addListener(fn); }

  connectQR(userId: number)               { return this.getSession(userId).connectQR(); }
  connectPhone(userId: number, p: string, brandCode?: string | null) { return this.getSession(userId).connectPhone(p, brandCode); }
  disconnect(userId: number)              { this.getSession(userId).disconnect(); }
  clearSession(userId: number)            { this.getSession(userId).clearSession(); }
  freshStart(userId: number)              { this.getSession(userId).freshStart(); }
  sendMessage(userId: number, to: string, text: string, quoted?: { waMessageId: string; fromMe: boolean; text: string }) {
    return this.getSession(userId).sendMessage(to, text, quoted);
  }
  sendToJid(userId: number, jid: string, text: string) { return this.getSession(userId).sendToJid(jid, text); }
  getChatList(userId: number) { return this.getSession(userId).getChatList(); }
  getChatMessages(userId: number, jid: string) { return this.getSession(userId).getChatMessages(jid); }
  markRead(userId: number, jid: string) { this.getSession(userId).markRead(jid); }
  deleteForEveryone(userId: number, jid: string, msgId: string, fromMe: boolean) { return this.getSession(userId).deleteForEveryone(jid, msgId, fromMe); }
  addMsgListener(fn: MsgListener) { this.globalMsgListeners.add(fn); return () => this.globalMsgListeners.delete(fn); }
  addStatusListener(fn: StatusListener) { this.globalStatusListeners.add(fn); return () => this.globalStatusListeners.delete(fn); }

  /** Send from any connected session — used by admin reply routing */
  async sendFromAnyConnected(to: string, text: string): Promise<{ ok: boolean; waMessageId?: string; userId?: number }> {
    for (const sess of this.sessions.values()) {
      if (sess.state.status === "connected") {
        try {
          const id = await sess.sendMessage(to, text);
          return { ok: true, waMessageId: id, userId: (sess as any).userId };
        } catch {}
      }
    }
    return { ok: false };
  }

  /** On server startup: reconnect any saved sessions found on disk */
  autoReconnectSaved() {
    if (!fs.existsSync(SESSIONS_BASE)) return;
    const dirs = fs.readdirSync(SESSIONS_BASE);
    for (const dir of dirs) {
      const match = dir.match(/^user-(\d+)$/);
      if (!match) continue;
      const userId = parseInt(match[1]);
      const credsFile = path.join(SESSIONS_BASE, dir, "creds.json");
      if (!fs.existsSync(credsFile)) continue;
      // Small stagger to avoid hammering WA servers simultaneously
      const delay = (userId % 10) * 2000;
      setTimeout(() => {
        this.getSession(userId).connectQR().catch(() => {});
      }, delay);
    }
  }
}

export const multiWA = new MultiWhatsAppService();
