# CallCenter "Aqlli Shahar" – To'liq Texnik Topshiriq (TZ v6.0)

---

## 1. LOYIHA PASPORTI

| Parametr              | Qiymat                               |
| --------------------- | ------------------------------------ |
| **Loyiha nomi**       | CallCenter "Aqlli Shahar"            |
| **Buyurtmachi**       | Aqlli Shahar                         |
| **Integratsiya**      | call.mnazorat.uz                     |
| **Telefonya**         | FreePBX (Statik IP)                  |
| **Yozuvlar saqlash**  | FreePBX Local Storage                |
| **AI Integratsiyasi** | REST API (Speech-to-Text + Analysis) |
| **Backend Stack**     | Bun.js + HonoJS                      |
| **Database**          | PostgreSQL + Drizzle ORM             |
| **Cache/Queue**       | Redis + BullMQ                       |
| **Auth**              | JWT (Access + Refresh Token)         |

---

## 2. LOYIHA MAQSADI

Aqlli Shahar uchun professional CallCenter tizimini yaratish. Operator telefonda murojaatchi bilan suhbatlashadi, suhbat davomida card/to'ldiradi va `call.mnazorat.uz` platformasiga murojaat ma'lumotlari yuboriladi. Qo'ng'iroq yozuvlari AI orqali avtomatik tahlil qilinib, ticketga xulosa sifatida qo'shiladi. Takroriy qo'ng'iroqlarda murojaatchi ma'lumotlari bazadan avtomatik tanib olinadi.

---

## 3. FUNKSIONAL TALABLAR

### 3.1. Dashboard (Boshqaruv Paneli)

**Maqsad:** Tizim holatini real-time kuzatish va statistika olish.

**Funksiyalar:**

- Kunlik, haftalik, oylik qo'ng'iroqlar statistikasi
- Jami qo'ng'iroqlar soni (kiruvchi/chiquvchi)
- Javob berilgan va berilmagan qo'ng'iroqlar nisbati
- Aktiv operatorlar soni va ularning holati (online/offline/band)
- O'tkazib yuborilgan qo'ng'iroqlar (missed calls) ro'yxati
- O'rtacha gaplashish vaqti
- O'rtacha kutish vaqti
- Operatorlarning ish yuklamasi (kim qancha qo'ng'iroq qabul qildi)
- AI tahlili bo'yicha sentiment taqsimoti (ijobiy/neytral/manfiy)
- Murojaat kategoriyalari bo'yicha taqsimot
- Real-time yangilanadigan grafiklar va diagrammalar

---

### 3.2. Kiruvchi Qo'ng'iroqlar

**Maqsad:** Kiruvchi qo'ng'iroqlarni qabul qilish, qayd etish va boshqarish.

**Funksiyalar:**

- FreePBX orqali qo'ng'iroq qabul qilish
- Caller ID (telefon raqam) avtomatik aniqlash
- **Kontakt bazasidan avtomatik qidiruv:**
  - Agar raqam bazada bo'lsa → Operator ekraniga Ism, Familiya, Manzil ko'rsatiladi
  - Agar raqam yangi bo'lsa → Yangi kontakt yaratish formasi ochiladi
- Qo'ng'iroq avtomatik yoziladi (FreePBX local storage)
- Operator holati avtomatik "Band" ga o'zgaradi
- Qo'ng'iroq tugagach, holat "Online" ga qaytadi
- Missed call bo'lsa → Logga yoziladi va operatorga bildirishnoma yuboriladi
- Qo'ng'iroq tarixi saqlanadi (raqam, vaqt, davomiyligi, operator)

---

### 3.3. Chiquvchi Qo'ng'iroqlar

**Maqsad:** Operator tomonidan murojaatchiga qayta qo'ng'iroq qilish.

**Funksiyalar:**

- Click-to-Call funksiyasi (ticket/kontakt kartasidan tugma bosish orqali)
- Missed call ro'yxatidan qayta qo'ng'iroq qilish
- Rejalashtirilgan qo'ng'iroqlar (call schedule)
- Qo'ng'iroq natijasini qayd etish (javob berdi, javob bermadi, band edi)
- Qo'ng'iroq yozuvi saqlanadi
- Qo'ng'iroq tarixiga avtomatik qo'shiladi

---

### 3.4. Operatorlar va Holat Boshqaruvi

**Maqsad:** Operatorlarning ish holatini boshqarish va nazorat qilish.

