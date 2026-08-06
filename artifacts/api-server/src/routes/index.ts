import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";
import adminRouter from "./admin";
import mediaRouter from "./media";
import userWhatsappRouter from "./userWhatsapp";
import captureRouter from "./capture";
import panelRouter from "./panel";
import adminPanelRouter from "./adminPanel";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);
router.use(adminRouter);
router.use(mediaRouter);
router.use(userWhatsappRouter);
router.use(captureRouter);
router.use(panelRouter);
router.use(adminPanelRouter);

export default router;
