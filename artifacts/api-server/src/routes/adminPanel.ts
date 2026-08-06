import { Router, raw, type IRouter } from "express";
import { eq, desc, count, sum, or, and, isNull, inArray } from "drizzle-orm";
import {
  db,
  adminUsersTable,
  panelUserTable,
  waChatsTable,
  waMessagesTable,
  waAccountsTable,
  waCallLogsTable,
  appLogsTable,
  appBackupsTable,
  appSettingsTable,
} from "@workspace/db";
import { createHmac } from "crypto";
import AdmZip from "adm-zip";
import { multiWA } from "../services/multiWhatsapp.js";
import {
  PANEL_USER_ID,
  getAllChats,
  getAccounts,
  getChatMessagesDb,
  getMediaById,
  getCallLogs,
  getStatusGroups,
  logEvent,
} from "../services/chatPersistence.js";

const router: IRouter = Router();

const TOKEN_SECRET = process.env.SESSION_SECRET ?? "hamarinews_admin_secret_fallback";
const ADMIN_TOKEN_PREFIX = "sc_admin_";

function generateAdminToken(adminId: number, passwordHash: string): string {
  const hmac = createHmac("sha256", TOKEN_SECRET).update(`${adminId}:${passwordHash}`).digest("hex");
  return ADMIN_TOKEN_PREFIX + hmac;
}

async function requireAdmin(req: any, res: any): Promise<number | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const token = auth.slice(7);
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
  const admins = await db.select().from(adminUsersTable);
  for (const a of admins) {
    if (generateAdminToken(a.id, a.passwordHash) === token) return a.id;
  }
  res.status(401).json({ error: "Invalid or expired token" });
  return null;
}

// ── The managed user (creds + approval) ───────────────────────────

/** Admin can SEE the created user's username + password (self-hosted tool). */
router.get("/admin-panel/user", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.json({ exists: false });
    return;
  }
  res.json({
    exists: true,
    id: user.id,
    username: user.username,
    password: user.passwordPlain,
    approved: user.approved,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
  });
});

router.post("/admin-panel/user/approve", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.status(404).json({ error: "No user to approve" });
    return;
  }
  const [updated] = await db
    .update(panelUserTable)
    .set({ approved: true, approvedAt: new Date() })
    .where(eq(panelUserTable.id, user.id))
    .returning();
  await logEvent(`Admin approved user: ${user.username}`, "info", "admin");
  res.json({ success: true, approved: updated.approved });
});

router.post("/admin-panel/user/revoke", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.status(404).json({ error: "No user found" });
    return;
  }
  await db.update(panelUserTable).set({ approved: false, approvedAt: null }).where(eq(panelUserTable.id, user.id));
  await logEvent(`Admin revoked user access: ${user.username}`, "warn", "admin");
  res.json({ success: true });
});

// ── Pairing brand code (editable from admin) ──────────────────────

async function getAppSettings() {
  let [s] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1));
  if (!s) [s] = await db.insert(appSettingsTable).values({ id: 1 }).returning();
  return s;
}

router.get("/admin-panel/pairing-code", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const s = await getAppSettings();
  res.json({ pairingBrandCode: s.pairingBrandCode });
});

router.put("/admin-panel/pairing-code", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const raw = String(req.body?.pairingBrandCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 8) {
    res.status(400).json({ error: "Pairing code theek 8 characters (A-Z, 0-9) ka hona chahiye" });
    return;
  }
  await getAppSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({ pairingBrandCode: raw, updatedAt: new Date() })
    .where(eq(appSettingsTable.id, 1))
    .returning();
  await logEvent(`Admin set pairing code to ${raw}`, "info", "admin");
  res.json({ pairingBrandCode: updated.pairingBrandCode });
});

// ── Oversight: chats + messages ───────────────────────────────────

router.get("/admin-panel/wa/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(multiWA.getSessionInfo(PANEL_USER_ID));
});

router.get("/admin-panel/accounts", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getAccounts());
});

router.get("/admin-panel/chats", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json(await getAllChats(account));
});

router.get("/admin-panel/chats/:jid/messages", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getChatMessagesDb(req.params.jid));
});

