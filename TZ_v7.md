# Murojaatlarga avtomatik javob beruvchi AI platforma
## Texnik topshiriq v7.0 — Oliy ta'lim, fan va innovatsiyalar vazirligi yo'nalishi

| | |
|---|---|
| Hujjat | Amaldagi tizim tavsifi, kod asosida tuzilgan (2026-09-18) |
| Yo'nalish | O'zbekiston Respublikasi Oliy ta'lim, fan va innovatsiyalar vazirligiga kelib tushadigan fuqarolar murojaatlari |
| Asos | CallCenter "Aqlli Shahar" platformasi (multi-tenant CRM + AI ovozli agent). `TZ.md` v6.0 — dastlabki talablar, tarix uchun |
| Batafsil | `docs/` — ARCHITECTURE, ASTERISK, AI_PROVIDER, API, DEPLOYMENT, TROUBLESHOOTING |

---

## 1. Maqsad va doira

- **Maqsad:** murojaatlarni 24/7 avtomatik qabul qilish. Tizim:
  - savolga faqat tasdiqlangan bilim bazasidan javob beradi;
  - murojaatni ro'yxatga oladi va toifalaydi;
  - uni mas'ul bo'limga yo'naltiradi;
  - kerak bo'lsa jonli operatorga ulaydi.
- **Ishlayotgan kanal:** telefon. Uch yo'l bor:
  - SIP trunk (shahar raqami);
  - ichki raqamlar;
  - dashboard ichidagi brauzer telefoni (WebRTC).
- **Hali yo'q** (§15): matnli onlayn kanallar — Telegram bot, sayt chat, e-mail, davlat portallari bilan integratsiya.
- **Foydalanuvchilar:**
  - fuqaro (qo'ng'iroq qiladi);
  - vazirlik operatorlari va rahbarlari (dashboard bilan ishlaydi);
  - platforma egasi (vendor).

## 2. Texnologiyalar

