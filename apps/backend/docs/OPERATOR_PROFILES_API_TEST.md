# Operator Profiles API — requestlar bilan tekshirish

Backend `http://localhost:4000` da ishlaydi. Barcha API prefiksi: **`/api`**.

---

## 1. Backendni ishga tushirish

```bash
# Loyiha ildizidan
bun run dev:backend
```

Yoki:

```bash
cd apps/backend && bun run dev
```

---

## 2. Token olish (Login)

Operator profillar **Bearer token** talab qiladi. Avval login qiling:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"+998900000000","password":"admin123"}'
```

**Seed** ishlatgan bo‘lsangiz: `+998900000000` / `admin123` (supervisor).

Javobdan `data.accessToken` ni oling va keyingi barcha so‘rovlarda header ga qo‘ying:

```
Authorization: Bearer <accessToken>
```

**Misol (token o‘rniga TOKEN yozing):**

```bash
export TOKEN="javobdagi_accessToken_qiyinisi"
```

---

## 3. Operator profillar — endpoint’lar

| Method | URL | Tavsif |
|--------|-----|--------|
| GET | `/api/operator-profiles/` | Ro‘yxat (pagination) |
| GET | `/api/operator-profiles/{id}` | Bitta profil |
| POST | `/api/operator-profiles/` | Yaratish (faqat supervisor) |
| PATCH | `/api/operator-profiles/{id}` | Yangilash: extension, status (supervisor) |
| DELETE | `/api/operator-profiles/{id}` | Soft delete (supervisor) |

---

## 4. Request misollari (curl)

### Ro‘yxat (List)

```bash
curl -s http://localhost:4000/api/operator-profiles/?page=1&limit=10 \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Bitta profil (Get)

```bash
# ID ni list javobidan yoki create javobidan oling
curl -s http://localhost:4000/api/operator-profiles/<PROFIL_ID> \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Operator profil yaratish (Create)

Avval `users` jadvalida foydalanuvchi bo‘lishi kerak (masalan register orqali). Uning `userId` (UUID) kerak.

```bash
curl -X POST http://localhost:4000/api/operator-profiles/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"userId":"<USER_UUID>","extension":"101"}'
```

**Eslatma:** Create qilganda avtomatik `operator_status_logs` ga birinchi yozuv (status: `offline`) qo‘shiladi.

### Status yangilash (Update)

Holat: `online` | `offline` | `pause` | `busy`. Status o‘zgarganda `operator_status_logs` ga yozuv yoziladi (oldingi log yopiladi, yangisi ochiladi).

```bash
curl -X PATCH http://localhost:4000/api/operator-profiles/<PROFIL_ID> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status":"online"}'
```

Extension ham o‘zgartirish mumkin:

```bash
curl -X PATCH http://localhost:4000/api/operator-profiles/<PROFIL_ID> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"extension":"102","status":"pause"}'
```

### O‘chirish (Soft delete)

```bash
curl -X DELETE http://localhost:4000/api/operator-profiles/<PROFIL_ID> \
  -H "Authorization: Bearer $TOKEN"
```

---

## 5. operator_status_logs ni tekshirish

- **Create:** yangi profil yaratilganda birinchi log (`offline`, `startedAt` = profil yaratilgan vaqt) yoziladi.
- **Update (status):** status o‘zgarganda oldingi ochiq log `endedAt` va `duration` bilan yopiladi, yangi status uchun yangi log qo‘shiladi.

Loglarni ko‘rish uchun DB’dan so‘rang (masalan Drizzle Studio):

```bash
cd apps/backend && bun run db:studio
```

`operator_status_logs` jadvalida `operator_id`, `status`, `started_at`, `ended_at`, `duration` ustunlari bor.

---

## 6. Scalar (OpenAPI) orqali tekshirish

Brauzerda: **http://localhost:4000/reference**

Bu yerda barcha endpoint’larni ko‘rishingiz va “Try it out” bilan request yuborishingiz mumkin. Avval “Authorize” da Bearer token kiriting.
