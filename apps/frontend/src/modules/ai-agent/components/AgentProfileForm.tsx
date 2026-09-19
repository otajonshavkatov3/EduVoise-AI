import {
	ClockCircleOutlined,
	FileTextOutlined,
	MessageOutlined,
	QuestionCircleOutlined,
	SaveOutlined,
	ShopOutlined,
	SoundOutlined,
	TagsOutlined,
	UndoOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Input, InputNumber, Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiConfig } from "@/modules/ai-assistant/hooks/useAiAssistant";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useUpdateActiveAgentProfile } from "../hooks/useAiAgent";
import type { ActiveAgentProfile } from "../types";
import {
	FALLBACK_VOICES,
	humanizeMs,
	humanizeSeconds,
	LANGUAGE_OPTIONS,
	languageLabel,
} from "../utils/labels";
import {
	buildPatch,
	MAX_ADDITIONAL_LANGUAGES,
	MAX_TRANSFER_EXTENSIONS,
	type ProfileFormValues,
	profileWarnings,
	toFormValues,
	validateProfile,
} from "../utils/profileForm";
import { BusinessHoursEditor } from "./BusinessHoursEditor";
import { GreetingPreviewCard } from "./GreetingPreviewCard";
import { ProfileField, ProfileSection } from "./ProfileSection";
import { TagListEditor } from "./TagListEditor";
import { UnknownPolicyPicker } from "./UnknownPolicyPicker";

interface Props {
	profile: ActiveAgentProfile;
	canEdit: boolean;
}

/**
 * Biznes profili shakli.
 *
 * Hech bir maydon kodga qotib qolmagan: nom, yo'nalish, salomlashish, murojaat
 * turlari — hammasi shu yerdan bazaga yoziladi va keyingi qo'ng'iroqda ishlaydi.
 * Shuning uchun saqlash ataylab ochiq harakat: dirty holat kuzatiladi va faqat
 * o'zgargan maydonlar PATCH bilan yuboriladi.
 */
