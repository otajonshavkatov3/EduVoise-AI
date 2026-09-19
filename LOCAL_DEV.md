# Lokal ishga tushirish (Windows)

Bu hujjat loyihani shu mashinada ishga tushirish uchun qilingan sozlamalarni tavsiflaydi.

> ## ⚠️ 2026-08-04 — bu hujjatning ba'zi qismlari eskirgan
>
> AI ovozli qatlam (Asterisk + OpenAI Realtime) qo'shilganda quyidagilar
> **hal qilindi**:
>
> | Eski holat | Hozirgi holat |
> |---|---|
> | Docker Desktop ishga tushmaydi (WSL2 yo'q) | **WSL2 2.7.11 o'rnatildi, Docker 29.6.2 ishlayapti** |
> | WSL2 uchun admin huquqi va reboot kerak | **Reboot kerak bo'lmadi** — `VirtualMachinePlatform` allaqachon yoqilgan edi, zamonaviy WSL2 esa faqat shuni talab qiladi (`Microsoft-Windows-Subsystem-Linux` faqat WSL**1** uchun) |
> | SIP / web-telefon lokal ishlamaydi (FreePBX 192.168.3.59) | **Asterisk 20.6.0 Docker'da ishlayapti**, ext 101 registratsiya qilindi, RTP audio tasdiqlandi |
>
> PostgreSQL va Redis hozircha ham `.localdev/` dan nativ ishlaydi (portlar 5434 / 6380)
> — ular band bo'lgani uchun `docker compose up -d` **hammasini** emas, faqat
> Asterisk'ni ko'taring:
>
> ```powershell
> docker compose up -d asterisk
> ```
>
> To'liq hujjatlar: [`docs/`](docs/) — ayniqsa
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
> [`docs/ASTERISK.md`](docs/ASTERISK.md),
> [`docs/MICROSIP.md`](docs/MICROSIP.md) va
> [`docs/AI_PROVIDER.md`](docs/AI_PROVIDER.md).

## PostgreSQL va Redis nega nativ ishlaydi

Docker endi ishlaydi, lekin `.localdev/` dagi PostgreSQL (5434) va Redis (6380)
allaqachon ma'lumot bilan ishlab turgani uchun ularga tegilmadi. Toza mashinada
`docker compose up -d` butun stack'ni ko'taradi.

## Portlar

Standart portlar bu mashinada band bo'lgani uchun boshqalari tanlangan:

| Servis | Standart | Ishlatilgan | Sabab |
|--------|----------|-------------|-------|
| PostgreSQL | 5432 | **5434** | 5432 va 5433 da boshqa PostgreSQL nusxalari ishlayapti |
| Redis | 6379 | **6380** | 6379 da `aivox-devsvc` Redis'i ishlayapti |
| Backend | 4000 | 4000 | — |
| Frontend | 3000 | **3001+** | 3000 da boshqa Node ilova ishlayapti; Vite avtomatik keyingi bo'sh portni oladi |

> Vite `strictPort` ishlatmaydi, shuning uchun frontend porti o'zgarishi mumkin.
> Ishga tushirilgandan keyin terminaldagi `Local: http://localhost:...` qatoriga qarang.

## Kundalik ishlash

```powershell
# 1. Ma'lumotlar bazasi va Redis'ni ishga tushirish (kompyuter yoqilgandan keyin bir marta)
./scripts/dev-services.ps1 start

# 2. Ikkala ilovani ishga tushirish
bun run dev
```

Servislar holatini ko'rish / to'xtatish:

```powershell
./scripts/dev-services.ps1 status
./scripts/dev-services.ps1 stop
./scripts/dev-services.ps1 restart
```

`.localdev/` ichidagi PostgreSQL va Redis Windows servisi sifatida ro'yxatdan
o'tmagan, shuning uchun **kompyuter o'chirilgandan keyin ular avtomatik
ishga tushmaydi** — `dev-services.ps1 start` ni qayta chaqirish kerak.

## Manzillar

| Nima | URL |
|------|-----|
| Frontend | http://localhost:3001 (yoki terminalda ko'rsatilgan port) |
| Backend API | http://localhost:4000/api |
| OpenAPI JSON | http://localhost:4000/doc |
| Scalar API UI | http://localhost:4000/reference |
| Health check | http://localhost:4000/api/health |

## Kirish ma'lumotlari

`db:seed` yaratgan standart foydalanuvchi:

- **Telefon:** `+998900000000`
- **Parol:** `admin123`
- **Rol:** `supervisor`

## Ma'lumotlar bazasi buyruqlari

```powershell
cd apps/backend
bun run db:migrate   # migratsiyalarni qo'llash
bun run db:seed      # admin foydalanuvchi yaratish
bun run db:studio    # Drizzle Studio
bun run db:reset     # jadvallarni tozalash
```

## Bu sozlash uchun kiritilgan o'zgarishlar

1. **`bcryptjs` qo'shildi** (`apps/backend/package.json`)
   `src/lib/auth/password.ts` `bcryptjs` ni import qiladi, lekin `package.json` da
   nativ `bcrypt` yozilgan edi. Shu sababli `db:seed` va login ishlamas edi:
   `Cannot find package 'bcryptjs'`. Pure-JS variant tanlandi — Windows'da
   nativ build (Visual Studio Build Tools) talab qilmaydi.

   > Eslatma: ishlatilmayotgan nativ `bcrypt` va `@types/bcrypt` hali ham
   > `package.json` da qolgan. Ularni olib tashlash mumkin, lekin men tegmadim.

2. **`.env` yaratildi** — `.env.example` asosida, yuqoridagi portlar bilan.

3. **`.gitignore`** — `.localdev/` va `apps/backend/uploads/` qo'shildi.

4. **`scripts/dev-services.ps1`** — PostgreSQL/Redis'ni boshqarish uchun yangi skript.
   (Mavjud `scripts/setup.sh` bash uchun yozilgan va PowerShell'da ishlamaydi.)

5. **`apps/backend/uploads/call-recordings/`** papkasi yaratildi — yozuvlarni
   yuklash endpointi uchun.

## Ma'lum cheklovlar

### Redis 6+ majburiy

`src/lib/redis.ts` `Bun.RedisClient` ishlatadi, u RESP3 (`HELLO 3`) protokolini
talab qiladi. Redis 5.x bilan `ERR unknown command HELLO` xatosi chiqadi.
Shuning uchun `.localdev/` ga **Redis 8.0.2** o'rnatildi.

### Brauzer telefoni (dashboard'dagi pastdagi o'ng tugma) — HAL QILINDI (2026-08-05)

O'ng pastdagi ko'k telefon tugmasi endi haqiqiy SIP telefon. Ishlashi uchun
qo'shilgan narsalar:

| Qism | Nima qilindi |
|---|---|
| Asterisk | `transport-ws` (SIP-over-WebSocket, `ws://localhost:8088/ws`) |
| Asterisk | WebRTC endpointlari **201-204** (`webrtc=yes`), 101-104 bilan juftlashtirilgan |
| Asterisk | O'z-o'zini imzolagan DTLS sertifikati (entrypoint avtomatik yaratadi) |
| Asterisk | `icesupport=yes` + `[ice_host_candidates] 172.x => 127.0.0.1` — Docker NAT ortida brauzerga audio yetib borishi uchun |
| Dialplan | `_1XX` endi `PJSIP/${EXTEN}&PJSIP/2${EXTEN:1}` — stol telefoni **va** brauzer birga jiringlaydi |
| Frontend | `.env` dagi `VITE_SIP_*` (ext 201), `autoConnect=true` |
| Dialpad | Ichki raqamlar terish tuzatildi (avval `+998` prefiksi majburiy edi, 900 ga qo'ng'iroq qilish imkonsiz edi) + tezkor tugmalar: 900 / 600 / 601 / 101 |

Tekshirilgan: brauzer 201 sifatida registratsiya qiladi, 900 ga qo'ng'iroq
qiladi, AI javob beradi, operatorga uzatiladi, RTP audio 0% yo'qotish bilan
oqadi (`ulaw`, RX 915 / TX 1327 paket).

> **Port:** frontend endi **http://localhost:3010** da (3001 ning IPv4 tomonini
> boshqa loyiha egallagan). `apps/frontend` ichida:
> `bun --env-file=../../.env vite --port 3010`

> **Xavfsizlik:** `VITE_SIP_PASSWORD` brauzer bundle'iga tushadi, ya'ni
> dashboard'ni ochgan har kim ko'radi. Ichki tarmoq uchun maqbul; ko'p
> foydalanuvchili muhitda har bir operatorga backend'dan alohida SIP parol
> berish kerak.

### SIP — HAL QILINDI (2026-08-04)

Avval `sip.config.ts` da FreePBX manzili (`ws://192.168.3.59:8088/ws`,
ext 201, `autoConnect: true`) qat'iy yozilgan edi va cheksiz qayta ulanishga
urinardi. Hozir:

- konfiguratsiya Vite env'dan o'qiladi (`VITE_SIP_WS_URL`, `VITE_SIP_EXTENSION`,
  `VITE_SIP_PASSWORD`, `VITE_SIP_REALM`);
- `autoConnect` standart holatda **false** — hech qanday sahifa o'lik socket'ga
  urinmaydi;
- telefoniya endi Asterisk (Docker, SIP porti **5070**) orqali ishlaydi.

**Operator telefoni uchun MicroSIP tavsiya etiladi** (brauzer emas): brauzerdagi
qo'ng'iroq WebRTC uchun `wss` transport va DTLS sertifikat talab qiladi, va
Docker Desktop NAT ortida ICE ishonchsiz — batafsil
[`docs/ASTERISK.md`](docs/ASTERISK.md).

MicroSIP sozlamalari: `docs/MICROSIP.md`. Server `127.0.0.1:5070`,
login/parol `.env` dagi `SIP_EXT_1xx_PASSWORD`.

Test raqamlari: **900** = AI agent, **600** = echo test, **601** = playback,
**602** = music-on-hold, **700** = voicemail, **101-104** = operatorlar.

### Frontend production build `.env` ni o'qimaydi

`apps/frontend/package.json` dagi `build` skripti `--env-file` siz ishlaydi:

```
"build": "tsc -b && vite build"     // VITE_API_URL undefined bo'ladi
```

`dev` skriptida esa `--env-file=../../.env` bor. Production build qilishdan oldin
buni tuzatish kerak (masalan `bun --env-file=../../.env run vite build`, yoki
`vite.config.ts` ga `envDir: resolve(__dirname, "../..")` qo'shish).
Lokal ishga tushirishga ta'sir qilmagani uchun men o'zgartirmadim.

## Tekshirilgan holat

Quyidagilar haqiqatan ishlayotgani tasdiqlangan:

- `GET /api/health` → `{"status":"ok"}`
- `POST /api/auth/login` → JWT access + refresh token
- `POST /api/auth/refresh` → yangi tokenlar (Redis o'qish/yozish ishlayapti)
- `GET /api/users`, `/contacts`, `/calls`, `/tickets`, `/audit-logs`,
  `/operator-profiles`, `/dashboard/summary`, `/calls/me/stats`,
  `/calls/missed`, `/auth/me` → barchasi `200`
- OpenAPI'da 28 ta route ro'yxatdan o'tgan
- Frontend brauzerda render bo'ladi (login sahifasi), konsolda xato yo'q
