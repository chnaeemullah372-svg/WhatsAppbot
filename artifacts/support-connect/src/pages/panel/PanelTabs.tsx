import { useLocation } from "wouter";

/** sessionStorage key remembering the home sub-tab (Chats vs Groups) so tapping
 *  "Groups" from Status/Calls returns to the inbox with Groups selected. */
export const PANEL_TAB_KEY = "panelTab";

const tabCls = (active: boolean) =>
  `flex-1 rounded-full py-1.5 text-xs font-medium transition ${
    active ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-card/70"
  }`;

/** WhatsApp-style top tab bar shared by all four panel views (Chats / Groups /
 *  Status / Calls). Chats and Groups live on the home route ("/") as a local
 *  sub-tab; Status and Calls are their own routes. Rendering this on every view
 *  means the user can always switch tabs without using the browser back button. */
export default function PanelTabs({
  active,
  personalCount,
  groupCount,
  onLocalTab,
}: {
  active: "personal" | "groups" | "status" | "calls";
  personalCount?: number;
  groupCount?: number;
  onLocalTab?: (t: "personal" | "groups") => void;
}) {
  const [, navigate] = useLocation();
  const goHome = (t: "personal" | "groups") => {
    try { sessionStorage.setItem(PANEL_TAB_KEY, t); } catch {}
    if (onLocalTab) onLocalTab(t);
    else navigate("/");
  };
  return (
    <div className="flex gap-1.5 px-3 pb-2 shrink-0">
      <button onClick={() => goHome("personal")} className={tabCls(active === "personal")}>
        Chats{personalCount ? <span className="opacity-70"> ({personalCount})</span> : null}
      </button>
      <button onClick={() => goHome("groups")} className={tabCls(active === "groups")}>
        Groups{groupCount ? <span className="opacity-70"> ({groupCount})</span> : null}
      </button>
      <button onClick={() => navigate("/status")} className={tabCls(active === "status")}>
        Status
      </button>
      <button onClick={() => navigate("/calls")} className={tabCls(active === "calls")}>
        Calls
      </button>
    </div>
  );
}
