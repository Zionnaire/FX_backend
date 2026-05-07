// src/routes/user.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getProfile,
  updateProfile,
  updatePreferences,
} from "../controllers/user.controller";

const userRouter = Router();

userRouter.use(authMiddleware);

userRouter.get("/profile", getProfile);
userRouter.put("/profile", updateProfile);
userRouter.put("/preferences", updatePreferences);

export default userRouter;
