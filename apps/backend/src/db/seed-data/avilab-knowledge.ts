/**
 * AviLab's knowledge base - the only facts the agent is allowed to state.
 *
 * Written for the ear, not the eye: every answer here is read aloud down a phone
 * line by a voice model, so they are one to three short sentences with no lists,
 * no markup and no strings a person cannot say out loud. Phone numbers, URLs and
 * English technical terms are written the way they are spoken, because a caller
 * cannot hear a slash, an abbreviation or a word they have never met.
 *
 * Sourced from AviLab's own site. Prices, delivery times, guarantees and opening
 * hours are absent because the site does not state them - and an agent that
 * cannot find a fact here says so and takes a message, which is exactly the
 * behaviour a business needs on a recorded line.
 *
 * 65 entries. Edit them in the dashboard rather than here once the
 * system is live: AI yordamchi -> Bilim bazasi.
 */
export interface SeedKnowledgeEntry {
	/**
	 * How a caller actually asks it. Several phrasings, because search reads this.
	 *
	 * The FIRST phrase is the entry's identity for the seeder - append new
	 * phrasings after it, never in front of it, or the seed inserts a duplicate.
	 */
	question: string;
	/** What the agent says. One to three spoken sentences. */
	answer: string;
	/**
	 * Topic labels and search keywords. Weighted above the question text, because
	 * a tag is a deliberate statement of what the entry is about while a word in
	 * a question can be an accident. This is also where the Russian and English
	 * keywords live: the profile advertises both languages, the answers are read
	 * aloud in Uzbek, and a tag is found by search without being spoken.
	 */
	tags: string[];
	/**
	 * 10 for the questions every caller asks, 1 for the rare ones.
	 *
	 * The twelve highest also become the block of facts the agent carries in its
	 * prompt from the first second of the call, answered with no lookup and no
	 * pause - so exactly twelve entries sit at 10.
	 */
	priority: number;
}