/** Serve a message's media payload. Token via `?t=` so it works in <img> src. */
router.get("/admin-panel/media/:msgId", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requireAdmin(req, res))) return;
  const row = await getMediaById(req.params.msgId);
  if (!row || !row.media) {
    res.status(404).json({ error: "No media" });
    return;
  }
  const buf = Buffer.from(row.media, "base64");
  res.setHeader("Content-Type", row.mediaMime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  if (row.mediaKind === "document" && row.fileName) {
    res.setHeader("Content-Disposition", `inline; filename="${row.fileName.replace(/"/g, "")}"`);
  }
  res.send(buf);
});

// Admin panel is monitoring-only — no message sending.

// ── Oversight: calls + status (read-only) ─────────────────────────

router.get("/admin-panel/calls", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getCallLogs());
});

router.get("/admin-panel/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getStatusGroups());
});

// ── Export / download all chats ───────────────────────────────────

router.get("/admin-panel/export", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const chats = await db.select().from(waChatsTable);
  const messages = await db.select().from(waMessagesTable);
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), chats, messages }, null, 2);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="chats-export-${Date.now()}.json"`);
  res.send(payload);
});

// ── Per-number record: export (ZIP) / delete / restore ────────────
//
// Each connected WhatsApp number's data lives separately: chats via
// wa_chats.account_phone, messages via wa_messages.account_phone (with a
// jid-list fallback for rows captured before tagging existed), and calls via
// wa_call_logs.account_phone. The admin can download a self-contained,
// restorable ZIP per number and delete a number's record entirely.

/** Best-effort file extension for a media blob, for human-friendly ZIP files. */
function mediaExt(mime?: string | null, kind?: string | null, fileName?: string | null): string {
  if (fileName && fileName.includes(".")) return "." + fileName.split(".").pop();
  const m = (mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("3gpp")) return ".3gp";
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("pdf")) return ".pdf";
  if (kind === "image") return ".jpg";
  if (kind === "video") return ".mp4";
  if (kind === "audio") return ".ogg";
  if (kind === "sticker") return ".webp";
  return ".bin";
}

function safeName(s: string): string {
  return (s || "file").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

/** Download a single connected number's record as a restorable ZIP. */
router.get("/admin-panel/accounts/:phone/export", async (req, res): Promise<void> => {
  // Token via `?t=` so a plain browser download (anchor click) authenticates.
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requireAdmin(req, res))) return;
  const phone = req.params.phone;

  const chats = await db.select().from(waChatsTable).where(eq(waChatsTable.accountPhone, phone));
  const jids = chats.map((c) => c.jid);
  // Primary match is the message's own account tag. The jid fallback only picks
  // up LEGACY untagged rows (account_phone IS NULL) so we can never pull another
  // connected number's tagged messages that happen to share a contact JID.
  const messages = jids.length
    ? await db.select().from(waMessagesTable).where(
        or(eq(waMessagesTable.accountPhone, phone), and(isNull(waMessagesTable.accountPhone), inArray(waMessagesTable.jid, jids))),
      )
    : await db.select().from(waMessagesTable).where(eq(waMessagesTable.accountPhone, phone));
  const calls = await db.select().from(waCallLogsTable).where(eq(waCallLogsTable.accountPhone, phone));
  const [account] = await db.select().from(waAccountsTable).where(eq(waAccountsTable.phone, phone));

  const zip = new AdmZip();
  // Pull base64 media OUT of the JSON into real files (keeps JSON small + media
  // viewable). Each message keeps a `mediaFile` pointer so restore re-attaches.
  const slimMessages = messages.map((m) => {
    const out: Record<string, unknown> = { ...m };
    if (m.media) {
      const rel = `media/${safeName(m.waMessageId)}${mediaExt(m.mediaMime, m.mediaKind, m.fileName)}`;
      out.mediaFile = rel;
      out.media = null;
      zip.addFile(rel, Buffer.from(m.media, "base64"));
    }
    return out;
  });

  zip.addFile("manifest.json", Buffer.from(JSON.stringify({
    version: 1,
    type: "support-connect-account-export",
    accountPhone: phone,
    account: account ?? null,
    exportedAt: new Date().toISOString(),
    chatCount: chats.length,
    messageCount: messages.length,
    callCount: calls.length,
  }, null, 2)));
  zip.addFile("chats.json", Buffer.from(JSON.stringify(chats, null, 2)));
  zip.addFile("messages.json", Buffer.from(JSON.stringify(slimMessages, null, 2)));
  zip.addFile("calls.json", Buffer.from(JSON.stringify(calls, null, 2)));

  await logEvent(`Admin exported record for +${phone} (${chats.length} chats, ${messages.length} msgs)`, "info", "admin");
  const buf = zip.toBuffer();
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="account-${safeName(phone)}-${Date.now()}.zip"`);
  res.send(buf);
});

