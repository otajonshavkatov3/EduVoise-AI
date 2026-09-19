import { CloseCircleOutlined, LockOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Skeleton } from "antd";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useUpdateAiConfig } from "../hooks/useAiAssistant";
import type { AiConfig, AiConfigUpdateResponse, ConfigField, ConfigNoteField } from "../types";
import {
	type AiConfigFormValues,
	buildPatch,
	changedFields,
	configWarnings,
	toFormValues,
	validateConfig,
} from "../utils/configForm";
import { configFieldLabels } from "../utils/labels";
import {
	AgentSection,
	CallLimitsSection,
	PostCallModelsSection,
	type SectionProps,
	SpeechStyleSection,
	TurnTakingSection,
	VoiceSection,
} from "./AiConfigSections";

interface Props {
	config: AiConfig | undefined;
	isLoading: boolean;
	isError: boolean;
	errorMessage: string | null;
	isSupervisor: boolean;
}

function fieldList(fields: ConfigField[]): string {
	return fields.map((field) => configFieldLabels[field]).join(", ");
}

function CardShell({ children }: { children: ReactNode }) {
	return <Card className="overflow-hidden rounded-2xl border-none shadow-sm">{children}</Card>;
}

/**
 * «Holat va sozlamalar» tabidagi yagona tahrirlash joyi.
 *
 * Bu yerdagi har bir boshqaruv haqiqiy: qiymat bazaga yoziladi (ovoz, til va
 * ikki chegara — faol biznes profiliga, qolganlari sozlamalar jadvaliga),
 * keyingi qo'ng'iroqdan boshlab ishlaydi va backend restartidan keyin ham
 * qoladi. Sahifada bir qiymatning ikkinchi, faqat o'qiladigan nusxasi ataylab
 * yo'q: bir qiymat — bitta joy, aks holda ikkalasi bir-biriga zid gapiradi.
 */
