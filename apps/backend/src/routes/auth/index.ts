import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import {
	changePasswordHandler,
	loginHandler,
	logoutHandler,
	meHandler,
	refreshHandler,
	registerHandler,
} from "./auth.handlers";
import { changePassword, login, logout, me, refresh, register } from "./auth.routes";

const router = createRouter();

router.openapi(login, loginHandler);
router.openapi(refresh, refreshHandler);

router.use(register.path, authMiddleware);
router.openapi(register, registerHandler);

router.use(logout.path, authMiddleware);
router.openapi(logout, logoutHandler);

router.use(changePassword.path, authMiddleware);
router.openapi(changePassword, changePasswordHandler);

router.use(me.path, authMiddleware);
router.openapi(me, meHandler);

export default router;
