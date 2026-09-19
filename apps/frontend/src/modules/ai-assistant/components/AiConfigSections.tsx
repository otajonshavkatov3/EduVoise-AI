import {
	AudioOutlined,
	ClockCircleOutlined,
	ExperimentOutlined,
	FileSearchOutlined,
	InfoCircleOutlined,
	RobotOutlined,
	SoundOutlined,
} from "@ant-design/icons";
import { Alert, AutoComplete, Button, Input, InputNumber, Select, Slider, Switch } from "antd";
import { TagListEditor } from "@/modules/ai-agent/components/TagListEditor";
import { humanizeMs, humanizeSeconds } from "@/modules/ai-agent/utils/labels";
import type { AiConfig, ConfigField, ConfigNoteField } from "../types";
import {
	type AiConfigFormValues,
	CONFIG_LIMITS,
	type ConfigFormErrors,
	MAX_TRANSFER_EXTENSIONS,
	RECOMMENDED_AUDIO,
} from "../utils/configForm";
import { languageLabel, providerKindLabels, vadEndLabels, vadStartLabels } from "../utils/labels";
import { ConfigSection, ConfigField as Field } from "./ConfigSection";
import { VoicePicker } from "./VoicePicker";

/**
 * Sozlamalar shaklining bo'limlari.
 *
 * Bo'limlar alohida komponent: bitta uzun render funksiyasi o'rniga har biri
 * o'z mavzusi bilan cheklangan, shuning uchun yangi maydon qaysi bo'limga
 * tushishi savol tug'dirmaydi. Holat va saqlash mantiqi AiConfigForm da qoladi.
 */
export interface SectionProps {
	config: AiConfig;
	values: AiConfigFormValues;
	errors: ConfigFormErrors;
	/** Saqlanmagan maydonlar — bo'lim sarlavhasidagi sanoq uchun. */
	changed: Set<ConfigField>;
	disabled: boolean;
	notesFor: (field: ConfigNoteField) => string[] | undefined;
	patch: (next: Partial<AiConfigFormValues>) => void;
}

const LANGUAGE_OPTIONS = ["uz", "ru", "en"];

/** speechConfig.languageCode uchun tayyor variantlar — istalgan kodni yozish ham mumkin. */
const SPEECH_LANGUAGE_OPTIONS = [
	{ value: "uz-UZ", label: "uz-UZ — o'zbekcha talaffuz" },
	{ value: "ru-RU", label: "ru-RU — ruscha talaffuz" },
	{ value: "en-US", label: "en-US — inglizcha talaffuz" },
	{ value: "kk-KZ", label: "kk-KZ — qozoqcha talaffuz" },
	{ value: "tr-TR", label: "tr-TR — turkcha talaffuz" },
];

/** Slayder belgilari butun sonlarda — aniq qiymat yonidagi maydonda ko'rinadi. */
const TEMPERATURE_MARKS = { 0: "0", 1: "1", 2: "2" };
const TOP_P_MARKS = { 0: "0", 1: "1" };
const SILENCE_MARKS = { 50: "50", 600: "600", 2000: "2000+" };
const PREFIX_MARKS = { 0: "0", 200: "200", 1000: "1000+" };
/** «0 — o'chiq» va tavsiya etilgan qiymat belgilangan: ikkalasi ham qaror nuqtasi. */
const PRESENCE_MARKS = { 0: "0 — o'chiq", 6: "6", 12: "12" };
const OUTPUT_GAIN_MARKS = { 0: "0", 3: "3", 12: "12" };

/** Slayder + aniq qiymat: dial ekanini ko'rsatadi, lekin aniq raqamni ham beradi. */
function SliderInput({
	value,
	onChange,
	min,
	max,
	step,
	sliderMax,
	marks,
	disabled,
}: {
	value: number;
	onChange: (next: number) => void;
	min: number;
	max: number;
	step: number;
	/** Slayder odatda ishlatiladigan diapazonni ko'rsatadi; maydon to'liq chegarani. */
	sliderMax?: number;
	marks: Record<number, string>;
	disabled: boolean;
}) {
	return (
		<div className="flex items-center gap-4">
			<Slider
				value={value}
				onChange={onChange}
				min={min}
				max={sliderMax ?? max}
				step={step}
				disabled={disabled}
				marks={marks}
				className="flex-1"
			/>
			<InputNumber
				value={value}
				onChange={(next) => onChange(Number(next ?? 0))}
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				className="h-11 w-24 shrink-0 rounded-xl border-slate-200 bg-slate-50"
			/>
		</div>
	);
}