export const AVILAB_KNOWLEDGE: SeedKnowledgeEntry[] = [
	{
		question:
			"AI qo'shmoqchiman biznesimga. Sun'iy intellekt tizimi ishlab chiqasizmi? AI yechim kerak edi.",
		answer:
			"Ha, AI ishlab chiqarish bizning asosiy yo'nalishimiz. Maxsus modellar, hujjatlaringiz asosida javob beradigan tizimlar va AI agentlarni sohangizga moslab quramiz. Qanday vazifani AI bajarishini aytsangiz, so'rovingizni yozib olaman.",
		tags: [
			"ai",
			"sun'iy intellekt",
			"ai ishlab chiqarish",
			"model",
			"agent",
			"искусственный интеллект",
			"нейросеть",
		],
		priority: 10,
	},
	{
		question:
			"Narxi qancha turadi? Sayt yoki ilova qilish qanchaga tushadi? Taxminiy summani ayta olasizmi? Qancha pul ketadi, qanaqa summa chiqadi?",
		answer:
			"Narx loyihaning hajmi va talablariga qarab belgilanadi, shuning uchun ko'rmasdan turib raqam aytmayman. Birinchi bosqichimiz kashfiyot aynan shuni aniqlash uchun. Talabingizni yozib olay, mutaxassisimiz bog'lanib narxni aytadi.",
		tags: [
			"narx",
			"byudjet",
			"xarajat",
			"kashfiyot",
			"pul",
			"цена",
			"сколько стоит",
			"стоимость",
			"how much",
			"price",
			"cost",
		],
		priority: 10,
	},
	{
		question:
			"Necha kunda tayyor bo'ladi? Muddati qancha? Tez qilib bera olasizmi? Qachonga yetkazib berasiz?",
		answer:
			"Muddat ish hajmiga bog'liq, shuning uchun oldindan kun aytmayman. Kashfiyot bosqichida maqsad va cheklovlar hujjatlashtirilgandan keyin aniq bosqichlar rejasi tuziladi. Loyihangiz haqida qisqacha aytsangiz, mutaxassis muddatni baholab beradi.",
		tags: ["muddat", "vaqt", "deadline", "reja", "сроки", "когда готово", "timeline"],
		priority: 10,
	},
	{
		question:
			"Operator bilan gaplashsam bo'ladimi? Tirik odam bilan bog'lang. Menejeringiz bilan gaplashmoqchiman.",
		answer:
			"Albatta, hozir hamkasbimga ulashga harakat qilaman. Ulanmasa, murojaatingizni yozib olaman va sizga qayta qo'ng'iroq qilishadi.",
		tags: ["operator", "odam", "menejer", "ulash", "transfer", "оператор", "человек"],
		priority: 10,
	},
	{
		question:
			"Siz kimsiz? AviLab nima bilan shug'ullanadi? Kompaniyangiz haqida qisqacha aytib bering. O'zingiz haqingizda ayting, nima ish qilasiz?",
		answer:
			"AviLab — sun'iy intellekt va texnologiya kompaniyasi. Biz bizneslar uchun AI tizimlari, veb-saytlar, mobil ilovalar va korporativ platformalar quramiz. Sizni qaysi yo'nalish ko'proq qiziqtiryapti?",
		tags: [
			"avilab",
			"kompaniya",
			"tanishtiruv",
			"biz haqimizda",
			"о компании",
			"чем занимаетесь",
			"about",
		],
		priority: 10,
	},
	{
		question:
			"Veb-sayt kerak edi. Sayt yasab bera olasizmi? Kompaniyamizga sayt qildirmoqchiman. Landing yoki korporativ sayt qilasizmi?",
		answer:
			"Albatta, veb ishlab chiqish bizning kuchli tomonimiz. Next.js asosida tez ishlaydigan korporativ saytlar, marketing saytlari va boshqaruv panellarini quramiz. Sayt qanday maqsad uchun kerakligini ayting, mutaxassisimizga yetkazaman.",
		tags: ["veb", "sayt", "web", "next.js", "dashboard", "сайт", "разработка сайта", "website"],
		priority: 10,
	},
	{
		question: "CRM kerak. ERP tizim yoki ichki boshqaruv dasturi qila olasizmi?",
		answer:
			"Ha, CRM va ERP tizimlari bizning yo'nalishlarimizdan biri. Sotuv, ombor va ichki jarayonlarni bitta tizimga birlashtiradigan operatsion dastur quramiz. Hozir qaysi jarayon ko'proq qiynayotganini aytsangiz, shuni qayd etaman.",
		tags: ["crm", "erp", "boshqaruv tizimi", "ombor", "sotuv"],
		priority: 9,
	},
	{
		question:
			"Ishni qanday boshlaymiz? Buyurtma berish uchun nima qilishim kerak? Kim bilan gaplashaman?",
		answer:
			"Eng oson yo'li qisqa suhbat. Loyihangiz haqida aytsangiz, men talabingizni yozib olaman va jamoamiz siz bilan bog'lanib birinchi uchrashuvni kelishadi. Telegramda avilab_uz orqali ham yozishingiz mumkin.",
		tags: ["boshlash", "buyurtma", "aloqa", "uchrashuv"],
		priority: 9,
	},
	{
		question:
			"Mobil ilova qilasizmi? Android va iOS uchun ilova kerak edi. Ikkala telefonda ham ishlaydigan ilova kerak.",
		answer:
			"Ha, mobil ilovalar alohida yo'nalishimiz. Flutter bilan ishlaymiz, ya'ni bitta ilova Android va iOS'da birdek ishlaydi. Ilova g'oyangizni qisqacha aytsangiz, talablaringizni yozib olib mutaxassisga uzataman.",
		tags: [
			"mobil",
			"ilova",
			"android",
			"ios",
			"flutter",
			"мобильное приложение",
			"приложение",
			"mobile app",
		],
		priority: 10,
	},
	{
		question: "Nechta loyiha qilgansiz? Qancha mijozingiz bor? Portfoliongiz kattami?",
		answer:
			"Yuz yigirmadan ortiq loyihani yakunlaganmiz va ellikdan ortiq global mijoz bilan ishlaganmiz. Mijozlar mamnunligi esa yuz foiz.",
		tags: ["loyihalar", "mijozlar", "raqamlar", "portfolio"],
		priority: 9,
	},
	{
		question:
			"Oldin qanday loyihalar qilgansiz? Portfolioingiz bormi, ishlaringizni ko'rsata olasizmi? Shunga o'xshash loyiha qilganmisiz?",
		answer:
			"Yuz yigirmadan ortiq loyiha yetkazganmiz, o'n sakkizdan ortiq mamlakatda. Masalan, AviShifo sun'iy intellekt tizimi va CleanWay sayti, boshqa ishlarimiz ham bor. Sohangizni ayting, eng yaqin misolni tanlab beraman.",
		tags: ["portfolio", "loyihalar", "tajriba", "namuna"],
		priority: 9,
	},
	{
		question:
			"Qancha vaqtdan beri ishlaysiz? Tajribangiz qancha yil? Yangi ochilgan kompaniyamisiz?",
		answer:
			"Besh yildan ortiq vaqtdan beri ishlaymiz, ya'ni bozorda yangi emasmiz. Shu davr ichida yuz yigirmadan ortiq loyihani yetkazib berdik.",
		tags: ["tajriba", "necha yil", "ishonch", "tarix"],
		priority: 9,
	},
	{
		question: "Telegram bot yasab bera olasizmi? Bot kerak edi biznes uchun.",
		answer:
			"Ha, Telegram botlar bizda alohida xizmat. Avtomatlashtirish, mijozni ro'yxatga olish, qo'llab-quvvatlash va savdo oqimlari uchun bot quramiz. Botingiz aynan qanday ish bajarishi kerakligini ayting.",
		tags: ["telegram", "bot", "avtomatlashtirish", "chatbot", "телеграм бот", "бот"],
		priority: 9,
	},
	{
		question: "Dizayn kerak. UI UX dizayn qilasizmi, interfeysimizni chiroyli qilib bermoqchimiz.",
		answer:
			"Ha, UI va UX dizayn alohida xizmatimiz. Interfeys, mahsulot dizayni va animatsiya ustida ishlaymiz. Dizaynerlarimiz Figma bilan ishlaydi, kerakli hajmni birga aniqlab olamiz.",
		tags: ["dizayn", "ui", "ux", "figma", "interfeys", "дизайн"],
		priority: 8,
	},
	{
		question:
			"Ish jarayoni qanday ketadi? Qanday bosqichlarda ishlaysiz? Loyiha qanday olib boriladi?",
		answer:
			"Biz olti bosqichda ishlaymiz. Avval kashfiyot va rejalashtirish, keyin dizayn va ishlab chiqish, oxirida testlash va joylashtirish. Joylashtirishda monitoring o'rnatiladi va jamoangiz uchun qo'llanmalar qoldiriladi.",
		tags: ["jarayon", "bosqich", "metodologiya", "ish uslubi"],
		priority: 8,
	},
	{
		question:
			"Kafolat berasizmi? Ishlamay qolsa nima bo'ladi? Xatolarni tuzatib berasizmi? Kafolatingiz qancha muddatga?",
		answer:
			"Kafolat shartlari kelishuvda alohida belgilanadi, shuning uchun men o'zimdan va'da bermayman. Lekin har bir loyiha testlash bosqichidan o'tadi, unumdorlik va xavfsizlik tekshiriladi. Mutaxassis batafsil aytib beradi.",
		tags: ["kafolat", "shartnoma", "sifat", "testlash", "гарантия", "warranty"],
		priority: 10,
	},
	{
		question:
			"Keyinchalik yangi funksiya qo'shsak bo'ladimi? Texnik xizmat va o'zgartirishlarni siz qilasizmi?",
		answer:
			"Ha, keyin ham yangi funksiya qo'shsa bo'ladi, ishimiz shunga mo'ljallangan. Kod avtomatik tekshiruvlardan o'tib turgani uchun o'zgarishlar xavfsiz va tez bo'ladi. Hajmi va shartlarini birga aniqlaymiz.",
		tags: ["texnik xizmat", "iteratsiya", "yangilash", "funksiya qoshish"],
		priority: 8,
	},
	{
		question: "Mijozlar bilan gaplashadigan AI chatbot yoki AI agent kerak. Shunaqa qila olasizmi?",
		answer:
			"Ha, AI agentlar va o'z hujjatlaringiz asosida javob topadigan tizimlar AI yo'nalishimizga kiradi. Ular ishlab chiqarish darajasida, real yuk ostida ishlashga mo'ljallanadi. Qaysi kanalda ishlashini aytsangiz, batafsil muhokama qilamiz.",
		tags: ["ai agent", "chatbot", "rag", "ai", "avtomatlashtirish"],
		priority: 8,
	},
	{
		question:
			"Oldindan to'lov kerakmi? To'lov qanday amalga oshiriladi? Bo'lib to'lasa bo'ladimi? Hisob-kitob qanday bo'ladi, pulni qanday o'tkazamiz?",
		answer:
			"To'lov shartlari har bir loyiha uchun alohida kelishiladi, shuning uchun men foiz yoki summa aytmayman. Buni mutaxassisimiz birinchi uchrashuvda siz bilan aniqlaydi. Raqamingizni qoldirsangiz, tez orada bog'lanamiz.",
		tags: ["to'lov", "shartlar", "avans", "kelishuv", "hisob-kitob", "оплата", "предоплата"],
		priority: 10,
	},
	{
		question:
			"Qayerdasiz? Ofisingiz qayerda joylashgan? Kelib uchrashsam bo'ladimi? Ofis manzilingizni ayting.",
		answer:
			"Bosh ofisimiz Xorazm viloyati, Urganch shahridagi Tinchlik ko'chasi olti, a uyda. Asosan onlayn ishlaymiz, kelishdan oldin Telegramda avilab_uz orqali yozib qo'ysangiz, sizni kutib olamiz.",
		tags: ["manzil", "ofis", "urganch", "xorazm", "адрес", "офис", "address", "office"],
		priority: 10,
	},
	{
		question:
			"Qaysi texnologiyalarda ishlaysiz? Texnologiya stackingiz qanday, qaysi dasturlash tillarini ishlatasiz? React, Next.js yoki Python bilan ishlaysizmi?",
		answer:
			"Asosan React, Next.js va Python bilan ishlaymiz, boshqa texnologiyalar ham bor. Ma'lumotlar bazasi va bulut tomonini ham o'zimiz olib boramiz. Loyihangizga qaysi biri to'g'ri kelishini mutaxassis aniqlab beradi.",
		tags: ["texnologiyalar", "stack", "react", "python", "dasturlash"],
		priority: 8,
	},
	{
		question:
			"Sayt ishga tushgandan keyin qo'llab-quvvatlaysizmi? Loyiha topshirilgandan keyin nima bo'ladi?",
		answer:
			"Ha, ishga tushirgandan keyin ham yoningizdamiz. Yangilanishni bosqichma-bosqich chiqaramiz, tizim holatini kuzatib turamiz va jamoangizga barcha qo'llanmalarni topshiramiz. Qo'llab-quvvatlash shartlarini esa alohida kelishamiz.",
		tags: ["qollab-quvvatlash", "ishga tushirish", "monitoring", "keyingi bosqich"],
		priority: 8,
	},
	{
		question:
			"Sun'iy intellekt loyihalaringizga misol bormi? AI tizim qurganmisiz? Sun'iy intellekt bilan qanday ishlar qilgansiz?",
		answer:
			"AviShifo va AviRadiology sun'iy intellekt loyihalarimiz, Control Agent va Control Tizim ham AI yo'nalishidagi ishlarimiz — ularda Python, Django, React va Next.js ishlatilgan. Qanday vazifani avtomatlashtirmoqchisiz, aytsangiz mutaxassisimiz eng o'xshash misolni ko'rsatib beradi.",
		tags: ["sun'iy intellekt", "control agent", "avishifo", "portfolio"],
		priority: 8,
	},
	{
		question: "Telefon raqamingizni ayting. Qaysi raqamga qo'ng'iroq qilay? Nomeringizni bering.",
		answer:
			"Telefon raqamimiz plyus to'qqiz yuz to'qson sakkiz, to'qson besh, sakkiz yuz ellik, nol sakkiz, sakson. Xohlasangiz shu raqamga qo'ng'iroq qiling, yoki Telegramda avilab_uz orqali yozing.",
		tags: ["telefon", "raqam", "nomer", "aloqa", "номер телефона", "телефон", "phone"],
		priority: 10,
	},
	{
		question:
			"Telegram yoki emailingiz bormi? Pochta manzilingizni ayting. Instagram, LinkedIn sahifalaringiz bormi?",
		answer:
			"Telegramda avilab_uz manzilida yozsangiz, eng tez javob beramiz. Elektron pochtamiz avilab nuqta com, kuchukcha belgisi, gmail nuqta com. Instagram va LinkedIn sahifalarimiz ham bor.",
		tags: ["telegram", "email", "pochta", "instagram", "linkedin"],
		priority: 8,
	},
	{
		question:
			"AI integratsiyasi real ishda ishonchli ishlaydimi? Sun'iy intellekt productionda qanday ishlaydi?",
		answer:
			"Ha, biz sun'iy intellekt tizimlarini haqiqiy ishga, real yuk ostida ishlashga tayyorlab quramiz. Yangilanish bosqichma-bosqich chiqadi, tizim esa doimiy kuzatuvda turadi.",
		tags: ["ai", "integratsiya", "production", "rag", "monitoring"],
		priority: 7,
	},
	{
		question: "Internet-do'kon yoki onlayn savdo platformasi kerak. Shunaqa loyihalarni olasizmi?",
		answer:
			"Ha, onlayn savdo ham veb yo'nalishimizga kiradi. Next.js asosida platformalar, saytlar va boshqaruv panellarini quramiz. Aniq talablaringizni yozib olay, mutaxassis imkoniyatlarni batafsil aytib beradi.",
		tags: ["internet dokon", "onlayn savdo", "veb", "platforma"],
		priority: 7,
	},
	{
		question: "Jamoangiz nechta odamdan iborat? Qanday ish olib borasiz? Masofadan ishlaysizmi?",
		answer:
			"Jamoamiz xalqaro tarkibda, asosan onlayn ishlaymiz. Kerak bo'lganda jonli uchrashuvlar ham qilamiz.",
		tags: ["jamoa", "ish uslubi", "masofaviy", "onlayn"],
		priority: 7,
	},
	{
		question:
			"Jamoangizda necha kishi bor? Jamoa haqida gapirib bering. Kim ishlaydi sizda, xodimlaringiz nechta?",
		answer:
			"AviLab jamoasida yetti mutaxassis bor. Asoschimiz, dasturchilar, sun'iy intellekt muhandisi, dizayner va marketolog ishlaydi. Har birining kamida uch yillik tajribasi bor.",
		tags: ["jamoa", "xodim", "kishi", "team", "mutaxassis"],
		priority: 7,
	},
	{
		question: "Kashfiyot bosqichi nima degani? Nega darrov ishlab chiqishga o'tmaysiz?",
		answer:
			"Kashfiyot — bu birinchi bosqich, ya'ni dastlabki tahlil. Unda loyihangizning maqsadi, cheklovlari va nimani muvaffaqiyat deb hisoblashimiz aniq yozib olinadi. Shundan keyin narx ham, muddat ham aniq bo'ladi.",
		tags: ["kashfiyot", "tahlil", "rejalashtirish", "talablar"],
		priority: 7,
	},
	{
		question: "Ma'lumotlarimiz xavfsiz bo'ladimi? Xavfsizlik masalasini qanday hal qilasiz?",
		answer:
			"Xavfsizlik biz uchun boshidanoq asosiy shart. Tizimni himoyalab quramiz va xavfsizlik tahlilini o'tkazamiz. Sinov bosqichida yuklama va himoya alohida tekshiriladi.",
		tags: ["xavfsizlik", "kiberxavfsizlik", "mustahkamlash", "tekshiruv"],
		priority: 7,
	},
	{
		question:
			"Mobil ilova qilgan loyihangiz bormi? Android va iOS uchun ilova kerak edi, Flutter'da ilova qilganmisiz?",
		answer:
			"Ha, AviFitness mobil ilovasini biz qurganmiz. Flutter texnologiyasida ishlaymiz, ya'ni bitta ilova Android va iOS uchun birdek bo'ladi. Ilova g'oyangizni qisqacha aytsangiz, yozib olay.",
		tags: ["mobil ilova", "flutter", "avifitness", "android"],
		priority: 7,
	},
	{
		question:
			"Qanday saytlar qilgansiz? Veb loyihalaringizdan namuna bormi? Sayt portfolioingizni aytib bera olasizmi?",
		answer:
			"Veb tomonda CleanWay va Billiard Club saytlari, ShifoGO platformasi va Med instituti loyihasi bor. Billiard Club va ShifoGO Next.js va React asosida, CleanWay dizayn va motion tomoni bilan, Med instituti esa Python va AWS bilan ishlangan. Sizga qanday sayt kerakligini aytsangiz, eng yaqin namunani ko'rsatamiz.",
		tags: ["veb sayt", "cleanway", "billiard club", "next.js"],
		priority: 7,
	},
	{
		question: "SaaS platforma qurmoqchiman. Obuna va to'lov tizimi bilan mahsulot qila olasizmi?",
		answer:
			"Ha, SaaS platformalar bilan ishlaymiz. Obuna va to'lov tizimi, foydalanuvchi kirishi hamda statistikani birga quramiz. G'oyangizni qisqacha aytsangiz, mutaxassisimizga ulab beraman.",
		tags: ["saas", "platforma", "billing", "obuna", "arxitektura"],
		priority: 7,
	},
	{
		question: "Sayt ham, ilova ham, dizayn ham kerak. Hammasini bitta joydan qila olasizmi?",
		answer:
			"Ha, hammasi bitta jamoada. Sayt, mobil ilova va dizayndan tashqari sun'iy intellekt va bulut kabi jami o'nta yo'nalishimiz bor. Loyihangizni tavsiflab bersangiz, kerakli mutaxassislarni biriktiramiz.",
		tags: ["xizmatlar", "to'liq sikl", "kompleks", "jamoa"],
		priority: 7,
	},
	{
		question:
			"Uchrashuv belgilasak bo'ladimi? Uchrashib gaplashsak? Soat nechada ishlaysiz, qachon kelsam bo'ladi?",
		answer:
			"Albatta, uchrashamiz. Aniq vaqtni mutaxassisimiz siz bilan kelishib oladi, shuning uchun ismingiz va telefon raqamingizni yozib olay. Telegramda avilab_uz orqali yozsangiz ham, tez javob beramiz.",
		tags: ["uchrashuv", "uchrashish", "vaqt", "soat", "aloqa"],
		priority: 7,
	},
	{
		question:
			"Chet el mijozlari bilan ishlaysizmi? Faqat O'zbekistondami? Xalqaro loyihalar qilganmisiz?",
		answer:
			"Ha, o'n sakkizdan ortiq mamlakat mijozlari bilan ishlaganmiz va jamoamizning o'zi ham xalqaro. Shuning uchun chet eldagi loyihalar biz uchun odatiy ish.",
		tags: ["xalqaro", "chet el", "mamlakatlar", "mijozlar"],
		priority: 6,
	},
	{
		question: "Dasturchilaringiz kim? Kim dastur yozadi? Frontend va backend dasturchi bormi?",
		answer:
			"Akbar Satipov full stack dasturchi, olti yil tajribasi bor. Shahzod Jumanazarov backend tomonini, Alibek Jumanyazov esa frontend tomonini olib boradi. Asosiy vositalari Python, Django, React va Next.js.",
		tags: ["dasturchi", "frontend", "backend", "developer", "fullstack"],
		priority: 6,
	},
	{
		question: "Kompaniya rahbari kim? Asoschingiz kim? Direktor bilan gaplashsam bo'ladimi?",
		answer:
			"AviLab asoschisi Abdurasulov Abdulla, u data scientist ham. Sun'iy intellekt, tizimlar va jamoa boshqaruvida besh yildan ortiq tajribasi bor. Xohlasangiz, siz bilan bog'lanishi uchun so'rovingizni yozib olaman.",
		tags: ["asoschi", "rahbar", "founder", "direktor", "abdulla"],
		priority: 6,
	},
	{
		question:
			"Mening sohamda loyiha qilganmisiz? Sport, tozalash xizmati yoki o'yin-kulgi biznesi uchun ishlaganmisiz? Kichik biznes uchun namuna bormi?",
		answer:
			"Portfoliomizda CleanWay, Billiard Club, AviFitness, AviShifo, ShifoGO kabi turli xildagi loyihalar bor — umumiy hisobda yuz yigirmadan ortiq loyiha yetkazganmiz. Sohangizni ayting, mutaxassisimiz eng yaqin namunani tanlab beradi.",
		tags: ["soha", "biznes", "cleanway", "billiard club", "avifitness"],
		priority: 6,
	},
	{
		question:
			"Missiyangiz nima? Qanday qadriyatlarga amal qilasiz? Nega aynan sizni tanlashim kerak?",
		answer:
			"Missiyamiz — talabchan foydalanuvchilar uchun tez, xavfsiz va chiroyli tizimlar yaratish. Biz uchun ishning tezligi ham, ko'rinishi ham muhim, xavfsizlik esa boshidan o'ylanadi. Mijoz bilan hamma narsani ochiq va aniq gaplashamiz.",
		tags: ["missiya", "vizyon", "qadriyatlar", "yondashuv"],
		priority: 6,
	},
	{
		question:
			"OpenAI yoki ChatGPT integratsiyasini qilasizmi? Qaysi AI modellari, TensorFlow bilan ishlaysizmi?",
		answer:
			"Ha, OpenAI bilan ishlaymiz, TensorFlow va Python ham bizda bor. Masalan AviShifo loyihasida OpenAI'ni saytga ulab ishlatganmiz. Vazifangizni yozib olay, mutaxassis mos yechimni aytadi.",
		tags: ["openai", "tensorflow", "sun'iy intellekt", "integratsiya"],
		priority: 6,
	},
	{
		question:
			"Serverlarni bulutga ko'chirmoqchimiz. AWS, Docker va DevOps bo'yicha yordam bera olasizmi?",
		answer:
			"Ha, bulut infratuzilmasi xizmatimiz bor. AWS, konteynerlar va monitoring bilan ishlaymiz, arxitekturani xarajatni hisobga olgan holda quramiz. Hozirgi tizimingiz haqida aytsangiz, muhandisimizga yetkazaman.",
		tags: ["bulut", "aws", "docker", "devops", "infratuzilma"],
		priority: 6,
	},
	{
		question: "Sifatni qanday tekshirasiz? Test qilasizmi? Yuklama ko'tara oladimi?",
		answer:
			"Ha, testlash alohida bosqich. Tizimni tezlik, xavfsizlik va haqiqiy yuk ostida sinovdan o'tkazamiz. Kod ham yozilish jarayonida avtomatik tekshiruvlardan o'tadi.",
		tags: ["testlash", "sifat", "xavfsizlik", "unumdorlik"],
		priority: 6,
	},
	{
		question:
			"Tibbiyot sohasida loyiha qilganmisiz? Klinika, shifoxona yoki tibbiyot instituti uchun tizim qilgansizmi? Meditsina yo'nalishida tajribangiz bormi?",
		answer:
			"Portfoliomizda AviShifo va AviRadiology sun'iy intellekt loyihalari, ShifoGO veb platformasi va Med instituti loyihasi bor. Ehtiyojingizni yozib olay — mutaxassisimiz qaysi biri sizning sohangizga yaqinligini batafsil ko'rsatib beradi.",
		tags: ["tibbiyot", "avishifo", "aviradiology", "shifogo", "klinika"],
		priority: 6,
	},
	{
		question:
			"Tizim ishlamay qolsa bilib olasizmi? Monitoring va kuzatuv qanday yo'lga qo'yilgan? Tizim yiqilsa xabar topasizmi?",
		answer:
			"Ha, tizim holatini doimiy kuzatib turadigan monitoring o'rnatamiz. Nosozlik bo'lsa, biz undan darrov xabar topamiz. Joylashtirgandan keyin jamoangizga kerakli qo'llanmalar ham qoladi.",
		tags: ["monitoring", "observability", "kuzatuv", "nosozlik"],
		priority: 6,
	},
	{
		question: "Brend, logotip va reklama roligi kerak. Motion dizayn bilan shug'ullanasizmi?",
		answer:
			"Ha, brending va motion yo'nalishimiz bor. Brend identifikatsiyasi, mahsulot ishga tushirish videolari va interfeys mikroanimatsiyalarini tayyorlaymiz. Aynan nima kerakligini aytsangiz, so'rovingizni qayd etaman.",
		tags: ["brending", "motion", "logotip", "animatsiya", "video"],
		priority: 5,
	},
	{
		question: "Chegirma bormi? Arzonroq variantini qilib bo'ladimi? Byudjetim cheklangan.",
		answer:
			"Chegirma masalasida men o'zimdan gapira olmayman, buni jamoa hal qiladi. Lekin aynan nima kerakligini kashfiyot bosqichida aniqlab, ish hajmini siz bilan birga kelishamiz. Talabingizni yozib olay, mutaxassis javob beradi.",
		tags: ["chegirma", "byudjet", "narx", "hajm"],
		priority: 5,
	},
	{
		question:
			"Dizayneringiz bormi? Dizayn va motion ishlarini kim qiladi? Marketing bo'yicha kim ishlaydi? Dizaynerlaringiz Figmada ishlaydimi?",
		answer:
			"Mukhammad Komilov dizayner va frontend dasturchi, olti yil tajribasi bor, Figma va Framer bilan ishlaydi. Marketing yo'nalishini Shaxriyor Davlatnazarov olib boradi, uch yildan ortiq tajribasi bilan.",
		tags: ["dizayn", "dizayner", "marketing", "marketolog", "motion"],
		priority: 5,
	},
	{
		question:
			"Kiberxavfsizlik xizmati bormi? Xavfsizlik tekshiruvi kerak. Tizimimizni himoya qilish bo'yicha ishlaysizmi?",
		answer:
			"Ha, kiberxavfsizlik ham xizmatlarimiz qatorida. Tizimni mustahkamlash, xavfsizlik tahlili va ishlab chiqish jarayonini xavfsiz tashkil etish bilan shug'ullanamiz. Qaysi tizim haqida gap ketayotganini aniqlashtirib bera olasizmi?",
		tags: ["xavfsizlik", "kiberxavfsizlik", "audit", "himoya"],
		priority: 5,
	},
	{
		question: "Loyihani keyin o'z jamoamiz boshqara oladimi? Hujjat va qo'llanma berasizmi?",
		answer:
			"Ha, joylashtirish bosqichida jamoangizga kerakli qo'llanmalarni topshiramiz. Kod avtomatik tekshiruvlar bilan yozilgani uchun boshqa jamoa uni davom ettirishi qulay bo'ladi.",
		tags: ["hujjat", "qollanma", "topshirish", "jamoa"],
		priority: 5,
	},
	{
		question:
			"Saytni qayerda joylashtirasiz? AWS, Docker yoki Kubernetes bilan ishlaysizmi? Bulut serveri va infratuzilma qanday bo'ladi?",
		answer:
			"Ha, AWS bulutida ishlaymiz. Docker konteynerlari va Kubernetes orqali joylashtiramiz, kuzatuv tizimini ham o'rnatamiz. Arxitekturani xarajatni hisobga olib tuzamiz, keyin jamoangiz o'zi boshqara oladi.",
		tags: ["aws", "bulut", "docker", "kubernetes", "server"],
		priority: 5,
	},
	{
		question:
			"Sun'iy intellekt bo'yicha mutaxassisingiz bormi? AI bilan kim shug'ullanadi? Data scientist ishlaydimi sizda?",
		answer:
			"Ha, Azizbek Atoyev sun'iy intellekt bo'yicha mutaxassisimiz, olti yillik tajribasi bor. U til modellari ustida ishlaydi, asosiy vositasi Python. Asoschimiz Abdulla ham shu yo'nalish mutaxassisi.",
		tags: ["mlops", "data", "scientist", "mutaxassis", "intellekt"],
		priority: 5,
	},
	{
		question:
			"Yangilanish chiqarganda sayt to'xtab qoladimi? Yangi versiyani qanday joylashtirasiz?",
		answer:
			"Yo'q, sayt to'xtamaydi. Yangilanishni bosqichma-bosqich yoyamiz, shu payt monitoring ishlab turadi va muammo chiqsa darrov ko'rinadi.",
		tags: ["deploy", "yangilanish", "progressiv chiqarish", "ishonchlilik"],
		priority: 5,
	},
	{
		question:
			"Qanday tadbirlarda qatnashgansiz? Hackathonlarda ishtirok etganmisiz? Yutuqlaringiz bormi?",
		answer:
			"Ha, hakatonlarda qatnashamiz. Samarqand va Toshkentdagi sun'iy intellekt hakatonlarida bo'lganmiz. Bundan oldin xalqaro startap tanlovi va Innoweek tadbirida ham ishtirok etganmiz.",
		tags: ["tadbirlar", "hackathon", "yutuqlar", "tanlovlar"],
		priority: 4,
	},
	// Questions callers ask constantly and the knowledge base had no row for at
	// all, so the agent answered them out of an unrelated entry: what time you
	// open, do you hire, can we partner, can you do SEO, Click and Payme, 1C,
	// domains, my site was hacked, take over an unfinished project, contracts.
	// None of them invents a fact - where the site says nothing, so does the
	// agent, and it takes a message instead.
	{
		question:
			"Soat nechada ochasiz? Ish vaqtingiz qanday, nechchida yopasiz? Yakshanba, shanba yoki bayram kunlari ishlaysizmi? Dam olish kuni ishlaysizmi?",
		answer:
			"Jamoamiz asosan onlayn va moslashuvchan ishlaydi, shuning uchun qat'iy ish soatlarini aytolmayman. Xabaringizni istalgan vaqtda qoldiring, Telegramda avilab_uz orqali yozsangiz ham bo'ladi. Uchrashuv vaqtini esa siz bilan alohida kelishamiz.",
		tags: [
			"ish vaqti",
			"ish kuni",
			"dam olish",
			"bayram",
			"yakshanba",
			"shanba",
			"soat",
			"график работы",
			"часы работы",
			"working hours",
		],
		priority: 10,
	},
	{
		question:
			"Ishga olasizmi? Vakansiya bormi, rezyume yuborsam bo'ladimi? Stajirovka yoki amaliyot o'tsam bo'ladimi? Ish haqi qancha?",
		answer:
			"Ochiq ish o'rinlari haqida men aniq ma'lumot bermayman, ish haqi ham suhbatda belgilanadi. Rezyumeingizni Telegramda avilab_uz orqali yoki elektron pochtamizga yuboring, jamoamiz ko'rib chiqadi. Xohlasangiz, murojaatingizni hozir yozib olaman.",
		// "ishga" is in the tags on purpose. It is this entry's own opening word, but
		// four other entries use it too ("ishga tushirish"), so on question text alone
		// a caller asking "ishga olasizmi" was answered with the post-launch support
		// entry. Tags outrank questions in the scoring, which is what settles it.
		tags: ["ishga olish", "vakansiya", "ish o'rni", "rezyume", "stajirovka", "работа"],
		priority: 6,
	},
	{
		question:
			"Hamkorlik qilsak bo'ladimi? Sheriklik taklifim bor, subpudrat yoki autsors sifatida ishlasak? Hamkor sifatida murojaat qilyapman.",
		answer:
			"Hamkorlik takliflarini mamnuniyat bilan ko'rib chiqamiz. Taklifingiz mohiyatini qisqacha aytsangiz, murojaatingizni hamkorlik yo'nalishi bo'yicha yozib olaman. Jamoamiz siz bilan bog'lanadi.",
		tags: ["hamkorlik", "sheriklik", "autsors", "subpudrat", "партнёрство"],
		priority: 6,
	},
	{
		question:
			"SEO bilan shug'ullanasizmi? Ijtimoiy tarmoqlarni yuritasizmi, SMM va reklama qilasizmi? Instagram sahifamizni olib bora olasizmi?",
		answer:
			"SEO va ijtimoiy tarmoq targ'iboti alohida xizmat sifatida ro'yxatimizda yo'q, lekin jamoamizda marketing mutaxassisi bor. Aynan nima kerakligini aytsangiz, so'rovingizni yozib olaman va mutaxassisimiz nima qila olishimizni aniq aytadi.",
		tags: ["seo", "smm", "reklama", "ijtimoiy tarmoq", "instagram", "marketing"],
		priority: 5,
	},
	{
		question:
			"Click va Payme ulab bera olasizmi? Saytga to'lov tizimi kerak, onlayn to'lovni ulaysizmi? Uzum yoki karta orqali to'lov qo'shasizmi?",
		answer:
			"To'lov tizimini saytga yoki ilovaga ulash biz qiladigan ishlardan biri. Qaysi tizimni ulash kerakligini ayting, texnik imkoniyatni mutaxassisimiz tekshirib aniq javob beradi. So'rovingizni hozir yozib olay.",
		tags: ["click", "payme", "to'lov tizimi", "onlayn to'lov", "integratsiya", "эквайринг"],
		priority: 6,
	},
	{
		question:
			"1C bilan integratsiya qila olasizmi? Mavjud dasturimizga ulaysizmi, tizimlarni bir-biriga bog'lash mumkinmi? API orqali integratsiya kerak.",
		answer:
			"Ha, mavjud tizimlarni bir-biriga bog'lash, ya'ni integratsiya ham ishimizga kiradi. Qaysi dastur bilan bog'lash kerakligini va u hozir qanday ishlayotganini aytsangiz, muhandisimiz imkoniyatni baholab beradi.",
		tags: ["1c", "integratsiya", "api", "mavjud tizim", "bog'lash", "интеграция"],
		priority: 6,
	},
	{
		question:
			"Domen va hosting olib bera olasizmi? Sayt qayerda turadi, hostingni kim to'laydi? Domen ro'yxatdan o'tkazish kerak.",
		answer:
			"Saytni joylashtirish va server tomonini o'zimiz olib boramiz, asosan AWS bulutida ishlaymiz. Domen va hosting masalasida ham yo'l ko'rsatamiz. Hozir nimangiz bor va nima kerakligini aytsangiz, mutaxassis aniq aytib beradi.",
		tags: ["domen", "hosting", "server", "joylashtirish", "aws"],
		priority: 5,
	},
	{
		question:
			"Saytimni buzishdi, hacker hujum qildi. Tiklab bera olasizmi, virus tushgan bo'lsa nima qilamiz? Shoshilinch yordam kerak.",
		answer:
			"Bunday holatda tezkor yordam kerak, shuning uchun murojaatingizni darhol yozib olaman. Jamoamizda kiberxavfsizlik yo'nalishi bor, tizimni tekshirib himoyani mustahkamlash bilan shug'ullanamiz. Qaysi sayt yoki tizim ekanini ayting.",
		tags: ["hujum", "buzilgan", "tiklash", "virus", "kiberxavfsizlik", "shoshilinch"],
		priority: 5,
	},
	{
		question:
			"Boshqa jamoa boshlagan loyihani davom ettira olasizmi? Tayyor saytimni qayta ishlab bering, eski tizimimizni yangilamoqchimiz.",
		answer:
			"Bunday ishlarni ham ko'rib chiqamiz. Avval kodni va tizimning hozirgi holatini tahlil qilamiz, keyin nima qilish kerakligini aniq aytamiz. Loyihangiz haqida qisqacha aytsangiz, so'rovingizni yozib olaman.",
		tags: ["davom ettirish", "qayta ishlash", "eski sayt", "yangilash", "tahlil"],
		priority: 7,
	},
	{
		question:
			"Shartnoma tuzasizmi? Rasmiy hujjat bilan ishlaysizmi, yuridik shaxs bilan shartnoma bo'ladimi? Hisob-faktura kerak.",
		answer:
			"Ishni rasmiy kelishuv asosida olib boramiz, shartlari esa har bir loyiha uchun alohida yoziladi. Shartnoma bandlarini men o'zimdan aytmayman, buni mutaxassisimiz siz bilan batafsil kelishadi. Murojaatingizni yozib olaymi?",
		tags: ["shartnoma", "hujjat", "yuridik shaxs", "rasmiy", "договор"],
		priority: 7,
	},
];
