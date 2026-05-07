// src/routes/trade.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getAllTrades,
  getTradeById,
  createTrade,
  updateTrade,
  deleteTrade,
  reviewTradeController,
} from "../controllers/trade.controller";

const tradeRouter = Router();

tradeRouter.use(authMiddleware);

tradeRouter.get("/", getAllTrades);
tradeRouter.post("/", createTrade);
tradeRouter.post("/:id/review", reviewTradeController); // specific before generic
tradeRouter.get("/:id", getTradeById);
tradeRouter.put("/:id", updateTrade);
tradeRouter.delete("/:id", deleteTrade);

export default tradeRouter;
