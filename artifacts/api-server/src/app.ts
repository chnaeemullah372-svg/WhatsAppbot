import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { multiWA } from "./services/multiWhatsapp";
import { startPersistence } from "./services/chatPersistence";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Wire the WhatsApp engine to the DB (persist incoming/outgoing, load saved
// chat history on boot). This is the single source of truth for the panel.
void startPersistence();

// Auto-reconnect the saved WhatsApp session on production boot only. In dev we
// skip this so dev and prod don't fight over the same phone credentials with a
// 440 "Connection Replaced"; the panel's "Fix" button reconnects manually.
if (process.env.NODE_ENV === "production") {
  setTimeout(() => multiWA.autoReconnectSaved(), 3000);
}

export default app;
