import { createRouter } from "@/lib";
import { authMiddleware } from "@/lib/auth";

import * as h from "./contacts.handlers";
import * as r from "./contacts.routes";

const router = createRouter();
router.use("/*", authMiddleware);

router.openapi(r.list, h.listHandler);
// Hono yo'llarni ro'yxatdan o'tkazish tartibida moslaydi, shuning uchun "/lookup"
// "/{id}" dan OLDIN turishi shart — aks holda literal "lookup" id sifatida
// o'qilib, uuid validatsiyasida 422 bilan tugaydi. Kodning qolgan qismi ham shu
// tartibga amal qiladi (calls, knowledge-base, operator-profiles).
router.openapi(r.lookup, h.lookupHandler);
router.openapi(r.get, h.getHandler);
router.openapi(r.create, h.createHandler);
router.openapi(r.update, h.updateHandler);
router.openapi(r.remove, h.removeHandler);

export default router;
