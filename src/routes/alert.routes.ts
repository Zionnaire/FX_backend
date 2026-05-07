// src/routes/alert.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  toggleAlert,
} from "../controllers/alert.controller";

const alertRouter = Router();

alertRouter.use(authMiddleware);

alertRouter.get("/", getAlerts);
alertRouter.post("/", createAlert);
alertRouter.put("/:id/toggle", toggleAlert); // specific before generic /:id
alertRouter.put("/:id", updateAlert);
alertRouter.delete("/:id", deleteAlert);

export default alertRouter;