/** Permanently delete one connected number's record (chats + messages + calls + registry). */
router.delete("/admin-panel/accounts/:phone", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const phone = req.params.phone;
  try {
    const chats = await db.select({ jid: waChatsTable.jid }).from(waChatsTable).where(eq(waChatsTable.accountPhone, phone));
    const jids = chats.map((c) => c.jid);
    // All-or-nothing: a partial delete would orphan rows. The message delete uses
    // the same NULL-only jid fallback as export so another number's tagged
    // messages on a shared contact are never removed.
    await db.transaction(async (tx) => {
      if (jids.length) {
        await tx.delete(waMessagesTable).where(
          or(eq(waMessagesTable.accountPhone, phone), and(isNull(waMessagesTable.accountPhone), inArray(waMessagesTable.jid, jids))),
        );
      } else {
        await tx.delete(waMessagesTable).where(eq(waMessagesTable.accountPhone, phone));
      }
      await tx.delete(waChatsTable).where(eq(waChatsTable.accountPhone, phone));
      await tx.delete(waCallLogsTable).where(eq(waCallLogsTable.accountPhone, phone));
      await tx.delete(waAccountsTable).where(eq(waAccountsTable.phone, phone));
    });
    await logEvent(`Admin deleted entire record for +${phone}`, "warn", "admin");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Delete failed" });
  }
});

/** Restore a previously-exported account ZIP (idempotent; never overwrites existing rows). */
router.post("/admin-panel/accounts/import", raw({ type: () => true, limit: "600mb" }), async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Empty upload" });
      return;
    }
    const zip = new AdmZip(body);
    const readJson = (name: string): any => {
      const e = zip.getEntry(name);
      return e ? JSON.parse(e.getData().toString("utf8")) : null;
    };
    const manifest = readJson("manifest.json");
    const fallbackPhone: string | null = manifest?.accountPhone ?? null;
    const chats: any[] = readJson("chats.json") ?? [];
    const messages: any[] = readJson("messages.json") ?? [];
    const calls: any[] = readJson("calls.json") ?? [];

    let restoredChats = 0;
    let restoredMsgs = 0;
    for (const c of chats) {
      if (!c?.jid) continue;
      const acct = c.accountPhone ?? fallbackPhone;
      if (!acct) continue; // account_phone is NOT NULL + part of the composite PK
      await db.insert(waChatsTable).values({
        jid: c.jid,
        phone: c.phone ?? c.jid.split("@")[0],
        name: c.name ?? null,
        lastMsg: c.lastMsg ?? "",
        lastMsgTs: c.lastMsgTs ?? 0,
        unread: 0,
        accountPhone: acct,
      }).onConflictDoNothing({ target: [waChatsTable.accountPhone, waChatsTable.jid] });
      restoredChats++;
    }
    for (const m of messages) {
      if (!m?.waMessageId || !m?.jid) continue;
      const acct = m.accountPhone ?? fallbackPhone;
      if (!acct) continue; // account_phone is NOT NULL + part of the composite unique key
      let media: string | null = m.media ?? null;
      if (!media && m.mediaFile) {
        const e = zip.getEntry(m.mediaFile);
        if (e) media = e.getData().toString("base64");
      }
      await db.insert(waMessagesTable).values({
        waMessageId: m.waMessageId,
        jid: m.jid,
        text: m.text ?? "",
        fromMe: !!m.fromMe,
        ts: m.ts ?? 0,
        status: m.status ?? 0,
        deleted: !!m.deleted,
        deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
        quotedText: m.quotedText ?? null,
        quotedId: m.quotedId ?? null,
        media,
        mediaMime: m.mediaMime ?? null,
        mediaKind: m.mediaKind ?? null,
        fileName: m.fileName ?? null,
        participant: m.participant ?? null,
        accountPhone: acct,
      }).onConflictDoNothing({ target: [waMessagesTable.accountPhone, waMessagesTable.waMessageId] });
      restoredMsgs++;
    }
    for (const cl of calls) {
      if (!cl?.callId) continue;
      await db.insert(waCallLogsTable).values({
        callId: cl.callId,
        jid: cl.jid,
        phone: cl.phone,
        name: cl.name ?? null,
        accountPhone: cl.accountPhone ?? fallbackPhone,
        outgoing: !!cl.outgoing,
        isVideo: !!cl.isVideo,
        isGroup: !!cl.isGroup,
        outcome: cl.outcome ?? "incoming",
        rawStatus: cl.rawStatus ?? null,
        ts: cl.ts ?? 0,
        durationSec: cl.durationSec ?? null,
      }).onConflictDoNothing({ target: waCallLogsTable.callId });
    }
    if (fallbackPhone) {
      await db.insert(waAccountsTable).values({ phone: fallbackPhone }).onConflictDoNothing({ target: waAccountsTable.phone });
    }
    await logEvent(`Admin restored account record (${restoredChats} chats, ${restoredMsgs} msgs)`, "info", "admin");
    res.json({ success: true, chats: restoredChats, messages: restoredMsgs });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Import failed" });
  }
});