| Qism | Tanlov |
|---|---|
| Monorepo | Bun workspaces: `apps/backend`, `apps/frontend`, `shared` |
| Backend | Bun 1.x, Hono 4.11 + `@hono/zod-openapi`, Drizzle ORM 0.45, zod 4, pino |
| Frontend | React 19, Vite 7, Ant Design 6, Tailwind 4, Zustand 5, TanStack Query 5, sip.js 0.21 |
| Ma'lumotlar | PostgreSQL 17 (26 jadval, 15 migratsiya); Redis ≥ 6 (refresh tokenlar) |
| Telefoniya | Asterisk 20.6 (Docker): PJSIP, ARI, AMI, AudioSocket, MixMonitor |
| AI (ovoz) | Gemini Live (asosiy), OpenAI Realtime (muqobil), fallback IVR |
| AI (tahlil) | OpenAI `gpt-4o-mini` — qo'ng'iroqdan keyingi xulosa, kayfiyat, kategoriya |
| Auth | JWT HS256: access 15 daqiqa, refresh 7 kun (Redis'da, har safar almashadi); bcryptjs 12 |
| Deploy | Docker Compose, nginx + Let's Encrypt, ufw, fail2ban, Prometheus/Grafana |
| Hajm | Backend ≈ 68k qator, frontend ≈ 39k, testlar ≈ 7,7k; 125 ta API endpoint |

## 3. Rollar

| Rol | Nima qila oladi |
|---|---|
| supervisor (Nazoratchi) | Tenant ichida eng yuqori rol. **Faqat supervisor** sozlamalar, AI konfiguratsiyasi va operator profillarini o'zgartiradi |
| admin | Barcha ma'lumotlarni ko'radi. Foydalanuvchilar, hisobotlar, AI xarajatlari, kampaniyalar va bilim bazasini boshqaradi |
| manager (Menejer) | Operator darajasi: faqat o'z qo'ng'iroqlari va murojaatlarini ko'radi. Kontakt, murojaat, vazifa va uchrashuv yarata oladi |
| vendor (Platforma egasi) | Barcha tenantlar ro'yxatini ko'radi. Mijoz tenantiga 30 daqiqalik token bilan kira oladi; har bir so'rovi auditga yoziladi |

"Operator" alohida rol emas. Operator — ichki raqami bor (operator profili bor) foydalanuvchi.

## 4. Dashboard bo'limlari

| Bo'lim | Vazifasi |
|---|---|
| Asosiy oyna | KPI (kun/hafta/oy), qo'ng'iroqlar hajmi, kayfiyat, kategoriyalar, operatorlar yuklamasi |
| Qo'ng'iroqlar | Jonli qo'ng'iroqlar paneli (transkript real vaqtda) va tarix. Qo'ng'iroq kartasida: yozuv, transkript, AI tahlili, xarajat |
| Javobsiz qo'ng'iroqlar | Javob berilmagan qo'ng'iroqlar, CSV eksport |
| Chiquvchi kampaniyalar | AI orqali ommaviy qo'ng'iroq: lidlar importi, "qo'ng'iroq qilinmasin" ro'yxati, qayta urinishlar |
| Kontaktlar | Fuqarolar bazasi (telefon raqam tenant ichida yagona), qo'ng'iroq va murojaatlar tarixi |
| Murojaatlar | Ticketlar: holat, prioritet, kategoriya, AI xulosasi |
| Keyingi aloqa vazifalari / Uchrashuvlar | Vazifalar (jadval va kanban ko'rinishi) va kalendar |
| AI yordamchi | Holat va sozlamalar, **Biznes profili**, **Bilim bazasi**, sessiyalar |
| AI xarajatlari, Hisobotlar | Tokenlar va narx (USD/so'm); Excel/CSV hisobotlar (faqat admin/supervisor) |
| Operatorlar, Foydalanuvchilar, Audit, Sozlamalar | Boshqaruv bo'limlari (Telegram bildirishnomalari, narxlar va boshqalar) |

## 5. AI agent — vazirlik sozlamasi

**Profil.** Kod: `apps/backend/src/db/seed-data/ministry-profile.ts`. Bazada faol profil sifatida saqlanadi.

| Maydon | Qiymat |
|---|---|
| Nomi | Oliy ta'lim, fan va innovatsiyalar vazirligi |
| Salomlashuv | "Assalomu alaykum! Oliy ta'lim, fan va innovatsiyalar vazirligining virtual yordamchisiman. Suhbat yozib olinadi. Qanday yordam bera olaman?" |
| Tillar | o'zbek (asosiy), rus, ingliz |
| Ovoz | Achird (Gemini) |
| Javob topilmasa | `take_message` — savol murojaat sifatida ro'yxatga olinadi |
| Operatorlar | 101–104. Fuqaro so'rasa yoki masala shoshilinch bo'lsa uzatiladi |
| Ish vaqti | 24/7; bitta qo'ng'iroq ko'pi bilan 15 daqiqa |

**Kategoriyalar (14):**
- Qabul
- Ko'chirish va tiklash
- Kontrakt to'lovi va imtiyozlar
- Stipendiya va ta'lim krediti
- Talabalar turar joyi
- Diplom va hujjatlar
- Xorijiy diplomni tan olish
- Magistratura va doktorantura
- Ilmiy faoliyat va grantlar
- Innovatsiya va startaplar
- OTM ustidan shikoyat
- Korrupsiya haqida xabar
- Taklif
- Boshqa

**AI xulq qoidalari:**
- Murojaat uchun quyidagilarni bittadan so'rab aniqlaydi: F.I.Sh., hudud, OTM nomi, murojaat mazmuni. Raqam bazada bo'lsa, ismni qayta so'ramaydi.
- Natijani hech qachon va'da qilmaydi (ko'chirish, grant, imtiyoz va hokazo). Huquqiy maslahat bermaydi.
- Pasport, JShShIR, karta raqami, parol yoki SMS kodni so'ramaydi.
- Bilim bazasida yo'q sana, summa, ball, telefon raqami yoki manzilni aytmaydi — savolni murojaat qilib yozib oladi.
- Korrupsiya haqidagi xabarni alohida kategoriyada qayd etadi.
- Hayotga xavf bo'lsa, 102 yoki 103 raqamiga yo'naltiradi.
- Siyosiy mavzularga aralashmaydi.
- "Robotmisiz?" deb so'rashsa, virtual yordamchi ekanini ochiq aytadi.

**Bilim bazasi.** Kod: `seed-data/ministry-knowledge.ts`, 28 ta yozuv.
- Prioriteti eng yuqori 12 tasi qo'ng'iroq boshidanoq promptda turadi.
- Qolganlarini AI `search_knowledge_base` tool'i orqali qidiradi. Qidiruv o'zbek/rus qo'shimchalarini kesadi va regex bilan baholaydi (embedding ishlatilmaydi).
- Qo'llash: `bun run db:seed:ministry`. AviLab'ga qaytarish: `bun run db:seed:ai`.
- Tahrirlash: dashboard → AI yordamchi → Biznes profili / Bilim bazasi (faqat supervisor).

> **Tasdiqlash kerak:** murojaatni ko'rib chiqish muddati bo'yicha yozuv (15 kun / 1 oygacha), vazirlikning rasmiy telefoni, manzili, sayti va qabul kunlari. Oxirgi to'rttasi ataylab kiritilmagan — AI ularni o'ylab topmasligi kerak.

## 6. Arxitektura

```
 Telefon / SIP trunk / MicroSIP        Brauzer: React SPA + sip.js (WebRTC)
       │ SIP 5070, RTP 12000-12049          │ HTTPS /api, WS /api/ws      │ SIP-over-WS :8088/ws
       ▼                                     ▼                             ▼
 ┌────────────────┐  ARI (HTTP+WS 8088)  ┌───────────────────┐
 │ Asterisk 20    │◄────────────────────►│ Backend (Bun)     │◄──► PostgreSQL 17
 │ (Docker)       │  AMI (TCP 5038)      │ API :4000         │◄──► Redis
 │ MixMonitor→wav │─────────────────────►│ AudioSocket :9092 │◄──► Gemini Live / OpenAI (WSS)
 └────────────────┘  AudioSocket (TCP)   └───────────────────┘
```

- **Portlar:**
  - 5070 — SIP (5060 emas, MicroSIP bilan to'qnashmasligi uchun);
  - 12000–12049 — RTP (host va konteyner porti bir xil bo'lishi shart);
  - 8088 (ARI) va 5038 (AMI) — faqat `127.0.0.1`;
  - 9092 — AudioSocket: backend tinglaydi, Asterisk o'zi ulanadi.
- **Backend `src/lib`:**
  - `asterisk/` — ARI/AMI klientlar va per-tenant config;
  - `ai/` — AudioSocket, kodek, provayderlar, tool'lar, promptlar;
  - `telephony/` — `call-orchestrator` (qo'ng'iroq holat mashinasi), `crm-writer`, operatorga uzatish;
  - `tenancy/` — tenant izolyatsiyasi;
  - `ws/` — dashboard'ga real vaqt eventlari.

## 7. Murojaat (qo'ng'iroq) oqimi

1. Qo'ng'iroq keladi va dialplan uni `Stasis(callcenter-ai, tenant=<slug>)` orqali backend'ga topshiradi.
2. Backend:
   - tenant'ni aniqlaydi;
   - kontaktni topadi yoki yaratadi;
   - `calls` qatorini yaratadi (id = UUID);
   - javob beradi va `ai_sessions` ochadi;
   - tenant'ning AI profili va bilim bazasini yuklaydi.
3. Kanal `ai-bridge` kontekstiga o'tadi. `MixMonitor` yozishni boshlaydi (`<tenant>/<callId>.wav`), keyin `AudioSocket` backend'ga TCP orqali ulanadi. Birinchi paket = `calls.id`, shuning uchun audio darhol CRM qatoriga bog'lanadi.
4. Audio 20 ms freymlarda, 8 kHz'da uzatiladi. Gemini javobi 24 kHz'da keladi va 8 kHz'ga pasaytiriladi; OpenAI'da resampling yo'q (μ-law).
5. Suhbat davomida:
   - transkript yoziladi;
   - tool chaqiruvlari bajariladi — `search_knowledge_base`, `save_contact_details`, `create_ticket`, `add_note`, `create_follow_up`, `book_appointment`, `transfer_to_human`, `end_call` (kampaniyada qo'shimcha `record_call_outcome`);
   - dashboard'ga `live_call_*` eventlari yuboriladi.
6. **Operatorga uzatish:**
   - kanal Stasis'da bo'lsa — ARI bridge orqali;
   - kanal AudioSocket ichida bo'lsa — AMI `Redirect` orqali;
   - uzatishda stol telefoni (1XX) va brauzer telefoni (2XX) birga jiringlaydi.
7. **Yakunlash:** 4 ta signaldan istalgani keladi, qayta ishlash idempotent. Qo'ng'iroq yakunlanadi, yozuv va tokenlar saqlanadi, keyin `gpt-4o-mini` tahlil qiladi → `ai_analyses` va murojaatdagi AI maydonlari to'ldiriladi.

O'lchov (lokal, 2026-09-18): `calls` qatori yaratilgandan Gemini sessiyasi tayyor bo'lguncha ≈ 1,3 s ketdi. Hujjatlarga ko'ra birinchi audio 0,73–0,88 s'da chiqadi.

## 8. AI provayderlari

| Shart | Provayder |
|---|---|
| `AI_AGENT_ENABLED=false` | fallback IVR |
| `AI_VOICE_PROVIDER=gemini` + Google kaliti | Gemini Live (o'zbek tilida eng yaxshi natija) |
| OpenAI kaliti bor | OpenAI Realtime (faqat GA protokoli; `OpenAI-Beta` header yuborilsa rad etiladi) |
| Aks holda / provayder ishga tushmasa | fallback IVR: pullik API'siz, ~1,5 s'dan keyin operatorga uzatadi |

Asosiy qoida: **qo'ng'iroq qiluvchi hech qachon jimlikda qolmaydi.**

## 9. Multi-tenant

- **Tenant qayerdan aniqlanadi:** HTTP'da JWT'dagi `tid` dan (login paytida foydalanuvchi qatoridan olinadi); qo'ng'iroqda Stasis argumenti, kontekst yoki endpoint nomidan.
- **Izolyatsiya:**
  - 25 ta jadvalda `tenant_id NOT NULL`;
  - `tenantWhere()` so'rovga tenant shartini birinchi qo'yadi;
  - boshqa tenant qatoriga so'rov 404 qaytaradi;
  - keshlar va WS eventlari tenant bo'yicha ajratilgan.
- **Asterisk nomlari:** endpoint `<slug>-<ext>`, kontekst `from-internal-<slug>`, yozuvlar `recordings/<slug>/`. Configni backend yaratadi va AMI orqali qayta yuklaydi (hozircha faqat backend ishga tushganda).
- **Vendor:** alohida tenant (`is_vendor`). Mijoz tenantiga impersonation token bilan kiradi, har bir amali auditga yoziladi.

## 10. Ma'lumotlar bazasi (26 jadval, 21 enum)

| Guruh | Jadvallar |
|---|---|
| Tenant va foydalanuvchilar | `tenants`, `users`, `operator_profiles`, `operator_status_logs`, `audit_logs`, `system_settings` |
| CRM | `contacts`, `tickets`, `call_notes`, `follow_up_tasks`, `bookings` |
| Qo'ng'iroq va AI | `calls`, `ai_sessions` (qo'ng'iroq boshiga bitta), `call_transcripts`, `call_recordings`, `call_transfers`, `ai_analyses`, `sip_extensions` |
| AI sozlamasi | `ai_agent_profiles` (tenant boshiga bitta faol), `knowledge_base_entries` |
| Kampaniyalar | `call_campaigns`, `campaign_leads`, `campaign_call_attempts`, `do_not_call_list` |
| Ishlatilmaydi | `refresh_tokens`, `user_sessions` (tokenlar Redis'da) |

## 11. API

- **Ko'lam:** `/api` ostida 26 guruh, 125 endpoint. OpenAPI: `/doc`, Scalar UI: `/reference`.
- **Javob formati:** `{success, data}` yoki `{success:false, error:{code, message}}`.
- **Sahifalash:** `page`, `limit` (≤ 100).
- **Asosiy guruhlar:**

| Guruh | Mazmuni |
|---|---|
| auth, users, audit-logs | Login/refresh/logout, foydalanuvchilar, audit |
| calls, live-calls, transcripts, ai-analyses | Qo'ng'iroqlar, jonli panel, transkript, tahlil |
| contacts, tickets, follow-ups, bookings | CRM |
| ai-agent, knowledge-base, ai-assistant, ai-costs | Profil, bilim bazasi, AI holati/sozlamasi, xarajat |
| asterisk, operator-profiles | Click-to-call, uzatish, uzish, ichki raqamlar, SIP hisob |
| campaigns, reports, settings, dashboard | Kampaniyalar, Excel hisobotlar, sozlamalar, KPI |
| vendor, webhooks, uploads, ws, health | Platforma egasi, legacy FreePBX, yozuvlar, WebSocket |

## 12. Xavfsizlik

- **Bor:**
  - JWT va rol tekshiruvi (middleware);
  - tenant izolyatsiyasi (testlar bilan tasdiqlangan);
  - bcrypt;
  - ARI/AMI faqat loopback'da;
  - prod'da nginx rate limit (login 5/daq, API 30/s), CSP/HSTS, ufw + DOCKER-USER, fail2ban;
  - AI argumentlari zod bilan tekshiriladi;
  - vendor kirishlari auditga yoziladi.
- **Zaif joylar:**
  - CORS `*`;
  - yozuvlar URL orqali autentifikatsiyasiz ochiladi (UUID nomi va tenant papkasi faqat taxmin qilishni qiyinlashtiradi);
  - WS tokeni query string'da uzatiladi;
  - `POST /asterisk/transfer` rolni tekshirmaydi;
  - refresh tokenlar Redis'da ochiq holda saqlanadi;
  - o'chirilgan foydalanuvchi access token muddati (≤ 15 daqiqa) tugaguncha ishlay oladi;
  - admin o'ziga supervisor rolini bera oladi.
- **Sirlar:** `.env` da haqiqiy API kalitlar bor. **Loyihani boshqaga berishdan oldin `.env` ni olib tashlang va kalitlarni almashtiring.**

## 13. Ishga tushirish

**Lokal (Windows 11):** Bun, Docker Desktop (WSL2) va `.localdev/` dagi PostgreSQL/Redis kerak.

```bash
bun install
powershell -ExecutionPolicy Bypass -File .\scripts\dev-services.ps1 start   # PostgreSQL 5434, Redis 6380
docker compose up -d asterisk
cd apps/backend && bun run db:migrate && bun run db:seed && bun run db:seed:sip && bun run db:seed:ai && bun run db:seed:vendor && bun run db:seed:ministry && cd ../..   # birinchi marta
bun run dev                                                               # backend :4000, frontend :3000
```

**Test hisoblar (faqat dev):**
- supervisor: `+998900000000` / `admin123`
- operatorlar 101–104: `+998900000101…104` / `avilab123`
- vendor: `+998900000001` / `vendor123`

**Qo'ng'iroqni sinash:**
1. Operator bo'lib kiring va holatni "online" qiling.
2. Pastki o'ng burchakdagi telefonni oching.
3. Raqam tering: **900** — AI, 600 — echo.

Chrome yoki Edge'dan foydalaning: ichki (embedded) brauzerlar mikrofonni bloklaydi.

**Production (Ubuntu 24.04):**
- `scripts/deploy.sh` — birinchi o'rnatish. U Docker, TLS, ufw, fail2ban, cron backup va compose'ni sozlaydi.
- `scripts/update.sh` — keyingi yangilanishlar: migratsiyadan oldin DB dump oladi, smoke test o'tkazadi, xato bo'lsa rollback qiladi.

## 14. Monitoring, backup, sig'im, testlar

- **Monitoring:** Prometheus + Grafana, 33 ta alert. Lekin backend `/metrics` bermaydi, shuning uchun biznes alertlari jim; Alertmanager yo'q.
- **Backup:** har kuni 02:15 da `pg_dump` olinadi va tiklab tekshiriladi; yozuvlar rsync qilinadi. DB 30 kun, yozuvlar 90 kun saqlanadi. RTO 4 soat, RPO 24 soat. Nusxa boshqa serverga ko'chirilmaydi.
- **Sig'im:** Docker Desktop'da ≈ 25 parallel qo'ng'iroq (RTP 50 port). Linux'da diapazon kengaytiriladi. Yozuv ≈ 1 MB/daqiqa.
- **Testlar:**
  - 15 ta integratsion test (asosan tenant izolyatsiyasi, API mosligi, ARI, dialer);
  - 37 ta backend unit test;
  - `tests/e2e/run-verification.ts` — 29 ta tekshiruv;
  - frontend testi, CI/CD yo'q; sifat Biome + husky + commitlint bilan nazorat qilinadi.

## 15. Ma'lum muammolar va yo'l xaritasi

| # | Muammo / vazifa | Muhimlik |
|---|---|---|
| 1 | **Matnli kanallar yo'q** (Telegram, sayt chat, e-mail, davlat portallari) — vazirlik yo'nalishi uchun asosiy keyingi ish | Yuqori |
| 2 | Bilim bazasiga vazirlikning rasmiy ma'lumotlari (kontaktlar, muddatlar, tartiblar) kiritilishi va tasdiqlanishi kerak | Yuqori |
| 3 | Brauzer telefoni prod'ga tayyor emas: WSS yo'q, nginx SIP-WS'ni proksilamaydi, `VITE_SIP_WS_URL` sozlanmaydi | Yuqori |
| 4 | Yangi serverda Asterisk ishga tushmaydi: `SIP_WEBRTC_201–204_PASSWORD` `.env.example` va `deploy.sh` da yo'q | Yuqori |
| 5 | Bildirishnoma monitori 2+ tenant bo'lsa ishlamaydi (`getSoleTenantId`). Lokal bazada test tenant qolgan | O'rta |
| 6 | Tenant boshqaruvi uchun API yo'q; Asterisk config faqat backend ishga tushganda yangilanadi | O'rta |
| 7 | `/metrics`, Alertmanager, off-host backup yo'q | O'rta |
| 8 | §12 dagi xavfsizlik zaif joylari; bir vaqtdagi refresh so'rovlari foydalanuvchini tizimdan chiqarib yuborishi mumkin | O'rta |
| 9 | Ish vaqti server vaqtida hisoblanadi; hisobotlarda `Asia/Tashkent` qat'iy yozilgan | Past |

## 16. Mentor savollari — qisqa javoblar

| Savol | Javob |
|---|---|
| Nega Bun? | TS'ni build'siz ishga tushiradi, ichida WebSocket/Redis/SQL bor, tez; bitta runtime |
| Nega Asterisk, FreePBX emas? | ARI/AMI/AudioSocket orqali to'liq dasturiy boshqaruv, config-as-code, Docker'da ishlaydi, tenant configini generatsiya qilish mumkin |
| AI qo'ng'iroq qiluvchini qanday eshitadi? | Asterisk AudioSocket orqali backend'ga TCP ulanadi, 20 ms'lik 8 kHz freymlar yuboradi; backend ularni Gemini'ga uzatadi va javob ovozini qaytaradi |
| Nega AudioSocket, `externalMedia` emas? | TCP va Asterisk o'zi ulanadi: Docker NAT'da UDP qaytish yo'li muammosi yo'q, bitta port barcha qo'ng'iroqlarga yetadi |
| Nega `calls.id` = AudioSocket UUID? | Qo'shimcha jadval ham, race ham yo'q; yozuv fayli o'z-o'zidan `<callId>.wav` nomini oladi |
| Nega Gemini? | O'zbek tilida sifat eng yaxshi, birinchi audio ≈ 0,8 s. OpenAI'ga `.env` dagi bitta qator bilan o'tiladi |
| AI yolg'on gapirmaydimi? | Fakt faqat bilim bazasidan olinadi; javob topilmasa savol murojaat sifatida yoziladi; CRM'ga faqat tool'lar orqali, zod tekshiruvidan keyin yoziladi |
| AI ishlamasa-chi? | Fallback IVR operatorga uzatadi — qo'ng'iroq qiluvchi jimlikda qolmaydi |
| Murojaat qayerga tushadi? | `tickets` jadvaliga (kategoriya, AI xulosasi, kayfiyat bilan); dashboard → Murojaatlar |
| Tenantlar qanday ajratilgan? | JWT `tid`, har so'rovda tenant filtri, Asterisk nomlarida slug, yozuvlar tenant papkasida; testlar bilan tekshirilgan |
| Real vaqt qanday ishlaydi? | `/api/ws` WebSocket: `live_call_*` eventlari supervisor/admin va qo'ng'iroq egasi operatorga boradi |
| Nechta parallel qo'ng'iroq? | Hozir ≈ 25 (Docker Desktop'dagi RTP cheklovi); Linux'da ko'proq. Keyingi cheklovlar: CPU va AI provayder limitlari |
| Bitta qo'ng'iroq narxi? | Tokenlar `ai_sessions` ga yoziladi, narx sozlamalardagi tariflardan hisoblanadi → "AI xarajatlari" sahifasi |
| Eng katta texnik qarz? | §15: matnli kanallar, prod WebRTC, `/metrics`, off-host backup, xavfsizlik zaif joylari |

## 17. Atamalar

| Atama | Ma'nosi |
|---|---|
| SIP / RTP | Qo'ng'iroqni boshqarish protokoli / ovoz oqimi |
| ARI / AMI | Asterisk'ni koddan boshqarish uchun REST+WebSocket / TCP interfeyslari |
| Stasis | Kanalni backend ilovasiga topshiradigan dialplan buyrug'i |
| AudioSocket | Kanal ovozini TCP orqali tashqi dasturga uzatish protokoli |
| MixMonitor | Qo'ng'iroqni yozib olish |
| Tenant / slug | Platformadagi mijoz / uning texnik nomi (hozir `avilab`) |
| Bilim bazasi | AI aytishi mumkin bo'lgan yagona faktlar ro'yxati |
| Fallback IVR | AI ishlamaganda operatorga uzatuvchi zaxira rejim |
