import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, applyWallpaper } from "@/lib/theme";

applyTheme();
applyWallpaper();

createRoot(document.getElementById("root")!).render(<App />);