// ── Stats ─────────────────────────────────────────────────────────

router.get("/admin-panel/stats", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [{ value: chatCount }] = await db.select({ value: count() }).from(waChatsTable);
  const [{ value: msgCount }] = await db.select({ value: count() }).from(waMessagesTable);
  const [{ value: backupCount }] = await db.select({ value: count() }).from(appBackupsTable);
  const [{ value: inCount }] = await db.select({ value: count() }).from(waMessagesTable).where(eq(waMessagesTable.fromMe, false));
  const [{ value: outCount }] = await db.select({ value: count() }).from(waMessagesTable).where(eq(waMessagesTable.fromMe, true));
  const [{ value: backupBytes }] = await db.select({ value: sum(appBackupsTable.sizeBytes) }).from(appBackupsTable);
  const state = multiWA.getSessionInfo(PANEL_USER_ID);
  res.json({
    chats: chatCount,
    messages: msgCount,
    backups: backupCount,
    incoming: inCount,
    outgoing: outCount,
    storageBytes: Number(backupBytes ?? 0),
    dbConnected: true,
    whatsapp: { status: state.status, phoneNumber: state.phoneNumber, connectedAt: state.connectedAt },
  });
});

// ── Tools: auto-fix / reconnect / clear-session / restart ─────────

router.post("/admin-panel/tools/fix", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  multiWA.freshStart(PANEL_USER_ID);
  await logEvent("Admin triggered auto-fix (fresh start)", "warn", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/reconnect", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  await multiWA.connectQR(PANEL_USER_ID);
  await logEvent("Admin triggered reconnect", "info", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/clear-session", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  multiWA.clearSession(PANEL_USER_ID);
  await logEvent("Admin cleared WhatsApp session", "warn", "admin");
  res.json({ success: true });
});

// ── Logs ──────────────────────────────────────────────────────────

router.get("/admin-panel/logs", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const rows = await db.select().from(appLogsTable).orderBy(desc(appLogsTable.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin-panel/backups", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const rows = await db
    .select({
      id: appBackupsTable.id,
      filename: appBackupsTable.filename,
      sizeBytes: appBackupsTable.sizeBytes,
      chatCount: appBackupsTable.chatCount,
      messageCount: appBackupsTable.messageCount,
      createdAt: appBackupsTable.createdAt,
    })
    .from(appBackupsTable)
    .orderBy(desc(appBackupsTable.createdAt));
  res.json(rows);
});

export default router;