export function AiConfigForm({ config, isLoading, isError, errorMessage, isSupervisor }: Props) {
	const { message } = App.useApp();
	const update = useUpdateAiConfig();

	const serverValues = useMemo(() => (config ? toFormValues(config) : null), [config]);

	const [values, setValues] = useState<AiConfigFormValues | null>(serverValues);
	const [baseline, setBaseline] = useState<AiConfigFormValues | null>(serverValues);
	const [formError, setFormError] = useState<string | null>(null);
	const [serverChangedWhileEditing, setServerChangedWhileEditing] = useState(false);

	/**
	 * Mazmun bo'yicha imzo — obyekt havolasi bo'yicha emas.
	 *
	 * `config` har bir fon so'rovida yangi obyekt bo'lib keladi, mazmuni bir xil
	 * bo'lsa ham. Effekt havolaga bog'langanda tanlangan ovoz yoki surilgan
	 * slayder shu so'rovda jimgina eski holatiga qaytib qolardi (staleTime 30 s —
	 * sozlamalarni ko'rib chiqish undan uzoqroq davom etadi).
	 */
	const serverSignature = useMemo(
		() => (serverValues ? JSON.stringify(serverValues) : null),
		[serverValues]
	);

	/**
	 * Shakl QABUL QILGAN holat — hozirgi server holati emas.
	 *
	 * Diff eng yangi server holatiga qarab hisoblansa, siz tahrir qilib
	 * turganingizda server o'zgarsa, siz tegmagan maydonlar ham «o'zgargan»
	 * bo'lib chiqib, PATCH ga tushib ketardi.
	 */
	const adoptedSignature = useRef<string | null>(null);

	const changed = useMemo(
		() => (baseline && values ? changedFields(baseline, values) : []),
		[baseline, values]
	);
	const isDirty = changed.length > 0;
	const dirtyRef = useRef(isDirty);

	dirtyRef.current = isDirty;

	/** Serverdan kelgan holatni to'liq qabul qilish. */
	const adopt = useCallback((next: AiConfigFormValues) => {
		adoptedSignature.current = JSON.stringify(next);
		setBaseline(next);
		setValues(next);
		setServerChangedWhileEditing(false);
	}, []);

	useEffect(() => {
		if (serverValues === null || adoptedSignature.current === serverSignature) {
			return;
		}

		// Saqlanmagan tahrirni hech qachon o'chirmaymiz — xabar berib, tanlovni
		// foydalanuvchiga qoldiramiz (AgentProfileForm bilan bir xil qoida).
		// Birinchi to'ldirish bundan mustasno: u «boshqa joyda o'zgardi» emas.
		if (adoptedSignature.current !== null && dirtyRef.current) {
			setServerChangedWhileEditing(true);
			return;
		}

		adopt(serverValues);
	}, [serverSignature, serverValues, adopt]);

	const notesByField = useMemo(() => {
		const map = new Map<ConfigNoteField, string[]>();

		for (const note of config?.notes ?? []) {
			map.set(note.field, [...(map.get(note.field) ?? []), note.note]);
		}

		return map;
	}, [config]);

	const notesFor = useCallback((field: ConfigNoteField) => notesByField.get(field), [notesByField]);

	const patch = useCallback((next: Partial<AiConfigFormValues>) => {
		setValues((current) => (current ? { ...current, ...next } : current));
	}, []);

	if (isLoading || !(config || isError)) {
		return (
			<CardShell>
				<Skeleton active paragraph={{ rows: 8 }} />
			</CardShell>
		);
	}

	if (isError || !config || !values || !baseline) {
		return (
			<CardShell>
				<Alert
					type="error"
					showIcon
					icon={<CloseCircleOutlined className="text-rose-500" />}
					className="rounded-xl border-rose-200 bg-rose-50"
					message={<span className="font-bold text-rose-600">Konfiguratsiyani olib bo'lmadi</span>}
					description={
						<span className="text-slate-600">{errorMessage ?? "Server javob bermadi."}</span>
					}
				/>
			</CardShell>
		);
	}

	const errors = validateConfig(values);
	const hasErrors = Object.keys(errors).length > 0;
	const warnings = configWarnings(values, config);

	const sectionProps: SectionProps = {
		config,
		values,
		errors,
		changed: new Set(changed),
		disabled: !isSupervisor,
		notesFor,
		patch,
	};

	const reportResult = (result: AiConfigUpdateResponse["data"]) => {
		const saved = fieldList(result.changed);

		message.success(
			saved
				? `Saqlandi: ${saved} — keyingi qo'ng'iroqdan boshlab ishlaydi`
				: "Qiymatlar allaqachon shunday edi"
		);

		// Restart ro'yxati backenddan keladi: bu yerda qotib qolgan ro'yxat yo'q,
		// chunki qaysi maydon restart talab qilishini backend biladi.
		const restart = fieldList(result.config.restartRequiredFor);

		if (restart) {
			message.warning(`Backend restartini talab qiladi: ${restart}`);
		}
	};

	const handleSubmit = async () => {
		if (!isDirty) {
			message.info("O'zgarish kiritilmadi");
			return;
		}

		setFormError(null);

		try {
			const response = await update.mutateAsync(buildPatch(baseline, values));

			// Javobdagi holatni darhol qabul qilamiz: shakl «toza» bo'ladi va keyingi
			// fon so'rovi hech narsani qaytarib yubormaydi.
			adopt(toFormValues(response.data.config));
			reportResult(response.data);
		} catch (error) {
			setFormError(getApiErrorMessage(error, "Konfiguratsiyani saqlab bo'lmadi"));
		}
	};

	/** Serverdagi holatni olib, o'z tahririni bekor qilish. */
	const discardAndReload = () => {
		if (serverValues) {
			adopt(serverValues);
		}

		setFormError(null);
	};

	return (
		<div className="space-y-6">
			<StorageNotice restartRequiredFor={config.restartRequiredFor} />

			{!isSupervisor && (
				<Alert
					type="info"
					showIcon
					icon={<LockOutlined className="text-blue-500" />}
					className="rounded-2xl border-blue-100 bg-blue-50"
					message={
						<span className="font-bold text-blue-600">Faqat nazoratchi o'zgartira oladi</span>
					}
					description={
						<span className="text-slate-600">
							Sizning rolingizda qiymatlar ko'rinadi, lekin tahrirlash yopiq.
						</span>
					}
				/>
			)}

			{serverChangedWhileEditing && (
				<Alert
					type="warning"
					showIcon
					className="rounded-2xl border-amber-200 bg-amber-50"
					message={
						<span className="font-bold text-amber-600">Sozlama boshqa joyda o'zgartirildi</span>
					}
					description={
						<div className="space-y-2 text-slate-600">
							<div>
								Sizda saqlanmagan o'zgarish bor, shuning uchun u saqlab qolindi. Saqlasangiz sizning
								tanlovingiz yoziladi.
							</div>
							<Button size="small" onClick={discardAndReload} className="rounded-lg font-bold">
								Serverdagi holatni yuklash
							</Button>
						</div>
					}
				/>
			)}

			<AgentSection {...sectionProps} />
			<VoiceSection {...sectionProps} />
			<SpeechStyleSection {...sectionProps} />
			<TurnTakingSection {...sectionProps} />
			<CallLimitsSection {...sectionProps} />
			<PostCallModelsSection {...sectionProps} />

			{warnings.length > 0 && (
				<Alert
					type="warning"
					showIcon
					className="rounded-2xl border-amber-200 bg-amber-50"
					message={<span className="font-bold text-amber-600">E'tibor bering</span>}
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
					message={<span className="font-bold text-rose-600">{formError}</span>}
				/>
			)}

			{isSupervisor && (
				<SaveBar
					changed={changed}
					hasErrors={hasErrors}
					isSaving={update.isPending}
					onSave={handleSubmit}
					onDiscard={discardAndReload}
				/>
			)}
		</div>
	);
}

/**
 * Qiymatlar qayerda saqlanishi va nima restart talab qilishi.
 *
 * Restart ro'yxati backenddan keladi — bu yerda qotib qolgan ro'yxat yo'q.
 * Ilgari shu joyda «faqat xotirada saqlanadi, .env o'zgarmaydi» deb yozilgan
 * edi; qiymatlar endi bazada saqlanadi va restartdan keyin ham qoladi.
 */
function StorageNotice({ restartRequiredFor }: { restartRequiredFor: ConfigField[] }) {
	return (
		<Alert
			type="info"
			showIcon
			className="rounded-2xl border-blue-100 bg-blue-50"
			message={
				<span className="font-bold text-blue-600">
					Bu yerdagi o'zgarishlar saqlanadi va .env dan ustun turadi
				</span>
			}
			description={
				<div className="space-y-1 text-slate-600">
					<div>
						Qiymatlar bazaga yoziladi (ovoz, til va qo'ng'iroq chegaralari — faol biznes profiliga,
						qolganlari sozlamalar jadvaliga) va keyingi qo'ng'iroqdan boshlab ishlaydi. Backend
						restartidan keyin ham saqlanib qoladi. .env fayli o'zgarmaydi — u faqat boshlang'ich
						qiymat manbai bo'lib qoladi.
					</div>
					<div>
						{restartRequiredFor.length === 0
							? "Bu bo'limdagi hech bir maydon backend restartini talab qilmaydi."
							: `Restart talab qiladi: ${fieldList(restartRequiredFor)}.`}
					</div>
				</div>
			}
		/>
	);
}

function SaveBar({
	changed,
	hasErrors,
	isSaving,
	onSave,
	onDiscard,
}: {
	changed: ConfigField[];
	hasErrors: boolean;
	isSaving: boolean;
	onSave: () => void;
	onDiscard: () => void;
}) {
	const isDirty = changed.length > 0;
	const status = hasErrors
		? "Xatolar tuzatilmaguncha saqlash mumkin emas"
		: isDirty
			? `Saqlanmagan: ${fieldList(changed)}`
			: "Hamma o'zgarishlar saqlangan";

	return (
		<div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
			<Button
				type="primary"
				icon={<SaveOutlined />}
				loading={isSaving}
				disabled={!isDirty || hasErrors}
				onClick={onSave}
				className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
			>
				Saqlash
			</Button>
			<Button
				icon={<UndoOutlined />}
				onClick={onDiscard}
				disabled={!isDirty || isSaving}
				className="h-11 rounded-xl px-6 font-bold"
			>
				O'zgarishlarni tashlash
			</Button>

			<span className="text-xs font-bold text-slate-500">{status}</span>
		</div>
	);
}
