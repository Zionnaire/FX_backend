// src/routes/auth.routes.ts

import { Router } from "express";
import {
  register,
  login,
  refresh,
  logout,
} from "../controllers/auth.controller";
import { authLimiter } from "../middlewares/rateLimiter";
import { authMiddleware } from "../middlewares/auth.middleware";

const authRouter = Router();

authRouter.post("/register", authLimiter, register);
authRouter.post("/login", authLimiter, login);
authRouter.post("/refresh", refresh);
authRouter.post("/logout", authMiddleware, logout);

export default authRouter;
