import { Router, type IRouter } from "express";
import healthRouter from "./health";
import saberRouter from "./saber";

const router: IRouter = Router();

router.use(healthRouter);
router.use(saberRouter);

export default router;
