import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import {
  panel, panelAuth, fmtTime, fmtClock, phoneFromJid,
  type WAChat, type WAMessage, type WAStatus, type WAPresence,
} from "@/lib/panelApi";
import {
  Search, Send, ChevronLeft, Check, CheckCheck, Trash2,
  MessageSquarePlus, X, Loader2, MoreVertical, Circle,
  Phone, PhoneMissed, Reply, Copy, Download,
} from "lucide-react";
import PanelTabs, { PANEL_TAB_KEY } from "./PanelTabs";

const PLACEHOLDER_RE = /^(📷|📹|🎵|📄|🩷|📎)/;

/** Contact/group avatar. Shows the cached WhatsApp profile picture when one is
 *  available, gracefully falling back to the initial letter otherwise. */
function Avatar({ jid, label, hasAvatar, className }: { jid: string; label: string; hasAvatar?: boolean; className: string }) {
  const [err, setErr] = useState(false);
  return (
    <div className={`${className} overflow-hidden flex items-center justify-center shrink-0`}>
      {hasAvatar && !err ? (
        <img src={panel.avatarUrl(jid)} alt="" loading="lazy" className="w-full h-full object-cover" onError={() => setErr(true)} />
      ) : (
        label
      )}
    </div>
  );
}

/** Render the real photo / voice note / video / document for a message. */
const MEDIA_KIND_LABEL: Record<string, string> = {
  image: "Photo", video: "Video", audio: "Voice message",
  sticker: "Sticker", document: "Document",
};
function MediaContent({ msg }: { msg: WAMessage }) {
  if (!msg.hasMedia) {
    // A media message whose bytes never arrived. Fresh media may still be
    // downloading in the background, so show a clear "downloading…" hint first and
    // only flag it as unavailable once the message is clearly old — view-once /
    // expired media is genuinely one-shot and a linked device can't always grab it.
    const stale = Date.now() - msg.ts > 60_000;
    const what = (msg.mediaKind && MEDIA_KIND_LABEL[msg.mediaKind]) || "Media";
    if (msg.mediaKind && stale) {
      return (
        <span className="italic text-muted-foreground break-words">
          🔥 {what} — couldn't load (one-time or expired)
        </span>
      );
    }
    if (msg.mediaKind) {
      return (
        <span className="italic text-muted-foreground break-words">
          ⏳ {what} — downloading…
        </span>
      );
    }
    return <span className="whitespace-pre-wrap break-words">{msg.text}</span>;
  }
  const url = panel.mediaUrl(msg.waMessageId);
  if (msg.mediaKind === "image" || msg.mediaKind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt=""
          loading="lazy"
          className={msg.mediaKind === "sticker" ? "max-w-[140px]" : "rounded-md max-w-full max-h-72 object-cover"}
        />
      </a>
    );
  }
  if (msg.mediaKind === "video") {
    return <video src={url} controls className="rounded-md max-w-full max-h-72" />;
  }
  if (msg.mediaKind === "audio") {
    return <audio src={url} controls className="max-w-[230px]" />;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline break-all">
      📄 {msg.fileName || "Document"}
    </a>
  );
}

const STATUS_LABEL: Record<WAStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  qr_ready: "Scan QR to connect",
  pairing: "Enter pairing code",
  connected: "Connected",
};

