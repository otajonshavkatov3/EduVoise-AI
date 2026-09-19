import { SendOutlined } from "@ant-design/icons";
import { Alert, Button } from "antd";
import { useState } from "react";

import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useTestTelegram } from "../hooks/useSettings";
import type { TelegramTestResult } from "../types";
import type { SettingsDraft } from "./SettingsSectionCard";

interface Props {
	draft: SettingsDraft;
	canEdit: boolean;
}

function readText(draft: SettingsDraft, key: string): string {
	const value = draft.values[key];
	return typeof value === "string" ? value : "";
}

export function TelegramTestPanel({ draft, canEdit }: Props) {
	const test = useTestTelegram();
	const [result, setResult] = useState<TelegramTestResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!canEdit) {
		return null;
	}

	const chatId = readText(draft, "notifications.telegram.chatId").trim();
	// Only a freshly typed token is sent; otherwise the stored one is used.
	const typedToken = draft.touchedSecrets["notifications.telegram.botToken"]
		? readText(draft, "notifications.telegram.botToken")
		: undefined;

	const handleTest = async () => {
		setError(null);
		setResult(null);

		try {
			const response = await test.mutateAsync({
				botToken: typedToken,
				chatId: chatId.length > 0 ? chatId : undefined,
			});
			setResult(response.data);
		} catch (caught) {
			setError(getApiErrorMessage(caught, "Tekshirib bo'lmadi"));
		}
	};

	return (
		<div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-sm font-bold text-slate-900">Telegramni tekshirish</div>
					<div className="text-xs text-slate-500">
						Saqlamasdan tekshiradi: token Telegram API orqali tasdiqlanadi va chat ID kiritilgan
						bo'lsa haqiqiy test xabari yuboriladi.
					</div>
				</div>
				<Button
					icon={<SendOutlined />}
					loading={test.isPending}
					onClick={handleTest}
					className="h-11 rounded-xl px-6 font-bold"
				>
					Tekshirish
				</Button>
			</div>

			{error && (
				<Alert
					type="error"
					showIcon
					className="mt-4 rounded-xl border-rose-200 bg-rose-50"
					title={<span className="font-bold text-rose-600">{error}</span>}
				/>
			)}

			{result && (
				<Alert
					type={result.ok ? "success" : "warning"}
					showIcon
					className={`mt-4 rounded-xl ${
						result.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
					}`}
					title={
						<span className={`font-bold ${result.ok ? "text-emerald-600" : "text-amber-600"}`}>
							{result.detail}
						</span>
					}
					description={
						<span className="text-xs text-slate-500">
							{result.botUsername === null ? "Bot aniqlanmadi" : `Bot: @${result.botUsername}`}
							{result.messageSent ? " · test xabari yuborildi" : " · xabar yuborilmadi"}
						</span>
					}
				/>
			)}
		</div>
	);
}
