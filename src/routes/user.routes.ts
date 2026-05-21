// src/routes/user.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getProfile,
  updateProfile,
  updatePreferences,
  updateAutoTrade,
  regenerateApiKey,
} from "../controllers/user.controller";

const userRouter = Router();

userRouter.use(authMiddleware);

userRouter.get("/profile", getProfile);
userRouter.put("/profile", updateProfile);
userRouter.put("/preferences", updatePreferences);
userRouter.put("/autotrade", updateAutoTrade);
userRouter.post("/autotrade/apikey", regenerateApiKey);

export default userRouter;
