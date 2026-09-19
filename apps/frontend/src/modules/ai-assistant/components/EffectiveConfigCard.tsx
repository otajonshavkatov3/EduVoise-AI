import { CheckCircleFilled, CloseCircleOutlined, LockOutlined } from "@ant-design/icons";
import { Alert, Card, Descriptions, type DescriptionsProps, Skeleton } from "antd";
import type { ReactNode } from "react";
import type { AiConfig } from "../types";

interface Props {
	config: AiConfig | undefined;
	isLoading: boolean;
	isError: boolean;
	errorMessage: string | null;
}

/**
 * Bu sahifadan o'zgartirib bo'lmaydigan qiymatlar — va faqat ular.
 *
 * Ilgari bu karta amaldagi konfiguratsiyani to'liq takrorlardi: ovoz, til,
 * model va chegaralar shu yerda ham, tahrirlash shaklida ham turardi. Ikki
 * joyda ko'rsatilgan bitta sozlama ertami-kechmi bir-biriga zid gapiradi
 * (masalan biri profil qiymatini, ikkinchisi .env qiymatini), shuning uchun
 * bu yerda faqat orchestrator ishga tushganda bog'lanadigan va shu sababli
 * haqiqatan restart talab qiladigan qiymatlar hamda kalitlar holati qoldi.
 */
interface RowSpec {
	key: string;
	label: string;
	value: ReactNode;
}

function KeyState({ configured, name }: { configured: boolean; name: string }) {
	return (
		<span className="flex items-center gap-2 text-sm font-bold text-slate-800">
			{configured ? (
				<CheckCircleFilled className="text-emerald-500" />
			) : (
				<CloseCircleOutlined className="text-rose-500" />
			)}
			<span className="font-mono text-xs">{name}</span>
			<span className={configured ? "text-emerald-600" : "text-rose-600"}>
				{configured ? "sozlangan" : "yo'q"}
			</span>
		</span>
	);
}

function configRows(config: AiConfig): RowSpec[] {
	return [
		{
			key: "ariApp",
			label: "ARI ilovasi",
			value: <span className="font-mono text-sm font-bold text-slate-800">{config.ariApp}</span>,
		},
		{
			key: "audioSocketAdvertiseHost",
			label: "AudioSocket manzili",
			value: (
				<span className="font-mono text-sm font-bold text-slate-800">
					{config.audioSocketAdvertiseHost}
				</span>
			),
		},
		{
			key: "googleKey",
			label: "Google kaliti",
			value: <KeyState configured={config.googleApiKeyConfigured} name="GOOGLE_AI_API_KEY" />,
		},
		{
			key: "openaiKey",
			label: "OpenAI kaliti",
			value: <KeyState configured={config.apiKeyConfigured} name="OPENAI_API_KEY" />,
		},
	];
}

function configItems(config: AiConfig): DescriptionsProps["items"] {
	return configRows(config).map((row) => ({
		key: row.key,
		label: (
			<span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">
				{row.label}
			</span>
		),
		children: row.value,
	}));
}

function CardShell({ children }: { children: ReactNode }) {
	return (
		<Card
			className="overflow-hidden rounded-2xl border-none shadow-sm"
			title={
				<div className="flex items-center gap-3">
					<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
						<LockOutlined />
					</div>
					<div>
						<div className="mb-1 text-sm leading-none font-black text-slate-900">
							Faqat .env orqali o'zgaradigan qiymatlar
						</div>
						<div className="text-[9px] leading-none font-bold tracking-widest text-slate-400 uppercase">
							Bu sahifadan tahrirlanmaydi
						</div>
					</div>
				</div>
			}
		>
			{children}
		</Card>
	);
}

export function EffectiveConfigCard({ config, isLoading, isError, errorMessage }: Props) {
	if (isLoading) {
		return (
			<CardShell>
				<Skeleton active paragraph={{ rows: 4 }} />
			</CardShell>
		);
	}

	if (isError || !config) {
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

	// Backend'ning o'z izohi: nima uchun aynan bu ikkitasi restart talab qiladi.
	const infrastructureNote = config.notes.find((note) => note.field === "ariApp")?.note;

	return (
		<CardShell>
			<Descriptions bordered size="small" column={1} items={configItems(config)} />

			{infrastructureNote && (
				<div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs leading-relaxed font-medium text-slate-500">
					{infrastructureNote}
				</div>
			)}
		</CardShell>
	);
}