function countIn(changed: Set<ConfigField>, fields: ConfigField[]): number {
	return fields.filter((field) => changed.has(field)).length;
}

export function AgentSection({
	config,
	values,
	errors,
	changed,
	disabled,
	notesFor,
	patch,
}: SectionProps) {
	const languageOptions = Array.from(new Set([...LANGUAGE_OPTIONS, values.language])).map(
		(code) => ({ value: code, label: `${languageLabel(code)} (${code})` })
	);

	const dialectHint = config.options.dialects.find(
		(option) => option.value === values.dialect
	)?.description;

	return (
		<ConfigSection
			icon={<RobotOutlined />}
			title="AI agent"
			subtitle="Kim javob beradi va qaysi tilda"
			changedCount={countIn(changed, [
				"enabled",
				"provider",
				"agentExtension",
				"language",
				"dialect",
			])}
		>
			<div className="space-y-4">
				<div className="flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-4">
					<div>
						<div className="text-sm font-bold text-slate-900">AI agent yoqilgan</div>
						<div className="text-xs text-slate-500">
							O'chirilganda kiruvchi qo'ng'iroqlar AI operatorga topshirilmaydi
						</div>
					</div>
					<Switch
						checked={values.enabled}
						onChange={(next) => patch({ enabled: next })}
						disabled={disabled}
					/>
				</div>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Field
						label="Ovozli provayder"
						hint="Ovozlar ro'yxati, model va gapirish sozlamalari shu tanlovga bog'liq."
						source={config.sources.provider}
						notes={notesFor("provider")}
					>
						<Select
							value={values.provider}
							onChange={(next: string) => patch({ provider: next })}
							options={config.options.providers.map((item) => ({
								value: item,
								label: providerKindLabels[item] ?? item,
							}))}
							disabled={disabled}
							className="custom-select w-full"
						/>
					</Field>

					<Field
						label="AI ichki raqami"
						hint="Backend shu raqamni «bu AI o'zi» deb biladi."
						error={errors.agentExtension}
						source={config.sources.agentExtension}
						notes={notesFor("agentExtension")}
					>
						<Input
							value={values.agentExtension}
							onChange={(event) => patch({ agentExtension: event.target.value })}
							disabled={disabled}
							maxLength={6}
							status={errors.agentExtension ? "error" : undefined}
							className="h-11 rounded-xl border-slate-200 bg-slate-50 font-mono"
						/>
					</Field>

					<Field
						label="Suhbat tili"
						hint="Platformaning o'z gaplari ham shu tilda aytiladi."
						error={errors.language}
						source={config.sources.language}
					>
						<Select
							value={values.language}
							onChange={(next: string) => patch({ language: next })}
							options={languageOptions}
							disabled={disabled}
							className="custom-select w-full"
						/>
					</Field>

					{/*
					 * Sheva — AI qanday GAPIRISHI emas, qanday TUSHUNISHI.
					 *
					 * AI barcha shevalarni har doim tushunadi va javobni har doim toza
					 * adabiy o'zbek tilida beradi; bu tanlov faqat «bu raqamga ko'proq
					 * qaysi viloyatdan qo'ng'iroq keladi» degan urg'uni beradi. Yorliq
					 * va izoh shuni aytishi shart — aks holda ekrandagi va'da bilan
					 * mijoz eshitadigan gap bir-biriga zid bo'ladi.
					 */}
					<Field
						label="Sheva — AI qaysi shevani tushunishi kerak"
						hint={dialectHint}
						source={config.sources.dialect}
						notes={notesFor("dialect")}
					>
						<Select
							value={values.dialect}
							onChange={(next: string) => patch({ dialect: next })}
							options={config.options.dialects.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
							disabled={disabled}
							className="custom-select w-full"
						/>
					</Field>
				</div>

				<div className="flex gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-relaxed font-medium text-slate-500">
					<InfoCircleOutlined className="mt-0.5 shrink-0 text-slate-400" />
					<span>
						AI shevada <span className="font-bold text-slate-600">gapirmaydi</span>. U barcha
						shevalarni — «hovva», «kelvotti», «opke», «qalesiz», «kelibman» — har doim tushunadi va
						javobni har doim toza adabiy o'zbek tilida beradi, mijozning so'zini takrorlamaydi. Bu
						yerdagi tanlov faqat shuni bildiradi: so'z ikki xil tushunilishi mumkin bo'lsa, avval
						o'sha viloyatdagi ma'nosi olinadi.
					</span>
				</div>
			</div>
		</ConfigSection>
	);
}

export function VoiceSection({
	config,
	values,
	errors,
	changed,
	disabled,
	notesFor,
	patch,
}: SectionProps) {
	const isGemini = values.provider === "gemini";

	return (
		<ConfigSection
			icon={<SoundOutlined />}
			title="Ovoz"
			subtitle="Mijoz eshitadigan ovoz, uning telefondagi tiniqligi va modeli"
			changedCount={countIn(changed, ["voice", "model", "audioPresenceDb", "audioOutputGainDb"])}
		>
			<div className="space-y-4">
				<Field
					label={`Ovoz — ${config.voiceCatalog.length} ta`}
					error={errors.voice}
					source={config.sources.voice}
					notes={notesFor("voice")}
				>
					<VoicePicker
						voices={config.voiceCatalog}
						value={values.voice}
						liveVoice={config.voice}
						disabled={disabled}
						previewEnabled={
							config.providerKind === "gemini" && config.googleApiKeyConfigured && !disabled
						}
						onChange={(voice) => patch({ voice })}
					/>
				</Field>

				<PhoneClarityGroup
					config={config}
					values={values}
					errors={errors}
					changed={changed}
					disabled={disabled}
					notesFor={notesFor}
					patch={patch}
				/>

				<Field
					label="Ovozli suhbat modeli"
					hint={
						isGemini
							? "Nomida «live» bo'lishi shart — boshqa Gemini modellarida real vaqtli endpoint yo'q."
							: "Nomida «realtime» bo'lishi shart — oddiy chat modeli ovozli sessiya ochmaydi."
					}
					error={errors.model}
					source={config.sources.model}
				>
					<Input
						value={values.model}
						onChange={(event) => patch({ model: event.target.value })}
						disabled={disabled}
						status={errors.model ? "error" : undefined}
						className="h-11 rounded-xl border-slate-200 bg-slate-50 font-mono"
					/>
				</Field>
			</div>
		</ConfigSection>
	);
}

/**
 * Telefon liniyasi uchun ovozga qo'llanadigan ishlov — ovoz tanlovining yonida.
 *
 * Bu yerda turishining sababi bor: «xira eshitilyapti» muammosini hal qiladigan
 * ikkita vosita — tiniqroq ovoz tanlash va shu filtr — bitta qarorning ikki
 * qismi. Ularni turli bo'limlarga ajratish egasini bittasini ko'rib, ikkinchisi
 * borligini bilmay qolishiga olib keladi.
 *
 * Atamalar ataylab muhandis tilida emas: «tiniqlik» va «balandlik», «biquad»
 * yoki «limiter» emas. Sonlar esa yashirilmaydi — ular o'lchovdan olingan.
 */
function PhoneClarityGroup({ config, values, errors, disabled, notesFor, patch }: SectionProps) {
	const isRecommended =
		values.audioPresenceDb === RECOMMENDED_AUDIO.presenceDb &&
		values.audioOutputGainDb === RECOMMENDED_AUDIO.outputGainDb;

	const presenceHint =
		values.audioPresenceDb === 0
			? "0 — filtr o'chiq: ovoz modeldan qanday chiqsa, mijoz shuni eshitadi."
			: `Hozir 2100 Hz atrofi ${values.audioPresenceDb} dB ko'tariladi. 6 dB — o'lchovga asoslangan standart, 8–10 dB — juda bo'g'iq ovozlar uchun.`;

	return (
		<div className="space-y-4 rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="text-sm font-black text-slate-900">Telefondagi tiniqlik</div>
					<div className="text-xs leading-relaxed font-medium text-slate-500">
						Telefon liniyasi faqat 300–3400 Hz ni o'tkazadi, so'zni ajratib turadigan undosh
						tovushlar esa shu oraliqning yuqorisida. O'lchov bo'yicha model ovozida aynan shu qism
						15–32 dB past — shuning uchun ovoz «xira» eshitiladi. Bu ikki sozlama o'sha qismni
						ko'taradi va balandlikni tenglashtiradi; keyingi qo'ng'iroqdan boshlab ishlaydi.
					</div>
				</div>

				{!(isRecommended || disabled) && (
					<Button
						size="small"
						onClick={() =>
							patch({
								audioPresenceDb: RECOMMENDED_AUDIO.presenceDb,
								audioOutputGainDb: RECOMMENDED_AUDIO.outputGainDb,
							})
						}
						className="shrink-0 rounded-lg font-bold"
					>
						Tavsiya etilgan qiymatlar ({RECOMMENDED_AUDIO.presenceDb} /{" "}
						{RECOMMENDED_AUDIO.outputGainDb} dB)
					</Button>
				)}
			</div>

			<Field
				label="Ovoz tiniqligi (dB)"
				hint={presenceHint}
				error={errors.audioPresenceDb}
				source={config.sources.audioPresenceDb}
				notes={notesFor("audioPresenceDb")}
			>
				<SliderInput
					value={values.audioPresenceDb}
					onChange={(next) => patch({ audioPresenceDb: next })}
					min={CONFIG_LIMITS.presenceDb.min}
					max={CONFIG_LIMITS.presenceDb.max}
					step={CONFIG_LIMITS.presenceDb.step}
					marks={PRESENCE_MARKS}
					disabled={disabled}
				/>
			</Field>

			<Field
				label="Chiquvchi ovoz balandligi (dB)"
				hint="Tiniqlik filtridan keyin qo'shiladigan balandlik. Ortida cheklagich turadi, shuning uchun ovoz baland bo'lsa ham xirillamaydi va qo'ng'iroq davomida bir tekis eshitiladi. 3 dB — tavsiya etilgan qiymat."
				error={errors.audioOutputGainDb}
				source={config.sources.audioOutputGainDb}
				notes={notesFor("audioOutputGainDb")}
			>
				<SliderInput
					value={values.audioOutputGainDb}
					onChange={(next) => patch({ audioOutputGainDb: next })}
					min={CONFIG_LIMITS.outputGainDb.min}
					max={CONFIG_LIMITS.outputGainDb.max}
					step={CONFIG_LIMITS.outputGainDb.step}
					marks={OUTPUT_GAIN_MARKS}
					disabled={disabled}
				/>
			</Field>
		</div>
	);
}

export function SpeechStyleSection({
	config,
	values,
	errors,
	changed,
	disabled,
	patch,
}: SectionProps) {
	const tokenHint =
		values.geminiMaxOutputTokens === 0
			? "0 — chegara yuborilmaydi, model o'z standartini ishlatadi."
			: "Audio ham token bilan o'lchanadi: kichik chegara javobni gap o'rtasida kesadi.";

	return (
		<ConfigSection
			icon={<ExperimentOutlined />}
			title="Gapirish uslubi"
			subtitle="Model qanchalik erkin va qanday talaffuzda gapiradi"
			changedCount={countIn(changed, [
				"geminiTemperature",
				"geminiTopP",
				"geminiMaxOutputTokens",
				"geminiLanguageCode",
			])}
		>
			<div className="space-y-5">
				{values.provider !== "gemini" && <NotGeminiNotice />}

				<Field
					label="Temperatura"
					hint="Past qiymat — bir xil, quruq javoblar; yuqori qiymat — jonli, lekin bilim bazasidan chetga chiqishga moyil. Odamiy suhbat uchun 0.7–1.0."
					error={errors.geminiTemperature}
					source={config.sources.geminiTemperature}
				>
					<SliderInput
						value={values.geminiTemperature}
						onChange={(next) => patch({ geminiTemperature: next })}
						min={CONFIG_LIMITS.temperature.min}
						max={CONFIG_LIMITS.temperature.max}
						step={CONFIG_LIMITS.temperature.step}
						marks={TEMPERATURE_MARKS}
						disabled={disabled}
					/>
				</Field>

				<Field
					label="topP"
					hint="So'z tanlashdagi ehtimollik chegarasi. 1 ga yaqin qiymat tabiiyroq ohang beradi."
					error={errors.geminiTopP}
					source={config.sources.geminiTopP}
				>
					<SliderInput
						value={values.geminiTopP}
						onChange={(next) => patch({ geminiTopP: next })}
						min={CONFIG_LIMITS.topP.min}
						max={CONFIG_LIMITS.topP.max}
						step={CONFIG_LIMITS.topP.step}
						marks={TOP_P_MARKS}
						disabled={disabled}
					/>
				</Field>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Field
						label="Bitta javobdagi eng ko'p token"
						hint={tokenHint}
						error={errors.geminiMaxOutputTokens}
						source={config.sources.geminiMaxOutputTokens}
					>
						<InputNumber
							value={values.geminiMaxOutputTokens}
							onChange={(next) => patch({ geminiMaxOutputTokens: Number(next ?? 0) })}
							min={CONFIG_LIMITS.maxOutputTokens.min}
							max={CONFIG_LIMITS.maxOutputTokens.max}
							step={CONFIG_LIMITS.maxOutputTokens.step}
							disabled={disabled}
							status={errors.geminiMaxOutputTokens ? "error" : undefined}
							className="h-11 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Field>

					<Field
						label="Ovoz tili kodi"
						hint="Model qaysi til talaffuzida gapiradi. Bo'sh qoldirilsa maydon yuborilmaydi va model tilni o'zi tanlaydi."
						error={errors.geminiLanguageCode}
						source={config.sources.geminiLanguageCode}
					>
						<AutoComplete
							value={values.geminiLanguageCode}
							onChange={(next: string) => patch({ geminiLanguageCode: next ?? "" })}
							options={SPEECH_LANGUAGE_OPTIONS}
							disabled={disabled}
							allowClear
							placeholder="uz-UZ"
							className="custom-select w-full"
						/>
					</Field>
				</div>
			</div>
		</ConfigSection>
	);
}

export function TurnTakingSection({
	config,
	values,
	errors,
	changed,
	disabled,
	patch,
}: SectionProps) {
	return (
		<ConfigSection
			icon={<AudioOutlined />}
			title="Navbat almashish"
			subtitle="AI mijozning gapini qachon kesadi va qachon javob boshlaydi"
			changedCount={countIn(changed, [
				"geminiVadStartSensitivity",
				"geminiVadEndSensitivity",
				"geminiVadPrefixPaddingMs",
				"geminiVadSilenceDurationMs",
			])}
		>
			<div className="space-y-5">
				{values.provider !== "gemini" && <NotGeminiNotice />}

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<Field
						label="Gap boshlanishini sezish"
						hint={vadStartLabels[values.geminiVadStartSensitivity]}
						source={config.sources.geminiVadStartSensitivity}
					>
						<Select
							value={values.geminiVadStartSensitivity}
							onChange={(next: string) => patch({ geminiVadStartSensitivity: next })}
							options={config.options.vadStartSensitivities.map((item) => ({
								value: item,
								label: item === "START_SENSITIVITY_HIGH" ? "Yuqori" : "Past",
							}))}
							disabled={disabled}
							className="custom-select w-full"
						/>
					</Field>

					<Field
						label="Gap tugaganini sezish"
						hint={vadEndLabels[values.geminiVadEndSensitivity]}
						source={config.sources.geminiVadEndSensitivity}
					>
						<Select
							value={values.geminiVadEndSensitivity}
							onChange={(next: string) => patch({ geminiVadEndSensitivity: next })}
							options={config.options.vadEndSensitivities.map((item) => ({
								value: item,
								label: item === "END_SENSITIVITY_HIGH" ? "Yuqori" : "Past",
							}))}
							disabled={disabled}
							className="custom-select w-full"
						/>
					</Field>
				</div>

				<Field
					label="Javobdan oldingi jimlik (ms)"
					hint={`Mijoz gapini tugatdi deb hisoblash uchun kerakli jimlik. Telefonda 400–800 ms odamiy tuyuladi. Hozir: ${values.geminiVadSilenceDurationMs} ms.`}
					error={errors.geminiVadSilenceDurationMs}
					source={config.sources.geminiVadSilenceDurationMs}
				>
					<SliderInput
						value={values.geminiVadSilenceDurationMs}
						onChange={(next) => patch({ geminiVadSilenceDurationMs: next })}
						min={CONFIG_LIMITS.vadSilenceDurationMs.min}
						max={CONFIG_LIMITS.vadSilenceDurationMs.max}
						sliderMax={2000}
						step={CONFIG_LIMITS.vadSilenceDurationMs.step}
						marks={SILENCE_MARKS}
						disabled={disabled}
					/>
				</Field>

				<Field
					label="Nutq boshidagi zaxira (ms)"
					hint="Nutq deb tan olinishidan oldingi audio ham hisobga olinadi — so'zning birinchi bo'g'ini yo'qolmaydi."
					error={errors.geminiVadPrefixPaddingMs}
					source={config.sources.geminiVadPrefixPaddingMs}
				>
					<SliderInput
						value={values.geminiVadPrefixPaddingMs}
						onChange={(next) => patch({ geminiVadPrefixPaddingMs: next })}
						min={CONFIG_LIMITS.vadPrefixPaddingMs.min}
						max={CONFIG_LIMITS.vadPrefixPaddingMs.max}
						sliderMax={1000}
						step={CONFIG_LIMITS.vadPrefixPaddingMs.step}
						marks={PREFIX_MARKS}
						disabled={disabled}
					/>
				</Field>
			</div>
		</ConfigSection>
	);
}

export function CallLimitsSection({
	config,
	values,
	errors,
	changed,
	disabled,
	notesFor,
	patch,
}: SectionProps) {
	return (
		<ConfigSection
			icon={<ClockCircleOutlined />}
			title="Qo'ng'iroq chegaralari"
			subtitle="Qachon gapira boshlaydi, qachon go'shakni qo'yadi"
			changedCount={countIn(changed, [
				"greetingDelayMs",
				"maxCallSeconds",
				"silenceHangupMs",
				"transferExtensions",
			])}
		>
			<div className="space-y-4">
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
					<Field
						label="Salomlashishdan oldingi pauza (ms)"
						hint="Juda kichik qiymat salomlashishning boshini kesadi, juda katta qiymat «jim liniya» taassurotini beradi."
						error={errors.greetingDelayMs}
						source={config.sources.greetingDelayMs}
					>
						<InputNumber
							value={values.greetingDelayMs}
							onChange={(next) => patch({ greetingDelayMs: Number(next ?? 0) })}
							min={CONFIG_LIMITS.greetingDelayMs.min}
							max={CONFIG_LIMITS.greetingDelayMs.max}
							step={CONFIG_LIMITS.greetingDelayMs.step}
							disabled={disabled}
							status={errors.greetingDelayMs ? "error" : undefined}
							className="h-11 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Field>

					<Field
						label="Qo'ng'iroqning eng uzun davomiyligi (sekund)"
						hint={`Shu vaqtdan keyin AI xayrlashib go'shakni qo'yadi — ${humanizeSeconds(values.maxCallSeconds)}.`}
						error={errors.maxCallSeconds}
						source={config.sources.maxCallSeconds}
						notes={notesFor("maxCallSeconds")}
					>
						<InputNumber
							value={values.maxCallSeconds}
							onChange={(next) => patch({ maxCallSeconds: Number(next ?? 0) })}
							min={CONFIG_LIMITS.maxCallSeconds.min}
							max={CONFIG_LIMITS.maxCallSeconds.max}
							step={CONFIG_LIMITS.maxCallSeconds.step}
							disabled={disabled}
							status={errors.maxCallSeconds ? "error" : undefined}
							className="h-11 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Field>

					<Field
						label="Jimlikdan keyin uzish (ms)"
						hint={`Liniyada harakat bo'lmasa — ${humanizeMs(values.silenceHangupMs)} kutadi.`}
						error={errors.silenceHangupMs}
						source={config.sources.silenceHangupMs}
					>
						<InputNumber
							value={values.silenceHangupMs}
							onChange={(next) => patch({ silenceHangupMs: Number(next ?? 0) })}
							min={CONFIG_LIMITS.silenceHangupMs.min}
							max={CONFIG_LIMITS.silenceHangupMs.max}
							step={CONFIG_LIMITS.silenceHangupMs.step}
							disabled={disabled}
							status={errors.silenceHangupMs ? "error" : undefined}
							className="h-11 w-full rounded-xl border-slate-200 bg-slate-50"
						/>
					</Field>
				</div>

				<Field
					label="Operatorlarga uzatish ro'yxati"
					hint="AI qo'ng'iroqni uzatishga harakat qiladigan ichki raqamlar. Bo'sh qoldirilsa yoqilgan SIP raqamlari ishlatiladi."
					error={errors.transferExtensions}
					source={config.sources.transferExtensions}
					notes={notesFor("transferExtensions")}
				>
					<TagListEditor
						value={values.transferExtensions}
						onChange={(next) => patch({ transferExtensions: next })}
						disabled={disabled}
						placeholder="101"
						emptyHint="Ro'yxat bo'sh — SIP jadvalidagi raqamlar ishlatiladi"
						maxItems={MAX_TRANSFER_EXTENSIONS}
						color="geekblue"
					/>
				</Field>
			</div>
		</ConfigSection>
	);
}

export function PostCallModelsSection({
	config,
	values,
	errors,
	changed,
	disabled,
	notesFor,
	patch,
}: SectionProps) {
	return (
		<ConfigSection
			icon={<FileSearchOutlined />}
			title="Qo'ng'iroqdan keyingi modellar"
			subtitle="Suhbat tugagach ishlaydigan matnli modellar"
			changedCount={countIn(changed, ["analysisModel", "transcribeModel"])}
		>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<Field
					label="Tahlil modeli"
					hint="Xulosa, kayfiyat va toifani yozadi. Oddiy matnli (chat) model bo'lishi kerak."
					error={errors.analysisModel}
					source={config.sources.analysisModel}
					notes={notesFor("analysisModel")}
				>
					<Input
						value={values.analysisModel}
						onChange={(event) => patch({ analysisModel: event.target.value })}
						disabled={disabled}
						status={errors.analysisModel ? "error" : undefined}
						className="h-11 rounded-xl border-slate-200 bg-slate-50 font-mono"
					/>
				</Field>

				<Field
					label="Transkripsiya modeli"
					hint="Nomida «transcribe» yoki «whisper» bo'lishi shart."
					error={errors.transcribeModel}
					source={config.sources.transcribeModel}
					notes={notesFor("transcribeModel")}
				>
					<Input
						value={values.transcribeModel}
						onChange={(event) => patch({ transcribeModel: event.target.value })}
						disabled={disabled}
						status={errors.transcribeModel ? "error" : undefined}
						className="h-11 rounded-xl border-slate-200 bg-slate-50 font-mono"
					/>
				</Field>
			</div>
		</ConfigSection>
	);
}

/** Gemini maydonlari OpenAI provayderida yuborilmaydi — buni yashirmaymiz. */
function NotGeminiNotice() {
	return (
		<Alert
			type="warning"
			showIcon
			className="rounded-xl border-amber-200 bg-amber-50"
			message={
				<span className="font-bold text-amber-600">
					Hozirgi provayder — OpenAI: bu bo'lim qo'llanmaydi
				</span>
			}
			description={
				<span className="text-slate-600">
					Qiymatlar saqlanadi va Gemini provayderiga qaytilganda ishlaydi.
				</span>
			}
		/>
	);
}
