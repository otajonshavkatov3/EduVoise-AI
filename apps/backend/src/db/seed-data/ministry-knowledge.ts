/**
 * Oliy ta'lim, fan va innovatsiyalar vazirligi - bilim bazasi.
 *
 * Same rules as avilab-knowledge.ts: written for the ear (one to three spoken
 * sentences, no lists, no URLs), and the agent may state nothing that is not
 * here. The content is deliberately general - the ministry's remit and how an
 * appeal is handled - because specific figures (dates, fees, quotas, scores) and
 * contact details change every year and were not verified when this was written.
 * Where a caller needs such a fact, the answer registers the question as an
 * appeal instead of guessing.
 *
 * VERIFY BEFORE PRODUCTION: the review-time entry paraphrases the law
 * "Jismoniy va yuridik shaxslarning murojaatlari to'g'risida" (15 days, up to a
 * month when additional study is needed). Have the ministry confirm the wording.
 *
 * Twelve entries sit at priority 10 - those ride in the prompt from the first
 * second of the call (see avilab-knowledge.ts).
 */
import type { SeedKnowledgeEntry } from "./avilab-knowledge";

export const MINISTRY_KNOWLEDGE: SeedKnowledgeEntry[] = [
	// ---------------------------------------------------------------- priority 10
	{
		question:
			"Murojaat qilmoqchiman. Ariza qoldirsam bo'ladimi? Shikoyatim bor, qayerga yozay? Vazirlikka murojaat qanday yuboriladi?",
		answer:
			"Albatta, murojaatingizni hozir shu qo'ng'iroqda qabul qilaman. Familiya va ismingiz, yashash hududingiz va murojaatingiz mazmunini aytsangiz, ro'yxatga olib mas'ul bo'limga yuboraman.",
		tags: ["murojaat", "ariza", "shikoyat", "обращение", "заявление", "жалоба", "appeal"],
		priority: 10,
	},
	{
		question:
			"Murojaat qancha vaqtda ko'rib chiqiladi? Javob qachon keladi? Necha kunda javob berasizlar?",
		answer:
			"Murojaatlar qonunchilikda belgilangan muddatda ko'rib chiqiladi: odatda o'n besh kun ichida, qo'shimcha o'rganish talab qilinsa bir oygacha. Javob siz qoldirgan aloqa ma'lumotlari orqali yetkaziladi.",
		tags: ["muddat", "javob", "necha kun", "ko'rib chiqish", "срок", "когда ответ", "deadline"],
		priority: 10,
	},
	{
		question:
			"Murojaatim nima bo'ldi? Arizam holatini qanday bilaman? Oldin murojaat qilgandim, javob kelmadi.",
		answer:
			"Murojaatingiz bo'yicha mas'ul xodim siz qoldirgan telefon raqami orqali bog'lanadi. Belgilangan muddatda javob olmagan bo'lsangiz, ism-familiyangiz va murojaat mavzusini aytsangiz, buni alohida qayd etib mas'ul bo'limga yuboraman.",
		tags: ["holat", "status", "javob kelmadi", "kechikish", "статус", "нет ответа"],
		priority: 10,
	},
	{
		question: "Operator bilan gaplashmoqchiman. Jonli odam bilan ulang. Mutaxassisga ulab bering.",
		answer:
			"Albatta, sizni operatorga ulayman. Operatorlar band bo'lsa, murojaatingizni yozib olib, mutaxassis qayta bog'lanishini ta'minlayman.",
		tags: ["operator", "jonli xodim", "mutaxassis", "оператор", "живой человек", "human"],
		priority: 10,
	},
	{
		question:
			"Vazirlik nima bilan shug'ullanadi? Qaysi masalalar bo'yicha murojaat qilsa bo'ladi? Bu qanday tashkilot?",
		answer:
			"Vazirlik oliy ta'lim, ilm-fan va innovatsiyalar sohasida davlat siyosatini amalga oshiradi. Oliy ta'lim muassasalari, ilmiy tadqiqotlar va innovatsion faoliyatga oid murojaatlaringizni qabul qilaman.",
		tags: [
			"vazirlik",
			"vakolat",
			"oliy ta'lim",
			"fan",
			"министерство",
			"высшее образование",
			"ministry",
		],
		priority: 10,
	},
	{
		question:
			"O'qishga kirmoqchiman. Qabul qachon boshlanadi? Universitetga hujjat topshirish qanday? Abituriyentman.",
		answer:
			"Oliy ta'lim muassasalariga qabul har yili belgilanadigan tartib va muddatlarda o'tkaziladi, aniq sanalar va talablar rasmiy e'lonlarda beriladi. Qaysi muassasa va yo'nalish qiziqtirayotganini aytsangiz, savolingizni murojaat sifatida ro'yxatga olaman.",
		tags: [
			"qabul",
			"o'qishga kirish",
			"abituriyent",
			"hujjat topshirish",
			"поступление",
			"абитуриент",
			"admission",
		],
		priority: 10,
	},
	{
		question:
			"O'qishimni boshqa universitetga ko'chirmoqchiman. O'qishni tiklash mumkinmi? Perevod qilsam bo'ladimi?",
		answer:
			"O'qishni ko'chirish va tiklash vazirlik belgilagan tartib va muddatlarda amalga oshiriladi. Qaysi muassasadan qaysi muassasaga, qaysi kurs va yo'nalishda ekaningizni aytsangiz, murojaatingizni mas'ul bo'limga yuboraman.",
		tags: ["ko'chirish", "perevod", "tiklash", "перевод", "восстановление", "transfer"],
		priority: 10,
	},
	{
		question:
			"Kontrakt qancha? Kontrakt to'lovini qanday to'layman? To'lov muddati qachon? Kontraktni bo'lib to'lasa bo'ladimi?",
		answer:
			"Kontrakt miqdori va to'lov muddatlari har bir muassasa va yo'nalish bo'yicha belgilanadi va shartnomangizda ko'rsatiladi. To'lov bo'yicha muammo yoki imtiyoz masalasi bo'lsa, tafsilotlarni yozib olib mas'ul bo'limga yuboraman.",
		tags: ["kontrakt", "to'lov", "shartnoma", "контракт", "оплата обучения", "tuition"],
		priority: 10,
	},
	{
		question: "Stipendiya berilmayapti. Stipendiya qachon tushadi? Stipendiyam kamaytirildi.",
		answer:
			"Stipendiya tayinlash va to'lash avvalo o'qiyotgan muassasangiz tomonidan hal qilinadi. U yerda hal bo'lmagan bo'lsa, muassasa nomi va vaziyatni aytsangiz, murojaatingizni ro'yxatga olaman.",
		tags: ["stipendiya", "стипендия", "scholarship"],
		priority: 10,
	},
	{
		question:
			"Yotoqxona berishmayapti. Talabalar turar joyiga qanday joylashaman? TTJ sharoiti yomon.",
		answer:
			"Talabalar turar joyiga joylashtirish o'qiyotgan muassasangiz tomonidan amalga oshiriladi. Joy berilmagan yoki sharoit bo'yicha shikoyatingiz bo'lsa, muassasa nomi va vaziyatni aytsangiz, murojaat sifatida qabul qilaman.",
		tags: ["yotoqxona", "ttj", "turar joy", "общежитие", "dormitory"],
		priority: 10,
	},
	{
		question:
			"Diplomimni yo'qotib qo'ydim. Diplom dublikatini qanday olaman? Diplomdagi xatoni tuzatish kerak.",
		answer:
			"Diplom yoki ilovasining dublikatini olish, undagi xatoni tuzatish uchun odatda diplomni bergan muassasaga murojaat qilinadi. Muassasa tugatilgan yoki u yerda hal bo'lmayotgan bo'lsa, tafsilotlarni aytsangiz, murojaatingizni ro'yxatga olaman.",
		tags: ["diplom", "dublikat", "hujjat", "диплом", "дубликат", "diploma"],
		priority: 10,
	},
	{
		question:
			"Pora so'rashyapti. Korrupsiya haqida xabar bermoqchiman. O'qituvchi pul talab qilyapti.",
		answer:
			"Bunday xabarni jiddiy qabul qilamiz. Qaysi muassasada, qachon va qanday holat bo'lganini aytsangiz, murojaatingizni alohida belgilab mas'ul bo'limga yuboraman.",
		tags: ["korrupsiya", "pora", "suiiste'mol", "коррупция", "взятка", "corruption"],
		priority: 10,
	},

	// ------------------------------------------------------------ priority 5-8
	{
		question:
			"Universitetdan shikoyat qilmoqchiman. O'qituvchi bahoni nohaq qo'ydi. Dekanat muammoni hal qilmayapti.",
		answer:
			"Shikoyatingizni qabul qilaman. Muassasa nomi, fakultet, holat qachon va qanday bo'lganini aytsangiz, murojaatni ro'yxatga olib, o'rganish uchun mas'ul bo'limga yuboraman.",
		tags: [
			"shikoyat",
			"universitet",
			"o'qituvchi",
			"baho",
			"dekanat",
			"жалоба на вуз",
			"complaint",
		],
		priority: 8,
	},
	{
		question:
			"Chet elda o'qiganman, diplomimni tan oldirishim kerak. Nostrifikatsiya qanday qilinadi? Xorijiy diplomni tasdiqlash.",
		answer:
			"Chet elda olingan ta'lim hujjatlarini tan olish belgilangan tartibda, ariza va hujjatlar asosida amalga oshiriladi. Qaysi davlatda va qaysi darajada tahsil olganingizni aytsangiz, savolingizni mas'ul bo'limga yuboraman.",
		tags: ["xorijiy diplom", "tan olish", "nostrifikatsiya", "признание диплома", "нострификация"],
		priority: 8,
	},
	{
		question:
			"Test natijam noto'g'ri chiqdi. Ballimga e'tirozim bor. Test natijalari qachon chiqadi?",
		answer:
			"Kirish test sinovlari va ularning natijalari bo'yicha rasmiy ma'lumot vakolatli tashkilot tomonidan e'lon qilinadi. Natijangiz bo'yicha e'tirozingiz bo'lsa, tafsilotlarni aytsangiz, murojaatingizni ro'yxatga olaman.",
		tags: ["test", "ball", "natija", "e'tiroz", "тест", "баллы", "апелляция"],
		priority: 7,
	},
	{
		question: "Magistraturaga qanday kiraman? Magistratura qabuli qachon? Magistraturada o'qish.",
		answer:
			"Magistraturaga qabul har yili e'lon qilinadigan tartib va muddatlarda o'tkaziladi. Aniq savolingizni aytsangiz, murojaat sifatida ro'yxatga olaman.",
		tags: ["magistratura", "magistr", "магистратура", "master"],
		priority: 7,
	},
	{
		question:
			"Doktoranturaga hujjat topshirmoqchiman. PhD qanday olinadi? Dissertatsiya himoyasi bo'yicha savolim bor.",
		answer:
			"Tayanch doktorantura, doktorantura va dissertatsiya himoyasi bo'yicha savolingizni qabul qilaman. Qaysi yo'nalishda ekaningiz va savolingiz mazmunini aytsangiz, mas'ul bo'limga yuboraman.",
		tags: ["doktorantura", "phd", "dsc", "dissertatsiya", "докторантура", "диссертация"],
		priority: 7,
	},
	{
		question:
			"Ilmiy grant tanlovi qachon? Ilmiy loyihaga moliyalashtirish olsa bo'ladimi? Grant natijalari.",
		answer:
			"Ilmiy loyihalar va grantlar tanlovlari e'lon qilinadi, shartlari tanlov e'lonida beriladi. Qaysi tanlov yoki loyiha haqida so'rayotganingizni aytsangiz, savolingizni ro'yxatga olaman.",
		tags: ["grant", "ilmiy loyiha", "tanlov", "moliyalashtirish", "грант", "научный проект"],
		priority: 7,
	},
	{
		question:
			"Startap loyiham bor, qo'llab-quvvatlash mumkinmi? Innovatsion g'oyam bor. Loyihamni taqdim qilmoqchiman.",
		answer:
			"Innovatsion loyiha yoki startapingiz bo'yicha murojaatingizni qabul qilaman. Loyihangiz nima haqida ekanini va bog'lanish ma'lumotlaringizni aytsangiz, mas'ul bo'limga yuboraman.",
		tags: ["startap", "innovatsiya", "g'oya", "стартап", "инновация", "startup"],
		priority: 6,
	},
	{
		question:
			"Ta'lim krediti olsam bo'ladimi? Kontrakt uchun kredit. Ta'lim kreditini qanday rasmiylashtiraman?",
		answer:
			"Ta'lim krediti banklar orqali belgilangan shartlarda beriladi, aniq shartlarni bank yoki o'qiyotgan muassasangizdan bilish mumkin. Kredit bilan bog'liq muammo bo'lsa, tafsilotlarni yozib olib mas'ul bo'limga yuboraman.",
		tags: ["ta'lim krediti", "kredit", "bank", "образовательный кредит", "student loan"],
		priority: 6,
	},
	{
		question:
			"Imtiyoz bormi? Nogironligim bor, kontraktda chegirma bormi? Yetim talabalarga imtiyozlar.",
		answer:
			"Ayrim toifadagi talabalar uchun qonunchilikda imtiyozlar nazarda tutilgan, ular muassasa tomonidan hujjatlar asosida qo'llanadi. Holatingizni aytsangiz, murojaatingizni mas'ul bo'limga yuboraman.",
		tags: ["imtiyoz", "chegirma", "nogironlik", "льгота", "скидка"],
		priority: 6,
	},
	{
		question:
			"Murojaatni internet orqali yuborsam bo'ladimi? Onlayn murojaat qilish mumkinmi? Telegram orqali yozsam bo'ladimi?",
		answer:
			"Murojaatni shu telefon liniyasi orqali ham, vazirlikning rasmiy onlayn kanallari orqali ham yuborish mumkin, qaysi yo'l bilan yuborsangiz ham u ro'yxatga olinib ko'rib chiqiladi. Xohlasangiz, hozir shu yerda qabul qilib qo'yaman.",
		tags: [
			"onlayn",
			"internet",
			"telegram",
			"elektron murojaat",
			"онлайн",
			"электронное обращение",
		],
		priority: 6,
	},
	{
		question: "Siz robotmisiz? Men kim bilan gaplashyapman? Siz sun'iy intellektmisiz?",
		answer:
			"Men vazirlikning sun'iy intellektga asoslangan virtual yordamchisiman. Murojaatingizni qabul qilib mas'ul xodimlarga yetkazaman, xohlasangiz jonli operatorga ham ulayman.",
		tags: ["robot", "sun'iy intellekt", "virtual yordamchi", "робот", "бот", "AI"],
		priority: 6,
	},
	{
		question:
			"Akademik ta'til olmoqchiman. Akademik otpusk berishmayapti. O'qishdan chetlashtirildim.",
		answer:
			"Akademik ta'til va o'qishdan chetlashtirish masalalari o'qiyotgan muassasangiz tomonidan belgilangan asoslar bo'yicha hal qilinadi. Muammo bo'lsa, tafsilotlarni aytsangiz, murojaat sifatida qabul qilaman.",
		tags: ["akademik ta'til", "otpusk", "chetlashtirish", "академический отпуск", "отчисление"],
		priority: 5,
	},
	{
		question:
			"Men o'qituvchiman, ish haqi bo'yicha savolim bor. Attestatsiya haqida so'ramoqchiman. Universitetga ishga kirmoqchiman.",
		answer:
			"Professor-o'qituvchilarning mehnat, ish haqi va attestatsiya masalalari bo'yicha murojaatingizni qabul qilaman. Muassasa nomi, lavozimingiz va masalani aytsangiz, mas'ul bo'limga yuboraman.",
		tags: [
			"o'qituvchi",
			"professor",
			"ish haqi",
			"attestatsiya",
			"преподаватель",
			"зарплата",
			"аттестация",
		],
		priority: 5,
	},
	{
		question:
			"Taklifim bor. Ta'lim tizimini yaxshilash bo'yicha fikrim bor. Tashabbus bildirmoqchiman.",
		answer:
			"Taklifingiz uchun rahmat. Uni to'liq aytsangiz, yozib olib mas'ul bo'limga yetkazaman.",
		tags: ["taklif", "tashabbus", "fikr", "предложение", "suggestion"],
		priority: 5,
	},
	{
		question: "Suhbat yozib olinyaptimi? Ma'lumotlarim kimga beriladi? Ismim sir saqlanadimi?",
		answer:
			"Suhbat xizmat sifatini nazorat qilish uchun yozib olinadi. Siz aytgan ma'lumotlar murojaatingizni ko'rib chiqish uchun ishlatiladi.",
		tags: [
			"yozib olish",
			"maxfiylik",
			"shaxsiy ma'lumot",
			"запись разговора",
			"конфиденциальность",
		],
		priority: 5,
	},
	{
		question: "Ismimni aytmasam bo'ladimi? Anonim murojaat qilsam bo'ladimi?",
		answer:
			"Murojaatingizga javob qaytarish uchun ism-familiyangiz va bog'lanish ma'lumotingiz kerak bo'ladi. Ularni aytishni istamasangiz ham xabaringizni yozib olaman, lekin bu holda sizga javob qaytarish imkoni cheklanadi.",
		tags: ["anonim", "ismsiz", "анонимно", "anonymous"],
		priority: 5,
	},
];