**Operator Holatlari:**
| Holat | Tavsif |
|-------|--------|
| **Online** | Qo'ng'iroq qabul qilishga tayyor |
| **Offline** | Qo'ng'iroq qabul qilinmaydi (tugatilgan ish kuni) |
| **Band** | Hozirgi suhbatda (avtomatik) |
| **Pause** | Vaqtincha tanaffus (qo'ng'iroq yo'naltirilmaydi) |

**Funksiyalar:**

- Operator holatini qo'lda o'zgartirish
- Extension (FreePBX ichki raqam) biriktirish
- Ish vaqti hisobi (kishgan/chiqqan vaqt)
- Ish unumdorligi statistikasi
- Bir operatorga bir vaqtning o'zida bitta qo'ng'iroq

---

### 3.5. Kontaktlar Bazasi (CRM)

**Maqsad:** Murojaatchilar ma'lumotlarini saqlash va takroriy qo'ng'iroqlarda tanib olish.

**Saqlanadigan Ma'lumotlar:**

- Telefon raqam (unikal, +998 formatida)
- Ism
- Familiya
- Manzil (Tuman, Ko'cha, Uy)
- Qo'shimcha telefon raqamlar
- Operator izohlari (notes)
- Yaratilgan sana
- Oxirgi yangilangan sana

**Funksiyalar:**

- Kiruvchi qo'ng'iroqda avtomatik qidiruv
- Yangi kontakt qo'lda yaratish
- Mavjud kontakt ma'lumotlarini yangilash
- Kontakt tarixi (barcha qo'ng'iroqlar ro'yxati)
- Kontakt bo'yicha statistika (qancha marta qo'ng'iroq qilgan)
- Kontaktlarni eksport qilish (CSV/Excel)

---

### 3.6. Ticket Tizimi

**Maqsad:** Murojaatlarni ro'yxatga olish va call.mnazorat.uz ga yuborish.

**Ticket Ma'lumotlari:**

- Murojaatchi ma'lumotlari (kontakt yoki yangi)
- Murojaat mavzusi/kategoriyasi
- Murojaat tavsifi
- Qo'ng'iroq yozuvi (recording)
- AI tahlil natijasi (xulosa, sentiment, kategoriyalar)
- Prioritet (Past, O'rta, Yuqori)
- Status (Yangi, Jarayonda, Yopildi, Qayta ochildi)
- call.mnazorat.uz reference ID
- Yaratilgan sana
- Yopilgan sana

**Funksiyalar:**

- Suhbat davomida ticket yaratish
- Ticket ma'lumotlarini to'ldirish
- call.mnazorat.uz ga avtomatik yuborish
- Yuborish statusini kuzatish
- Ticket statusini o'zgartirish
- Ticketga izoh qo'shish
- Ticketni qayta ochish
- Ticket bo'yicha barcha qo'ng'iroqlarni ko'rish
- Ticket bo'yicha AI xulosani ko'rish

---

### 3.7. Qo'ng'iroqlar Tarixi

**Maqsad:** Barcha qo'ng'iroqlarni saqlash, qidirish va tahlil qilish.

**Funksiyalar:**

- Barcha qo'ng'iroqlar ro'yxati (filterlar bilan)
- Qo'ng'iroq detallari (raqam, vaqt, davomiyligi, operator, status)
- Qo'ng'iroq yozuvini tinglash (browser player)
- Qo'ng'iroq bilan bog'liq ticketni ko'rish
- AI tahlil natijasini ko'rish
- Gaplashish vaqti statistikasi
- O'tkazib yuborilgan qo'ng'iroqlar ro'yxati
- Kim ko'tarmaganligi (operator ma'lumoti)
- Qo'ng'iroq sababi/izohi
- Qo'ng'iroqlarni eksport qilish (CSV/Excel)
- Sana bo'yicha filter
- Operator bo'yicha filter
- Status bo'yicha filter (answered, missed, abandoned)

---

### 3.8. AI Integratsiyasi (Aqlli Tahlil)

**Maqsad:** Qo'ng'iroq yozuvlarini avtomatik tahlil qilish va xulosa chiqarish.

**Jarayon:**

1. Qo'ng'iroq tugagandan so'ng yozuv avtomatik AI ga yuboriladi
2. AI yozuvni matnga aylantiradi (Speech-to-Text)
3. AI matn bo'yicha xulosa chiqaradi (Summary)
4. AI kayfiyatni aniqlaydi (Sentiment Analysis)
5. AI murojaat kategoriyalarini belgilaydi
6. Natijalar ticketga avtomatik qo'shiladi

**AI Chiqish Ma'lumotlari:**

- To'liq transkript (gaplashuv matni)
- Qisqa xulosa (1-2 gap)
- Kayfiyat (Ijobiy, Neytral, Manfiy)
- Kategoriyalar (Yo'l, Suv, Gaz, Elektr, Obodonlashtirish, va h.k.)
- Ishonch darajasi (confidence score)

**Funksiyalar:**

- AI tahlil statusini kuzatish (Kutilmoqda, Jarayonda, Tayyor, Xatolik)
- AI xulosani qo'lda tahrirlash imkoniyati
- AI xatoliklarini qayta ishlash
- Tahlil qilingan/qilinmagan qo'ng'iroqlar filtri

---

### 3.9. Foydalanuvchi Rollari (RBAC)

#### 9.a. Operator

**Huquqlar:**

- O'z qo'ng'iroqlarini ko'rish va tinglash
- O'z ticketlarini yaratish va tahrirlash
- O'ziga kelgan missed call larni ko'rish
- Kontaktlarni ko'rish va yangilash
- O'z holatini o'zgartirish (Online/Offline/Pause)
- Dashboard statistikasini ko'rish (faqat o'ziga tegishli)

**Cheklovlar:**

- Boshqa operator qo'ng'iroqlarini ko'ra olmaydi
- Boshqa operator ticketlarini tahrirlay olmaydi
- Tizim sozlamalariga kirish yo'q
- Operatorlarni qo'sha/ocha olmaydi

---

#### 9.b. Admin

**Huquqlar:**

- Barcha operatorlarning qo'ng'iroqlarini tinglash
- Barcha ticketlarni ko'rish va tahrirlash
- Ticketlarning to'g'ri kiritilganligini tekshirish
- Barcha kontaktlarni ko'rish
- Barcha missed call larni ko'rish
- To'liq dashboard statistikasini ko'rish
- Hisobotlarni eksport qilish
- AI tahlil natijalarini ko'rish

**Cheklovlar:**

- Operator/Admin yaratish/ocha olmaydi
- Tizim sozlamalarini o'zgartira olmaydi

---

#### 9.c. Supervisor

**Huquqlar:**

- Operatorlarni CRUD (yaratish, o'qish, yangilash, o'chirish)
- Adminlarni CRUD
- Barcha Admin huquqlari
- Tizim sozlamalarini boshqarish
- FreePBX integratsiya sozlamalari
- AI integratsiya sozlamalari
- Rollar va ruxsatlarni boshqarish
- Audit loglarini ko'rish

**Cheklovlar:**

- Yo'q (to'liq huquq)

---

## 4. TEXNIK ARXITEKTURA

### 4.1. Tizim Komponentlari

```
┌─────────────────────────────────────────────────────────────────┐
│                         CALLCENTER SYSTEM                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   FreePBX    │    │   Backend    │    │  PostgreSQL  │      │
│  │  (Statik IP) │◄──►│  (Bun.js)    │◄──►│  (Database)  │      │
│  └──────┬───────┘    └──────┬───────┘    └──────────────┘      │
│         │                   │                                   │
│         │                   ▼                                   │
│         │           ┌──────────────┐                            │
│         │           │    Redis     │                            │
│         │           │  (BullMQ)    │                            │
│         │           └──────┬───────┘                            │
│         │                   │                                   │
│         │                   ▼                                   │
│         │           ┌──────────────┐                            │
│         └──────────►│  AI REST API │                            │
│                     └──────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2. Ma'lumotlar Oqimi

**Kiruvchi Qo'ng'iroq:**

1. Murojaatchi FreePBX ga qo'ng'iroq qiladi
2. FreePBX Backend ga webhook yuboradi (Call Start)
3. Backend kontakt bazasidan raqamni qidiradi
4. Frontend ga kontakt ma'lumotlari yuboriladi (Popup)
5. Operator javob beradi
6. Suhbat yoziladi (FreePBX local storage)
7. Qo'ng'iroq tugaydi
8. FreePBX Backend ga webhook yuboradi (Call End)
9. Backend BullMQ ga AI tahlil job ini tashlaydi
10. Worker faylni yuklaydi va AI API ga yuboradi
11. AI javobi bazaga saqlanadi
12. Ticket card yangilanadi

**Chiquvchi Qo'ng'iroq:**

1. Operator ticket/kontakt kartasida Click-to-Call tugmasini bosadi
2. Backend FreePBX API ga so'rov yuboradi
3. FreePBX qo'ng'iroq boshlaydi
4. Operator va murojaatchi ulanadi
5. Keyingi jarayon Kiruvchi qo'ng'iroq kabi

---

## 5. FREEPBX INTEGRATSIYASI

### 5.1. Ulanish Talablari

- **Statik IP:** FreePBX serveri statik IP adresga ega bo'lishi kerak
- **Tarmoq:** Backend va FreePBX bir xil tarmoqda yoki VPN orqali ulangan bo'lishi kerak
- **Portlar:**
  - SIP: 5060
  - Webhook: 443 (HTTPS)
  - Recording Access: 443 (HTTPS)

### 5.2. Webhook Eventlar

| Event           | Trigger                     | Ma'lumot                                   |
| --------------- | --------------------------- | ------------------------------------------ |
| Call Start      | Qo'ng'iroq boshlanganda     | Caller ID, Extension, Timestamp, Direction |
| Call End        | Qo'ng'iroq tugaganda        | Duration, Status, Recording Path           |
| Recording Ready | Yozuv tayyor bo'lganda      | File Path, File Size                       |
| Operator Status | Operator holati o'zgarganda | Extension, Status                          |

### 5.3. Recording Storage

- **Joylashuv:** `/var/spool/asterisk/monitor/`
- **Format:** WAV yoki MP3
- **Kirish:** Backend serveriga Nginx reverse proxy orqali ruxsat
- **Xavfsizlik:** Faqat Backend IP sidan kirish (IP Whitelist)
- **Backup:** Kunlik backup (cron job)
- **Retention:** 3 oy saqlanadi, keyin arxivga o'tkaziladi

---

## 6. XAVFSIZLIK TALABLARI

### 6.1. Autentifikatsiya va Avtorizatsiya

- JWT token orqali autentifikatsiya
- Access Token: 15 daqiqa amal qiladi
- Refresh Token: 7 kun amal qiladi
- Password hash: bcrypt (10 rounds)
- Session management: Redis da saqlanadi
- Multi-device login: Ruxsat etiladi

### 6.2. Tarmoq Xavfsizligi

- HTTPS barcha tashqi aloqalar uchun
- IP Whitelist: FreePBX webhooklari faqat FreePBX IP sidan
- IP Whitelist: Recording access faqat Backend IP sidan
- Firewall sozlamalari: Faqat kerakli portlar ochiq
- VLAN separation: Voice va Data traffic ajratilgan

### 6.3. Ma'lumotlar Xavfsizligi

- Shaxsiy ma'lumotlar (PII) shifrlangan
- Loglarda telefon raqamlar maskalanadi
- Recording fayllariga kirish cheklangan
- Database backup shifrlangan
- Audit loglar: Barcha muhim harakatlar qayd etiladi

### 6.4. Role-Based Access Control (RBAC)

- Har bir endpoint uchun role check
- Middleware orqali ruxsat tekshiruvi
- Permission matrix: Rol × Funksiya
- Audit: Kim, qachon, nima qildi

---

## 7. PERFORMANCE TALABLARI

| Parametr          | Talab                     |
| ----------------- | ------------------------- |
| API Response Time | < 200ms (95th percentile) |
| Contact Lookup    | < 100ms                   |
| Dashboard Load    | < 1 sekunda               |
| Recording Stream  | Buffer-free playback      |
| AI Processing     | Async (no blocking)       |
| Concurrent Users  | 100+ operator             |
| Daily Calls       | 10,000+ qo'ng'iroq        |
| Uptime            | 99.9%                     |
| Database Queries  | Optimized with indexes    |

---

## 8. INTEGRATSIYALAR

### 8.1. call.mnazorat.uz

**Maqsad:** Murojaatlarni markazlashtirilgan tizimga yuborish.

**Yuboriladigan Ma'lumotlar:**

- Murojaatchi ma'lumotlari (Ism, Telefon, Manzil)
- Murojaat tavsifi
- Kategoriya
- Prioritet
- Qo'ng'iroq yozuvi (reference)
- Operator ma'lumoti

**Jarayon:**

1. Operator ticket yaratadi
2. Ma'lumotlarni to'ldiradi
3. "Yuborish" tugmasini bosadi
4. Backend call.mnazorat.uz API ga so'rov yuboradi
5. Reference ID qaytadi
6. Ticket ga reference ID saqlanadi
7. Status yangilanadi

---

### 8.2. AI REST API

**Maqsad:** Qo'ng'iroq yozuvlarini avtomatik tahlil qilish.

**Yuboriladigan Ma'lumotlar:**

- Audio fayl (WAV/MP3)
- Til (O'zbek)
- Tahlil parametrlari (Transcript, Summary, Sentiment, Categories)

**Qaytadigan Ma'lumotlar:**

- Transkript (to'liq matn)
- Xulosa (qisqa)
- Sentiment (ijobiy/neytral/manfiy)
- Kategoriyalar (array)
- Ishonch darajasi (0-1)

---

### 8.3. FreePBX API

**Maqsad:** Qo'ng'iroqlarni boshqarish va holatni olish.

**Funksiyalar:**

- Click-to-Call boshlash
- Operator extension statusini olish
- Recording fayllariga kirish
- Call history olish
- Queue ma'lumotlari

---

## 9. MONITORING VA LOGGING

### 9.1. Health Check

- `/api/health` endpoint
- Database connection status
- Redis connection status
- FreePBX connection status
- AI API status
- Response time metrics

### 9.2. Error Tracking

- Global error handler
- Error logging (file + database)
- Error notification (email/telegram)
- Error categorization
- Error analytics

### 9.3. Audit Logs

- Login/Logout harakatlari
- Ticket yaratish/tahrirlash
- Qo'ng'iroq yozuvlarini tinglash
- Operator holati o'zgarishi
- Admin harakatlari
- API so'rovlar (muhim)

### 9.4. Performance Monitoring

- API response time tracking
- Database query performance
- Queue processing time
- Error rate monitoring
- Resource usage (CPU, Memory, Disk)

---

## 10. BACKUP VA QAYTA TIKLASH

### 10.1. Database Backup

- **Frequency:** Kunlik (har kuni 03:00 da)
- **Retention:** 30 kun
- **Format:** pg_dump
- **Storage:** Alohida server/cloud
- **Encryption:** Shifrlangan
- **Test:** Haftalik restore test

### 10.2. Recording Backup

- **Frequency:** Kunlik
- **Retention:** 90 kun (3 oy)
- **Format:** Original format
- **Storage:** FreePBX server + Backup server
- **Archive:** 3 oydan keyin arxivga

### 10.3. Recovery Plan

- **RTO (Recovery Time Objective):** 4 soat
- **RPO (Recovery Point Objective):** 24 soat
- **Backup verification:** Haftalik
- **Disaster recovery:** Hujjatlashtirilgan

---

## 11. RIVOJLANTIRISH BOSQICHLARI

| Bosqich | Vazifalar                                       | Muddat  | Prioritet |
| ------- | ----------------------------------------------- | ------- | --------- |
| **1**   | Auth, Users, Basic CRUD, Project Setup          | 1 hafta | High      |
| **2**   | FreePBX Webhook integratsiyasi, Call logging    | 1 hafta | High      |
| **3**   | Kontaktlar (CRM), Caller ID lookup              | 1 hafta | High      |
| **4**   | Ticket tizimi, call.mnazorat.uz integratsiyasi  | 1 hafta | High      |
| **5**   | BullMQ, AI integratsiyasi, Recording processing | 1 hafta | Medium    |
| **6**   | Dashboard, Analytics, Reports                   | 1 hafta | Medium    |
| **7**   | Testing, Security Audit, Bug fixing             | 1 hafta | High      |
| **8**   | Production Deploy, Training, Documentation      | 1 hafta | High      |

**Jami muddat:** 8 hafta

---

## 12. QABUL QILISH MEZONLARI (ACCEPTANCE CRITERIA)

| Modul           | Mezon                                                                 |
| --------------- | --------------------------------------------------------------------- |
| **Auth**        | JWT token ishlaydi, refresh mechanism bor, security test o'tgan       |
| **Calls**       | Kiruvchi/chiquvchi qo'ng'iroqlar to'liq logda, recording ishlaydi     |
| **CRM**         | Takroriy qo'ng'iroqda kontakt avtomatik chiqadi (< 100ms)             |
| **Tickets**     | call.mnazorat.uz ga muvaffaqiyatli yuboriladi, reference ID saqlanadi |
| **AI**          | Qo'ng'iroq tugagach 5 daqiqa ichida tahlil tayyor                     |
| **Recording**   | Browser da yozuvni tinglash ishlaydi, buffer yo'q                     |
| **RBAC**        | Har bir rol faqat o'z huquqlariga ega, test qilingan                  |
| **Dashboard**   | Real-time statistika to'g'ri ko'rsatiladi                             |
| **Security**    | Penetration test o'tkazilgan, vulnerabilities yo'q                    |
| **Performance** | Load test 100+ concurrent users, 99.9% uptime                         |
| **Backup**      | Backup/Restore test muvaffaqiyatli                                    |

---

## 13. HUJJATLASHTIRISH TALABLARI

### 13.1. Texnik Hujjatlar

- API Documentation (Swagger/OpenAPI)
- Database Schema Documentation
- Architecture Diagram
- Deployment Guide
- Security Guidelines
- Backup/Recovery Procedures

### 13.2. Foydalanuvchi Hujjatlari

- Operator User Manual
- Admin User Manual
- Supervisor User Manual
- FAQ
- Video Tutorials

### 13.3. Loyiha Hujjatlari

- Technical Specification (ushbu hujjat)
- Project Plan
- Risk Assessment
- Change Log
- Release Notes

---

## 14. QO'SHIMCHA TALABLAR

### 14.1. Log Rotation

- Application logs: 7 kun saqlanadi
- Access logs: 30 kun saqlanadi
- Error logs: 90 kun saqlanadi
- Automatic rotation va compression

### 14.2. Notification System

- Email notifications (critical errors)
- Telegram notifications (system alerts)
- In-app notifications (operators)
- Configurable notification settings

### 14.3. Localization

- Interface language: O'zbek
- Date format: DD.MM.YYYY
- Time format: 24-hour
- Phone format: +998 XX XXX XX XX
- Number format: Local standards

### 14.4. Browser Support

- Chrome (latest 2 versions)
- Firefox (latest 2 versions)
- Safari (latest 2 versions)
- Edge (latest 2 versions)

### 14.5. Mobile Responsiveness

- Dashboard: Desktop optimized
- Ticket management: Desktop + Tablet
- Call handling: Desktop required (headset)

---

## 15. RISKLAR VA YECHIMLAR

| Risk                | Ehtimollik | Ta'sir   | Yechim                             |
| ------------------- | ---------- | -------- | ---------------------------------- |
| FreePBX server down | Low        | High     | Backup server, monitoring          |
| AI API down         | Medium     | Medium   | Queue retry, manual processing     |
| Database corruption | Low        | High     | Daily backup, replication          |
| Network outage      | Low        | High     | Local caching, retry mechanism     |
| Storage full        | Medium     | High     | Auto cleanup, alerts, monitoring   |
| Security breach     | Low        | Critical | Regular audit, updates, monitoring |

---

## 16. TEXNIK QO'LLOV

### 16.1. Warranty Period

- **Duration:** 6 oy production deploy dan keyin
- **Coverage:** Bug fixes, security patches
- **Response Time:** 24 soat (critical), 72 soat (normal)

### 16.2. Maintenance

- **Regular Updates:** Oylik security updates
- **Performance Optimization:** Har 3 oyda
- **Backup Verification:** Haftalik
- **Log Review:** Haftalik

### 16.3. Support Channels

- Email: support@...
- Phone: +998 ...
- Telegram: @...
- Ticket System: Internal

---

## 17. XULOSA

Ushbu texnik topshiriq CallCenter "Aqlli Shahar" tizimini yaratish uchun barcha zarur talablarni o'z ichiga oladi. Tizim zamonaviy texnologiyalar (Bun.js, HonoJS, PostgreSQL, Redis, BullMQ) asosida quriladi va FreePBX, call.mnazorat.uz, AI REST API bilan integratsiya qilinadi.

**Asosiy afzalliklar:**

- ✅ Tez va ishonchli (Bun.js runtime)
- ✅ CRM integratsiyasi (takroriy qo'ng'iroqlarni tanib olish)
- ✅ AI tahlili (avtomatik xulosa va kategorizatsiya)
- ✅ Role-based access (xavfsizlik)
- ✅ Scalable architecture (kelajakda o'sish uchun)
- ✅ Full audit trail (barcha harakatlar qayd etiladi)

**Keyingi qadam:** Ushbu TZ tasdiqlangandan so'ng, loyihani boshlash va birinchi bosqich (Auth + Basic CRUD) ni boshlash mumkin.

---

**Tayyorlovchi:** Senior Backend Architect  
**Versiya:** 6.0  
**Sana:** 2024  
**Status:** Tasdiqlash uchun tayyor  
**Hujjat turi:** Texnik Topshiriq (To'liq)