export default function Chats() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [chats, setChats] = useState<WAChat[]>([]);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"personal" | "groups">(() => {
    try { return sessionStorage.getItem(PANEL_TAB_KEY) === "groups" ? "groups" : "personal"; }
    catch { return "personal"; }
  });
  const [waStatus, setWaStatus] = useState<WAStatus>("disconnected");
  const [connChecked, setConnChecked] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // A genuine 401 means the token was invalidated (e.g. password changed) — log
  // out. Any other failure (server restart, network blip) is transient: keep the
  // session so the user is NEVER logged out while their authorization is valid.
  const handleAuthError = useCallback((err: any) => {
    if (err?.status === 401) {
      panelAuth.clear();
      navigate("/login");
    }
  }, [navigate]);

  const loadChats = useCallback(() => {
    panel.get("/panel/chats").then((r) => setChats(r || [])).catch(handleAuthError);
  }, [handleAuthError]);

  const loadStatus = useCallback(() => {
    panel.get("/panel/wa/status")
      .then((r) => { setWaStatus(r.status); setConnChecked(true); })
      .catch(handleAuthError);
  }, [handleAuthError]);

  // Keep the latest loaders in refs so the realtime effects below can call them
  // WITHOUT listing them as dependencies. If they were deps, any change in their
  // identity would tear down and reopen the SSE stream every render — which is
  // exactly what made live updates slow (the stream never stayed open long
  // enough to push events, so the panel fell back to the 15s poll).
  const loadChatsRef = useRef(loadChats);
  const loadStatusRef = useRef(loadStatus);
  useEffect(() => {
    loadChatsRef.current = loadChats;
    loadStatusRef.current = loadStatus;
  });

  // A counter bumped on every realtime event; the open Conversation watches it
  // and reloads instantly so a new/deleted message shows without waiting on poll.
  const [liveTick, setLiveTick] = useState(0);
  const [presence, setPresence] = useState<Record<string, WAPresence>>({});

  useEffect(() => {
    if (!user) return;
    loadChatsRef.current();
    loadStatusRef.current();
    // Polling stays as a safety net (much slower now); SSE drives instant updates.
    const t = setInterval(() => {
      loadChatsRef.current();
      loadStatusRef.current();
    }, 15000);
    return () => clearInterval(t);
  }, [user]);

  // INSTANT UPDATES: subscribe to the server's event stream. Any new message,
  // deletion, or connection-state change refreshes the inbox immediately. The
  // browser auto-reconnects the EventSource if the connection drops.
  useEffect(() => {
    if (!user) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        loadChatsRef.current();
        setLiveTick((n) => n + 1);
      }, 250);
    };
    const es = new EventSource(panel.eventsUrl());
    es.addEventListener("message", bump);
    es.addEventListener("delete", bump);
    es.addEventListener("state", () => loadStatusRef.current());
    es.addEventListener("presence", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as WAPresence;
        setPresence((prev) => ({ ...prev, [d.jid]: d }));
      } catch {}
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      es.close();
    };
  }, [user]);

  // Mobile browsers SUSPEND a backgrounded tab's EventSource + timers. Since the
  // user constantly switches between WhatsApp and this panel, the open chat could
  // look stale until the next slow poll. The moment the panel becomes visible
  // again (or regains focus) we refresh the list + open conversation instantly.
  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      loadChatsRef.current();
      loadStatusRef.current();
      setLiveTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [user]);

  // Connect-first (WhatsApp-Web style): until WhatsApp is linked, send the user
  // to the Connect screen. Once linked, Connect sends them back here. We wait for
  // the first real status check (connChecked) to avoid a flash, and never yank
  // the user out of an open conversation.
  useEffect(() => {
    if (!user || !connChecked || activeJid) return;
    if (waStatus !== "connected") navigate("/connect");
  }, [user, connChecked, waStatus, activeJid, navigate]);

  // Make the device/browser BACK button (and the in-app ◀) return to the chat
  // list instead of leaving the panel. We push a history entry when a chat opens
  // and close the chat on popstate.
  useEffect(() => {
    if (!activeJid) return;
    window.history.pushState({ scChat: activeJid }, "");
    const onPop = () => {
      setActiveJid(null);
      loadChats();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [activeJid, loadChats]);

  // Subscribe to the OPEN contact's presence (covert: subscribe-only). Fetch on
  // open + refresh periodically; live changes also arrive over the SSE stream.
  useEffect(() => {
    if (!user || !activeJid) return;
    let alive = true;
    const fetchPresence = () => {
      panel.get(`/panel/chats/${encodeURIComponent(activeJid)}/presence`)
        .then((d) => { if (alive && d) setPresence((p) => ({ ...p, [d.jid]: d })); })
        .catch(() => {});
    };
    fetchPresence();
    const t = setInterval(fetchPresence, 25000);
    return () => { alive = false; clearInterval(t); };
  }, [user, activeJid]);

  const searched = chats.filter(
    (c) =>
      (c.name || "").toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search),
  );
  // Split chats by JID: groups end with "@g.us", personal with "@s.whatsapp.net".
  // Anything else (e.g. status@broadcast) has its own page and is hidden here.
  const personalChats = searched.filter((c) => c.jid.endsWith("@s.whatsapp.net"));
  const groupChats = searched.filter((c) => c.jid.endsWith("@g.us"));
  const visible = tab === "groups" ? groupChats : personalChats;

  if (activeJid) {
    return (
      <Conversation
        jid={activeJid}
        chat={chats.find((c) => c.jid === activeJid)}
        liveTick={liveTick}
        presence={presence[activeJid]}
        onBack={() => {
          // Prefer unwinding the history entry we pushed (so the device back
          // button and this ◀ stay in sync). If for any reason it isn't there,
          // close directly so the button ALWAYS returns to the chat list.
          if (window.history.state?.scChat) window.history.back();
          else {
            setActiveJid(null);
            loadChats();
          }
        }}
      />
    );
  }

  return (
    <Shell title="Chats">
      <div className="flex flex-col h-full">
        {/* Connection banner */}
        {waStatus !== "connected" && (
          <button
            onClick={() => navigate("/connect")}
            className="flex items-center gap-2 px-4 py-2 text-xs bg-accent text-accent-foreground border-b border-border"
          >
            <Circle className="w-2.5 h-2.5 fill-yellow-500 text-yellow-500" />
            {STATUS_LABEL[waStatus]} — tap to connect WhatsApp
          </button>
        )}

        {/* Search */}
        <div className="p-3 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search or start new chat"
              className="w-full rounded-full bg-card border border-border pl-10 pr-4 py-2.5 text-sm outline-none focus:border-primary transition"
            />
          </div>
        </div>

        {/* Top tabs — WhatsApp style: Chats / Groups / Status / Calls */}
        <PanelTabs
          active={tab}
          personalCount={personalChats.length}
          groupCount={groupChats.length}
          onLocalTab={setTab}
        />

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto wa-scroll">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <MessageSquarePlus className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No {tab === "groups" ? "group" : "personal"} chats yet.</p>
              <p className="text-xs mt-1">{tab === "groups" ? "Group chats will appear here." : "Start a new conversation with the button below."}</p>
            </div>
          ) : (
            visible.map((c) => (
              <button
                key={c.jid}
                onClick={() => setActiveJid(c.jid)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition text-left border-b border-border/40"
              >
                <Avatar
                  jid={c.jid}
                  hasAvatar={c.hasAvatar}
                  label={(c.savedName || c.name || c.phone).charAt((c.savedName || c.name) ? 0 : 1).toUpperCase()}
                  className="w-12 h-12 rounded-full bg-primary/20 text-primary font-semibold text-lg"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{c.savedName || c.name || c.phone}</span>
                    <span className={`text-xs shrink-0 ${c.unread ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                      {fmtTime(c.lastMsgTs)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sm text-muted-foreground truncate">{c.lastMsg}</span>
                    {c.unread > 0 && (
                      <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* New chat FAB */}
        <button
          onClick={() => setNewChatOpen(true)}
          className="absolute bottom-6 right-6 w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/30 active:scale-95 transition"
        >
          <MessageSquarePlus className="w-6 h-6" />
        </button>
      </div>

      {newChatOpen && (
        <NewChatSheet
          onClose={() => setNewChatOpen(false)}
          onStart={(jid) => {
            setNewChatOpen(false);
            setActiveJid(jid);
          }}
        />
      )}
    </Shell>
  );
}

function NewChatSheet({ onClose, onStart }: { onClose: () => void; onStart: (jid: string) => void }) {
  const [phone, setPhone] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const clean = phone.replace(/[^0-9]/g, "");
    if (clean.length < 8) {
      setError("Enter a valid number with country code");
      return;
    }
    setBusy(true);
    try {
      await panel.post("/panel/send", { phone: clean, text: text || "Hello" });
      onStart(`${clean}@s.whatsapp.net`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center max-w-md mx-auto">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={start} className="relative w-full bg-card rounded-t-2xl p-5 space-y-4 animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">New Chat</h3>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <label className="text-xs text-muted-foreground">Phone number (with country code)</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 923001234567"
            inputMode="tel"
            className="mt-1 w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">First message</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message"
            className="mt-1 w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <button
          disabled={busy}
          className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Start Chat
        </button>
      </form>
    </div>
  );
}

const QUOTED_KIND_LABEL: Record<string, string> = {
  image: "📷 Photo",
  video: "📹 Video",
  audio: "🎵 Voice message",
  document: "📄 Document",
  sticker: "🩷 Sticker",
};
/** Body of a quoted/reply preview. Always surface the media-kind label
 *  ("📷 Photo" …) when the quoted message was media — followed by its caption
 *  if any — so a reply reads like WhatsApp even when a caption exists. */
function quotedPreview(m: WAMessage): string {
  const kind = m.quotedKind ? QUOTED_KIND_LABEL[m.quotedKind] : "";
  if (m.quotedText) return kind ? `${kind} ${m.quotedText}` : m.quotedText;
  return kind || "Message";
}

/** Short preview of a message used in the reply bar + sent as the quote text. */
function replyPreviewText(m: WAMessage): string {
  if (m.mediaKind && m.mediaKind !== "call") {
    const label = QUOTED_KIND_LABEL[m.mediaKind] || "📎 Media";
    return m.text && !PLACEHOLDER_RE.test(m.text) ? `${label} ${m.text}` : label;
  }
  return m.text || "";
}

function fmtLastSeen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `last seen today at ${time}`;
  if (d.toDateString() === yest.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString()} at ${time}`;
}
/** Human label for a contact's presence in the conversation header (or null). */
function presenceLabel(p?: WAPresence | null): string | null {
  if (!p) return null;
  switch (p.presence) {
    case "available": return "online";
    case "composing": return "typing…";
    case "recording": return "recording audio…";
    // We subscribed but WhatsApp reports the contact offline with no shared
    // last-seen — surface that honestly instead of faking a precise "offline".
    case "unavailable": return p.lastSeen ? fmtLastSeen(p.lastSeen) : "status unavailable";
    default: return "status unavailable";
  }
}

function Conversation({ jid, chat, liveTick, presence, onBack }: { jid: string; chat?: WAChat; liveTick: number; presence?: WAPresence; onBack: () => void }) {
  const [messages, setMessages] = useState<WAMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<WAMessage | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipe = useRef<{ x: number; y: number; el: HTMLElement; fired: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the newest message unless the user has scrolled up to read history.
  const stickBottom = useRef(true);
  const phone = phoneFromJid(jid);
  const title = chat?.savedName || chat?.name || phone;

  const load = useCallback(() => {
    panel.get(`/panel/chats/${encodeURIComponent(jid)}/messages`)
      .then((r) => setMessages(r || []))
      .catch(() => {});
  }, [jid]);

  useEffect(() => {
    load();
    panel.post(`/panel/chats/${encodeURIComponent(jid)}/read`).catch(() => {});
    // Slow poll as a safety net; the live event below drives instant refresh.
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load, jid]);

  // INSTANT UPDATES: reload this conversation the moment the parent receives a
  // realtime event (new/deleted message) so the open chat updates without delay.
  useEffect(() => {
    if (liveTick > 0) load();
  }, [liveTick, load]);

  // Opening a different chat must re-follow its newest message.
  useEffect(() => { stickBottom.current = true; }, [jid]);

  // Track whether the user has scrolled away from the bottom. While they sit at
  // the bottom we keep following new messages; once they scroll up to read old
  // messages we stop auto-scrolling so a refresh never yanks them back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [jid]);

  // Keep the newest message in view like WhatsApp. Jump on open and whenever new
  // messages arrive (unless the user scrolled up). Re-jump a few times because
  // images/videos finish loading AFTER first paint and change the scroll height —
  // that delayed growth is what made a freshly-opened chat appear to start
  // partway up instead of at the latest message.
  useEffect(() => {
    if (messages.length === 0 || !stickBottom.current) return;
    const jump = () => {
      const el = scrollRef.current;
      if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
    };
    jump();
    requestAnimationFrame(jump);
    const timers = [setTimeout(jump, 150), setTimeout(jump, 500), setTimeout(jump, 1000)];
    return () => timers.forEach(clearTimeout);
  }, [messages]);

  // Media (images/videos) load after first paint and grow the page height; keep
  // the view pinned to the bottom while the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onLoad = () => { if (stickBottom.current) el.scrollTop = el.scrollHeight; };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
  }, [jid]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setText("");
    const rt = replyTo;
    setReplyTo(null);
    try {
      const payload: Record<string, unknown> = { phone: phone.replace("+", ""), text: body };
      if (rt) {
        payload.quotedId = rt.waMessageId;
        payload.quotedFromMe = rt.fromMe;
        payload.quotedText = replyPreviewText(rt);
      }
      await panel.post("/panel/send", payload);
      load();
    } catch {
      setText(body);
      if (rt) setReplyTo(rt);
    } finally {
      setSending(false);
    }
  }

  async function del(msg: WAMessage) {
    setMenuFor(null);
    try {
      // fromMe must reach the backend so Baileys builds the correct delete key —
      // delete-for-everyone only ever applies to our own sent messages.
      await panel.del(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}?fromMe=${msg.fromMe ? "true" : "false"}`);
      load();
    } catch {}
  }

  // Local "delete for me": hides the message from THIS panel only (kept on the
  // server for anti-delete / backup). Works on any message, sent or received.
  async function hide(msg: WAMessage) {
    setMenuFor(null);
    setMessages((prev) => prev.filter((x) => x.waMessageId !== msg.waMessageId));
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/messages/${encodeURIComponent(msg.waMessageId)}/hide`);
    } catch {
      load();
    }
  }

  // Long-press (touch) opens the per-message action menu; a quick tap cancels the
  // timer so media controls and links still work normally.
  function startPress(m: WAMessage) {
    if (m.mediaKind === "call") return;
    cancelPress();
    pressTimer.current = setTimeout(() => setMenuFor(m.waMessageId), 450);
  }
  function cancelPress() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  }
  function copyText(m: WAMessage) {
    setMenuFor(null);
    if (m.text) navigator.clipboard?.writeText(m.text).catch(() => {});
  }
  function downloadMedia(m: WAMessage) {
    setMenuFor(null);
    const a = document.createElement("a");
    a.href = panel.mediaUrl(m.waMessageId);
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
  }
  function startReply(m: WAMessage) {
    setMenuFor(null);
    setReplyTo(m);
  }

  // Swipe-right on a bubble = quick reply (the WhatsApp gesture), alongside the
  // long-press menu. We drag the bubble with the finger and, once it passes the
  // threshold, set the reply target. Vertical scrolling is left untouched.
  function onBubbleTouchStart(e: React.TouchEvent<HTMLDivElement>, m: WAMessage) {
    startPress(m);
    if (m.mediaKind === "call") return;
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY, el: e.currentTarget, fired: false };
  }
  function onBubbleTouchMove(e: React.TouchEvent<HTMLDivElement>, m: WAMessage) {
    const s = swipe.current;
    if (!s) { cancelPress(); return; }
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelPress(); // a real drag is not a long-press
    if (dx > 0 && Math.abs(dy) < 40) {
      const shift = Math.min(dx, 72);
      s.el.style.transition = "none";
      s.el.style.transform = `translateX(${shift}px)`;
      if (shift >= 56 && !s.fired) {
        s.fired = true;
        startReply(m);
        navigator.vibrate?.(15);
      }
    }
  }
  function onBubbleTouchEnd() {
    cancelPress();
    const s = swipe.current;
    if (!s) return;
    s.el.style.transition = "transform 0.18s ease";
    s.el.style.transform = "";
    swipe.current = null;
  }

  return (
    <div className="h-[100dvh] bg-background flex flex-col max-w-md mx-auto">
      {/* Conversation header — sidebar hidden, back button shown */}
      <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
        <button onClick={onBack} className="p-1">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <Avatar
          jid={jid}
          hasAvatar={chat?.hasAvatar}
          label={title.charAt(chat?.savedName || chat?.name ? 0 : 1).toUpperCase()}
          className="w-9 h-9 rounded-full bg-white/15 font-semibold text-white"
        />
        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-tight truncate">{title}</p>
          {(() => {
            const status = presenceLabel(presence);
            const online = presence?.presence === "available";
            const typing = presence?.presence === "composing" || presence?.presence === "recording";
            return (
              <p className={`text-xs truncate ${online || typing ? "text-emerald-300" : "text-white/70"}`}>
                {status ?? phone}
              </p>
            );
          })()}
        </div>
        <MoreVertical className="w-5 h-5" />
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto wa-scroll wa-chat-bg px-3 py-4 space-y-1.5">
        {messages.map((m) => (
          <div key={m.waMessageId} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
            <div
              onContextMenu={(e) => { if (m.mediaKind !== "call") { e.preventDefault(); setMenuFor(m.waMessageId); } }}
              onTouchStart={(e) => onBubbleTouchStart(e, m)}
              onTouchMove={(e) => onBubbleTouchMove(e, m)}
              onTouchEnd={onBubbleTouchEnd}
              onTouchCancel={onBubbleTouchEnd}
              className={`relative max-w-[78%] select-none rounded-lg px-3 py-1.5 text-sm shadow-sm ${
                m.fromMe ? "bg-wa-bubble-out text-foreground rounded-tr-none" : "bg-wa-bubble-in text-foreground rounded-tl-none"
              }`}
            >
              {m.mediaKind === "call" ? (
                (() => {
                  const missed = /missed|declined/i.test(m.text);
                  // Direction can't be determined on a companion device, so use a
                  // neutral phone icon (red only for missed/declined).
                  const Icon = missed ? PhoneMissed : Phone;
                  return (
                    <span className={`flex items-center gap-2 py-0.5 ${missed ? "text-red-500" : ""}`}>
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{m.text.replace(/^📞\s*/, "")}</span>
                    </span>
                  );
                })()
              ) : (
                <>
                  {/* ANTI-DELETE: keep the original content visible for monitoring
                      and just flag that the sender deleted it for everyone. */}
                  {m.deleted && (
                    <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-red-500">
                      <Trash2 className="w-3 h-3" /> Deleted by sender
                    </div>
                  )}
                  {(m.quotedText || m.quotedKind) && (
                    <div className="mb-1 flex flex-col overflow-hidden rounded border-l-[3px] border-primary bg-black/10 px-2 py-1">
                      {m.quotedSender && (
                        <span className="truncate text-[11px] font-semibold leading-tight text-primary">
                          {m.quotedSender}
                        </span>
                      )}
                      <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                        {quotedPreview(m)}
                      </span>
                    </div>
                  )}
                  {m.mediaKind ? (
                    <div className="space-y-1">
                      <MediaContent msg={m} />
                      {!PLACEHOLDER_RE.test(m.text) && (
                        <span className="whitespace-pre-wrap break-words block">{m.text}</span>
                      )}
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  )}
                </>
              )}
              <span className="float-right ml-2 mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground translate-y-0.5">
                {fmtClock(m.ts)}
                {m.fromMe && !m.deleted && (
                  // Baileys status: 2=sent, 3=delivered, 4=read, 5=played. Blue
                  // double-tick ONLY once actually read (>=4); delivered (3) is a
                  // grey double-tick; sent/pending stays a single grey tick.
                  m.status >= 4 ? <CheckCheck className="w-3.5 h-3.5 text-sky-400" /> :
                  m.status === 3 ? <CheckCheck className="w-3.5 h-3.5" /> :
                  <Check className="w-3.5 h-3.5" />
                )}
              </span>
              {menuFor === m.waMessageId && (
                <div
                  className={`absolute -top-2 ${m.fromMe ? "right-0" : "left-0"} translate-y-[-100%] z-50 min-w-[150px] overflow-hidden rounded-xl border border-border bg-popover shadow-xl`}
                >
                  <button onClick={() => startReply(m)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs hover:bg-accent">
                    <Reply className="w-4 h-4 text-primary" /> Reply
                  </button>
                  {m.text && !PLACEHOLDER_RE.test(m.text) && (
                    <button onClick={() => copyText(m)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs hover:bg-accent">
                      <Copy className="w-4 h-4 text-primary" /> Copy
                    </button>
                  )}
                  {m.hasMedia && (
                    <button onClick={() => downloadMedia(m)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs hover:bg-accent">
                      <Download className="w-4 h-4 text-primary" /> Download
                    </button>
                  )}
                  <button onClick={() => hide(m)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs hover:bg-accent">
                    <Trash2 className="w-4 h-4 text-muted-foreground" /> Delete for me
                  </button>
                  {m.fromMe && !m.deleted && (
                    <button onClick={() => del(m)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs text-destructive hover:bg-accent">
                      <Trash2 className="w-4 h-4" /> Delete for everyone
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground mt-10">
            No messages yet. Say hello 👋
          </div>
        )}
      </div>

      {/* Tap anywhere outside an open action menu to dismiss it. */}
      {menuFor && <div className="fixed inset-0 z-40" onClick={() => setMenuFor(null)} />}

      {/* Reply preview bar — shown above the composer when replying to a message. */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 bg-wa-panel shrink-0 border-t border-border">
          <div className="flex-1 min-w-0 border-l-[3px] border-primary pl-2 py-0.5">
            <p className="text-[11px] font-semibold leading-tight text-primary">
              {replyTo.fromMe ? "You" : (chat?.name || phone)}
            </p>
            <p className="truncate text-xs text-muted-foreground">{replyPreviewText(replyTo) || "Message"}</p>
          </div>
          <button type="button" onClick={() => setReplyTo(null)} className="p-1 text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Composer */}
      <form onSubmit={send} className="flex items-center gap-2 p-2 bg-wa-panel shrink-0 border-t border-border">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message"
          className="flex-1 rounded-full bg-background border border-border px-4 py-2.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-50 active:scale-95 transition"
        >
          {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
        </button>
      </form>
    </div>
  );
}