export function AgentProfileForm({ profile, canEdit }: Props) {
	const { message } = App.useApp();
	const update = useUpdateActiveAgentProfile();
	const configQuery = useAiConfig();

	// Serverdan kelgan holat — dirty tekshiruvi shu bilan solishtiriladi.
	const serverValues = useMemo(() => toFormValues(profile), [profile]);
	const [values, setValues] = useState<ProfileFormValues>(serverValues);
	const [formError, setFormError] = useState<string | null>(null);
	const [serverChangedWhileEditing, setServerChangedWhileEditing] = useState(false);

	/**
	 * Mazmun bo'yicha imzo — obyekt havolasi bo'yicha emas.
	 *
	 * `profile` har bir fon so'rovida YANGI obyekt bo'lib keladi, mazmuni bir xil
	 * bo'lsa ham. Ilgari effekt shu havolaga bog'langan edi, ya'ni so'rov eskirgach
	 * (staleTime 15 s — formani to'ldirish undan uzoqroq) React Query qayta
	 * so'raganda shakl yozilayotgan matnni o'chirib, eski holatiga qaytarardi.
	 */
	const serverSignature = useMemo(() => JSON.stringify(serverValues), [serverValues]);

	/**
	 * Shakl QABUL QILGAN holat — hozirgi server holati emas.
	 *
	 * Farq PATCH nimani yuborishida ko'rinadi. Diff eng yangi server holatiga
	 * qarab hisoblansa, siz tahrir qilib turganingizda server o'zgarsa, siz
	 * tegmagan maydonlar ham "o'zgargan" bo'lib chiqadi va yuboriladi. Baza
	 * sifatida oxirgi qabul qilingan holat turishi kerak: shunda patch aynan
	 * SIZ kiritgan o'zgarishlardan iborat bo'ladi.
	 */
	const [baseline, setBaseline] = useState<ProfileFormValues>(serverValues);
	const adoptedSignature = useRef(serverSignature);

	const patch = buildPatch(baseline, values);
	const isDirty = Object.keys(patch).length > 0;
	const dirtyRef = useRef(isDirty);

	dirtyRef.current = isDirty;

	/** Serverdan kelgan holatni to'liq qabul qilish. */
	const adopt = useCallback((next: ProfileFormValues) => {
		adoptedSignature.current = JSON.stringify(next);
		setBaseline(next);
		setValues(next);
		setServerChangedWhileEditing(false);
	}, []);

	useEffect(() => {
		if (adoptedSignature.current === serverSignature) {
			return;
		}

		// Saqlashdan keyin ham, boshqa supervisor tahriridan keyin ham shu yerga
		// kelinadi. Farqi bitta: agar foydalanuvchida saqlanmagan o'zgarish bo'lsa,
		// uni yo'q qilib yubormaymiz — xabar beramiz va tanlovni o'ziga qoldiramiz.
		if (dirtyRef.current) {
			setServerChangedWhileEditing(true);
			return;
		}

		adopt(serverValues);
	}, [serverSignature, serverValues, adopt]);
	const errors = validateProfile(values);
	const hasErrors = Object.keys(errors).length > 0;
	const warnings = profileWarnings(values);
	const disabled = !canEdit;

	/**
	 * Ovozlar — har birining o'lchangan telefon tiniqligi bilan.
	 *
	 * Bu tanlov «Holat va sozlamalar» tabidagi ovoz tanlovchisi bilan AYNAN bitta
	 * ustunni yozadi, shuning uchun ro'yxat ham bitta manbadan olinadi: aks holda
	 * bir joyda ovozning telefonda bo'g'iq eshitilishi ko'rinib, ikkinchi joyda
	 * ko'rinmay qolardi va tanlov o'sha yerda ko'r-ko'rona bo'lardi.
	 */
	const clarityByVoice = new Map(
		(configQuery.data?.data.voiceCatalog ?? []).map((option) => [option.name, option.phoneClarity])
	);
	const voiceOptions = Array.from(
		new Set([...(configQuery.data?.data.knownVoices ?? FALLBACK_VOICES), values.voice])
	)
		.filter((item) => item.length > 0)
		.map((item) => {
			const clarity = clarityByVoice.get(item);

			return { value: item, label: clarity ? `${item} — ${clarity}` : item };
		});

	const languageOptions = Array.from(
		new Set([...LANGUAGE_OPTIONS.map((item) => item.value), values.language])
	).map((code) => ({ value: code, label: `${languageLabel(code)} (${code})` }));

	const patchValues = (next: Partial<ProfileFormValues>) => {
		setValues((current) => ({ ...current, ...next }));
	};

	const handleSubmit = async () => {
		if (!isDirty) {
			message.info("O'zgarish kiritilmadi");
			return;
		}

		if (!profile.id) {
			setFormError("Profil hali yaratilmagan — sahifani yangilab qayta urinib ko'ring");
			return;
		}

		setFormError(null);

		try {
			const saved = await update.mutateAsync({ id: profile.id, patch });

			// Javobdagi holatni darhol o'z ichimizga olamiz: shakl endi "toza",
			// keyin keladigan fon so'rovi hech narsani qaytarib yubormaydi.
			adopt(toFormValues(saved));
			message.success("Saqlandi — keyingi qo'ng'iroq yangi sozlamalar bilan javob beradi");
		} catch (error) {
			setFormError(getApiErrorMessage(error, "Profilni saqlab bo'lmadi"));
		}
	};

	/** Serverdagi yangi holatni olib, o'z tahririni bekor qilish. */
	const discardAndReload = () => {
		adopt(serverValues);
		setFormError(null);
	};

	return (
		<div className="space-y-6">
			{serverChangedWhileEditing && (
				<Alert
					type="warning"
					showIcon
					className="rounded-2xl border-amber-200 bg-amber-50"
					message={
						<span className="font-bold text-amber-600">Profil boshqa joyda o'zgartirildi</span>
					}
					description={
						<div className="space-y-2 text-slate-600">
							<div>
								Sizda saqlanmagan o'zgarishlar bor, shuning uchun ular saqlab qolindi. Saqlasangiz
								sizning versiyangiz yoziladi.
							</div>
							<Button size="small" onClick={discardAndReload} className="rounded-lg font-bold">
								Serverdagi holatni yuklash
							</Button>
						</div>
					}
				/>
			)}

			<ProfileSection
				icon={<ShopOutlined />}
				title="Biznes haqida"
				subtitle="AI o'zini kim nomidan tanishtiradi"
			>
				<div className="space-y-4">
					<ProfileField
						label="Biznes nomi"
						hint="Salomlashishda aytiladi. Mijoz eshitadigan nom bo'lsin."
						error={errors.businessName}
					>
						<Input
							value={values.businessName}
							onChange={(event) => patchValues({ businessName: event.target.value })}
							disabled={disabled}
							maxLength={150}
							status={errors.businessName ? "error" : undefined}
							placeholder="Masalan: Oq Tish stomatologiyasi"
							className="h-12 rounded-xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>

					<ProfileField
						label="Yo'nalish"
						hint="AI ohangi va so'z boyligi shunga moslashadi."
						error={errors.industry}
					>
						<Input
							value={values.industry}
							onChange={(event) => patchValues({ industry: event.target.value })}
							disabled={disabled}
							maxLength={100}
							status={errors.industry ? "error" : undefined}
							placeholder="Masalan: taksi xizmati, stomatologiya klinikasi, do'kon"
							className="h-12 rounded-xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>

					<ProfileField
						label="Biznes nima qiladi"
						hint="O'z so'zlaringiz bilan yozing — AI shu matnni kontekst sifatida oladi. Narx va manzilni bu yerga yozmang, ular bilim bazasida bo'lishi kerak."
					>
						<Input.TextArea
							value={values.businessDescription}
							onChange={(event) => patchValues({ businessDescription: event.target.value })}
							disabled={disabled}
							rows={4}
							maxLength={2000}
							showCount
							placeholder="Masalan: Toshkentdagi xususiy stomatologiya klinikasi. Davolash, implantatsiya va bolalar stomatologiyasi."
							className="rounded-2xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>
				</div>
			</ProfileSection>

			<ProfileSection
				icon={<SoundOutlined />}
				title="Ovoz va til"
				subtitle="Qanday ovozda va qaysi tilda gaplashadi"
			>
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					<ProfileField label="Asosiy til" hint="Salomlashish va birinchi javoblar shu tilda.">
						<Select
							value={values.language}
							onChange={(next) => patchValues({ language: next })}
							options={languageOptions}
							disabled={disabled}
							showSearch
							className="custom-select w-full"
						/>
					</ProfileField>

					<ProfileField
						label="Ovoz"
						hint="Keyingi qo'ng'iroqda mijoz shu ovozni eshitadi. Yonidagi baho — shu tizimda o'lchangan telefon tiniqligi; namuna eshitish va to'liq o'lchov «Holat va sozlamalar» tabida."
					>
						<Select
							value={values.voice}
							onChange={(next) => patchValues({ voice: next })}
							options={voiceOptions}
							disabled={disabled}
							showSearch
							className="custom-select w-full"
							notFoundContent="Ovoz topilmadi"
						/>
					</ProfileField>

					<div className="md:col-span-2">
						<ProfileField
							label="Qo'shimcha tillar"
							hint={`Mijoz shu tillardan birida gapirsa, AI o'sha tilga o'tadi. Til kodini yozing: ru, en. Ko'pi bilan ${MAX_ADDITIONAL_LANGUAGES} ta.`}
							error={errors.additionalLanguages}
						>
							<TagListEditor
								value={values.additionalLanguages}
								onChange={(next) => patchValues({ additionalLanguages: next })}
								disabled={disabled}
								placeholder="ru"
								emptyHint="Qo'shimcha til yo'q — AI faqat asosiy tilda gaplashadi"
								normalize={(raw) => raw.toLowerCase().slice(0, 10)}
								color="purple"
								maxItems={MAX_ADDITIONAL_LANGUAGES}
							/>
						</ProfileField>
					</div>
				</div>
			</ProfileSection>

			<ProfileSection
				icon={<MessageOutlined />}
				title="Salomlashish"
				subtitle="Qo'ng'iroqning birinchi bir necha sekundi"
			>
				<div className="space-y-4">
					<GreetingPreviewCard values={values} />

					<ProfileField
						label="Salomlashish matni"
						hint="Bo'sh qoldirilsa biznes nomi asosida avtomatik matn ishlatiladi. Qisqa bo'lsin — mijoz uzun matnni kesib gapira boshlaydi."
					>
						<Input.TextArea
							value={values.greeting}
							onChange={(event) => patchValues({ greeting: event.target.value })}
							disabled={disabled}
							rows={3}
							maxLength={500}
							showCount
							placeholder='Assalomu alaykum! "Oq Tish" klinikasi, raqamli yordamchi eshitmoqda.'
							className="rounded-2xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>

					<ProfileField
						label="Yozib olish haqida ogohlantirish"
						hint="Salomlashishdan keyin bir marta aytiladi. Ba'zi bizneslar uchun majburiy."
					>
						<Input.TextArea
							value={values.recordingNotice}
							onChange={(event) => patchValues({ recordingNotice: event.target.value })}
							disabled={disabled}
							rows={2}
							maxLength={300}
							placeholder="Suhbat sifat nazorati uchun yozib olinadi."
							className="rounded-2xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>
				</div>
			</ProfileSection>

			<ProfileSection
				icon={<QuestionCircleOutlined />}
				title="Javob topilmasa"
				subtitle="AI hech qachon narx yoki manzilni o'zidan aytmaydi"
			>
				<div className="space-y-4">
					<Alert
						type="info"
						showIcon
						className="rounded-xl border-blue-100 bg-blue-50"
						title={
							<span className="font-bold text-blue-600">
								AI faqat bilim bazasidagi ma'lumotni aytadi
							</span>
						}
						description={
							<span className="text-slate-600">
								Bilim bazasida javob bo'lmasa, quyidagi qoida ishlaydi. Shuning uchun eng ko'p
								so'raladigan savollarni «Bilim bazasi» bo'limiga kiritib qo'ying.
							</span>
						}
					/>

					<UnknownPolicyPicker
						value={values.unknownPolicy}
						onChange={(next) => patchValues({ unknownPolicy: next })}
						disabled={disabled}
					/>

					<ProfileField
						label="Uzatiladigan ichki raqamlar"
						hint={`Tartib muhim: AI birinchisidan boshlab urinib ko'radi. Faqat raqam (masalan 101), ko'pi bilan ${MAX_TRANSFER_EXTENSIONS} ta.`}
						error={errors.transferExtensions}
					>
						<TagListEditor
							value={values.transferExtensions}
							onChange={(next) => patchValues({ transferExtensions: next })}
							disabled={disabled}
							placeholder="101"
							emptyHint="Ichki raqam kiritilmagan — «Operatorga uzatish» qoidasi uchun kamida bittasi kerak"
							color="cyan"
							maxItems={MAX_TRANSFER_EXTENSIONS}
						/>
					</ProfileField>
				</div>
			</ProfileSection>

			<ProfileSection
				icon={<TagsOutlined />}
				title="Murojaat turlari"
				subtitle="AI murojaat ochganda shu turlardan birini tanlaydi"
			>
				<ProfileField
					label="Turlar"
					hint="Faqat shu ro'yxatdagi turlar ishlatiladi. O'z biznesingiz tilida yozing: «Qabulga yozilish», «Buyurtma holati», «Shikoyat»."
					error={errors.ticketCategories}
				>
					<TagListEditor
						value={values.ticketCategories}
						onChange={(next) => patchValues({ ticketCategories: next })}
						disabled={disabled}
						placeholder="Qabulga yozilish"
						emptyHint="Kamida bitta tur kerak — AI murojaat ochganda shundan tanlaydi"
						color="blue"
						maxItems={20}
					/>
				</ProfileField>
			</ProfileSection>

			<ProfileSection
				icon={<ClockCircleOutlined />}
				title="Ish vaqti"
				subtitle="Ish vaqtidan tashqari qo'ng'iroqlar boshqacha kutib olinadi"
			>
				<div className="space-y-4">
					<BusinessHoursEditor
						enabled={values.hoursEnabled}
						timezone={values.timezone}
						days={values.days}
						onEnabledChange={(next) => patchValues({ hoursEnabled: next })}
						onTimezoneChange={(next) => patchValues({ timezone: next })}
						onDaysChange={(next) => patchValues({ days: next })}
						disabled={disabled}
						error={errors.hours}
					/>

					<ProfileField
						label="Ish vaqtidan tashqari matn"
						hint="Kechasi yoki dam olish kunida qo'ng'iroq qilgan mijoz shuni eshitadi."
					>
						<Input.TextArea
							value={values.afterHoursMessage}
							onChange={(event) => patchValues({ afterHoursMessage: event.target.value })}
							disabled={disabled}
							rows={3}
							maxLength={500}
							placeholder="Hozir ish vaqtimiz tugagan. Murojaatingizni yozib olaman, ertaga soat 9 dan keyin bog'lanamiz."
							className="rounded-2xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>
				</div>
			</ProfileSection>

			<ProfileSection
				icon={<FileTextOutlined />}
				title="Qo'shimcha ko'rsatmalar va chegaralar"
				subtitle="AI uchun qo'shimcha qoidalar"
			>
				<div className="space-y-4">
					<ProfileField
						label="Qo'shimcha ko'rsatmalar"
						hint="Har bir qatorga bitta qoida. Masalan: «Chegirma haqida gap ketsa administratorga uzat», «Hech qachon narx aytma»."
					>
						<Input.TextArea
							value={values.customInstructions}
							onChange={(event) => patchValues({ customInstructions: event.target.value })}
							disabled={disabled}
							rows={5}
							maxLength={4000}
							showCount
							placeholder="Narx haqida savolga faqat bilim bazasidagi narxni ayt, boshqa hech narsa aytma."
							className="rounded-2xl border-slate-200 bg-slate-50"
						/>
					</ProfileField>

					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<ProfileField
							label="Maksimal qo'ng'iroq (sekund)"
							hint={`Shu vaqtdan keyin AI suhbatni yakunlaydi — ${humanizeSeconds(values.maxCallSeconds)}.`}
							error={errors.maxCallSeconds}
						>
							<InputNumber
								value={values.maxCallSeconds}
								onChange={(next) => patchValues({ maxCallSeconds: Number(next ?? 0) })}
								disabled={disabled}
								min={60}
								max={7200}
								step={30}
								status={errors.maxCallSeconds ? "error" : undefined}
								className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
							/>
						</ProfileField>

						<ProfileField
							label="Sukunatdan keyin uzish (ms)"
							hint={`Mijoz jim qolsa — ${humanizeMs(values.silenceHangupMs)} kutadi.`}
							error={errors.silenceHangupMs}
						>
							<InputNumber
								value={values.silenceHangupMs}
								onChange={(next) => patchValues({ silenceHangupMs: Number(next ?? 0) })}
								disabled={disabled}
								min={3000}
								max={120000}
								step={1000}
								status={errors.silenceHangupMs ? "error" : undefined}
								className="h-12 w-full rounded-xl border-slate-200 bg-slate-50"
							/>
						</ProfileField>
					</div>
				</div>
			</ProfileSection>

			{warnings.length > 0 && (
				<Alert
					type="warning"
					showIcon
					className="rounded-2xl border-amber-200 bg-amber-50"
					title={<span className="font-bold text-amber-600">E'tibor bering</span>}
					description={
						<ul className="m-0 list-disc space-y-1 pl-4 text-slate-600">
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					}
				/>
			)}

			{formError && (
				<Alert
					type="error"
					showIcon
					closable
					onClose={() => setFormError(null)}
					className="rounded-2xl border-rose-200 bg-rose-50"
					title={<span className="font-bold text-rose-600">{formError}</span>}
				/>
			)}

			{canEdit && (
				<div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
					<Button
						type="primary"
						icon={<SaveOutlined />}
						loading={update.isPending}
						disabled={!isDirty || hasErrors}
						onClick={handleSubmit}
						className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
					>
						Saqlash
					</Button>
					<Button
						icon={<UndoOutlined />}
						onClick={discardAndReload}
						disabled={!isDirty || update.isPending}
						className="h-11 rounded-xl px-6 font-bold"
					>
						O'zgarishlarni tashlash
					</Button>

					<span className="text-xs font-bold text-slate-500">
						{hasErrors
							? "Xatolar tuzatilmaguncha saqlash mumkin emas"
							: isDirty
								? `${Object.keys(patch).length} maydon o'zgardi`
								: "Hamma o'zgarishlar saqlangan"}
					</span>
				</div>
			)}
		</div>
	);
}
