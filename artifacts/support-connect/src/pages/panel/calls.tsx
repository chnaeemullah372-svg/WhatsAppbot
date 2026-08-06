import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import PanelTabs from "./PanelTabs";
import { panel, panelAuth, fmtTime, type WACallLog } from "@/lib/panelApi";
import { PhoneMissed, Video, Phone, Info } from "lucide-react";

export default function Calls() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [calls, setCalls] = useState<WACallLog[]>([]);
  const [loaded, setLoaded] = useState(false);

  const handleAuthError = useCallback((err: any) => {
    if (err?.status === 401) {
      panelAuth.clear();
      navigate("/login");
    }
  }, [navigate]);

  const load = useCallback(() => {
    panel.get("/panel/calls")
      .then((r) => { setCalls(r || []); setLoaded(true); })
      .catch(handleAuthError);
  }, [handleAuthError]);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [user, load]);

  // Instant updates: refresh the moment a new call notification arrives.
  useEffect(() => {
    if (!user) return;
    const es = new EventSource(panel.eventsUrl());
    es.addEventListener("call", () => load());
    return () => es.close();
  }, [user, load]);

  return (
    <Shell title="Calls">
      <div className="flex flex-col h-full">
        <div className="pt-2 shrink-0">
          <PanelTabs active="calls" />
        </div>
        <div className="flex items-start gap-2 px-4 py-2.5 text-[11px] leading-snug bg-accent/60 text-accent-foreground border-b border-border">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Linked device par har call ka record aata hai (answered / missed / declined),
            lekin incoming/outgoing direction reliable nahi hoti — isliye neutral dikhayi
            jati hai. Duration sirf tab aata hai jab WhatsApp khud bheje.
          </span>
        </div>
        <div className="flex-1 overflow-y-auto wa-scroll">
          {!loaded ? null : calls.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <Phone className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">Abhi koi call record nahi.</p>
              <p className="text-xs mt-1">WhatsApp connect hone par nayi calls yahan dikhengi.</p>
            </div>
          ) : (
            calls.map((c) => <CallRow key={c.id} c={c} />)
          )}
        </div>
      </div>
    </Shell>
  );
}

function fmtDur(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function CallRow({ c }: { c: WACallLog }) {
  const label = c.name || `+${c.phone}`;
  const missed = c.outcome === "missed" || c.outcome === "rejected";
  // Direction (incoming/outgoing) is NOT reliable on a linked/companion device, so we
  // never claim it — neutral phone icon (red only when the call was missed/declined).
  const Icon = missed ? PhoneMissed : Phone;
  const outcomeText =
    c.outcome === "missed" ? "Missed" :
    c.outcome === "rejected" ? "Declined" :
    c.outcome === "accepted" ? "Answered" :
    "Call";
  const initial = (c.name ? label.charAt(0) : (c.phone.charAt(0) || "?")).toUpperCase();
  return (
    <div className="w-full flex items-center gap-3 px-4 py-3 border-b border-border/40">
      <div className="w-12 h-12 rounded-full bg-primary/20 text-primary flex items-center justify-center font-semibold text-lg shrink-0">
        {initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`font-medium truncate ${missed ? "text-destructive" : ""}`}>{label}</span>
          <span className="text-xs text-muted-foreground shrink-0">{fmtTime(c.ts)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-sm text-muted-foreground">
          <Icon className={`w-4 h-4 shrink-0 ${missed ? "text-destructive" : "text-muted-foreground"}`} />
          {c.isVideo && <Video className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">
            {outcomeText} {c.isVideo ? "video call" : "voice call"}
            {c.durationSec != null ? ` · ${fmtDur(c.durationSec)}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
