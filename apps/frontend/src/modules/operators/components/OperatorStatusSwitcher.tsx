import {
	ApiOutlined,
	CheckCircleOutlined,
	ClockCircleOutlined,
	DownOutlined,
	LoadingOutlined,
	MinusCircleOutlined,
	StopOutlined,
	UserDeleteOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, type MenuProps, message, Tooltip } from "antd";
import { useCallback, useMemo, useState } from "react";
import { useSipStore } from "@/modules/calls/store/sip.store";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { OPERATOR_STATUS_LABELS } from "@/shared/utils/labels";
import type { OperatorStatus } from "../types";

export const operatorStatusConfig: Record<
	OperatorStatus,
	{ color: string; icon: React.ReactNode; label: string; bg: string; text: string }
> = {
	online: {
		color: "#10b981",
		icon: <CheckCircleOutlined />,
		label: OPERATOR_STATUS_LABELS.online,
		bg: "bg-emerald-50",
		text: "text-emerald-600",
	},
	offline: {
		color: "#6b7280",
		icon: <MinusCircleOutlined />,
		label: OPERATOR_STATUS_LABELS.offline,
		bg: "bg-slate-50",
		text: "text-slate-600",
	},
	pause: {
		color: "#f59e0b",
		icon: <ClockCircleOutlined />,
		label: OPERATOR_STATUS_LABELS.pause,
		bg: "bg-amber-50",
		text: "text-amber-600",
	},
	busy: {
		color: "#ef4444",
		icon: <StopOutlined />,
		label: OPERATOR_STATUS_LABELS.busy,
		bg: "bg-rose-50",
		text: "text-rose-600",
	},
};

/**
 * Sarlavhadagi operator holati almashtirgichi.
 *
 * Holat serverda (`PATCH /operator-profiles/me/status`) o'zgaradi. So'rov
 * yiqilsa muvaffaqiyat xabari CHIQMAYDI va ko'rsatilgan holat o'zgarmaydi —
 * avval har qanday holatda ham muvaffaqiyat xabari chiqardi, ya'ni bazada
 * hech narsa o'zgarmagan bo'lsa ham foydalanuvchi ishlagan deb o'ylardi.
 *
 * Operator profili yo'q foydalanuvchilarga (masalan supervisor) soxta "Onlayn"
 * emas, ochiq-oydin "Operator profili yo'q" ko'rsatiladi.
 */
export function OperatorStatusSwitcher() {
	const operatorStatus = useSipStore((s) => s.operatorStatus);
	const hasOperatorProfile = useSipStore((s) => s.hasOperatorProfile);
	const setOperatorStatus = useSipStore((s) => s.setOperatorStatus);
	const isRegistered = useSipStore((s) => s.isRegistered);
	const hasSoftphone = useSipStore((s) => s.hasSoftphone);
	const desiredOnline = useSipStore((s) => s.desiredOnline);
	const [isSaving, setIsSaving] = useState(false);

	// Operator online bo'lishni xohlaydi, lekin brauzer softfoni hali
	// registratsiyadan o'tmagan — ya'ni chaqiruvlarni amalda qabul qilolmaydi.
	const phoneUnreachable = hasSoftphone === true && desiredOnline && !isRegistered;

	const handleStatusChange = useCallback(
		async (status: OperatorStatus) => {
			setIsSaving(true);
			try {
				const result = await setOperatorStatus(status);
				if (result.deferred) {
					message.info("Softfon ulanmoqda — registratsiyadan so'ng avtomatik onlayn bo'lasiz");
				} else {
					message.success(`Holat "${operatorStatusConfig[status].label}" ga o'zgartirildi`);
				}
			} catch (error) {
				message.error(getApiErrorMessage(error, "Holatni o'zgartirib bo'lmadi"));
			} finally {
				setIsSaving(false);
			}
		},
		[setOperatorStatus]
	);

	const menuItems: MenuProps["items"] = useMemo(() => {
		return Object.entries(operatorStatusConfig).map(([key, cfg]) => ({
			key,
			label: (
				<div className="flex items-center gap-3 px-1 py-1">
					<span style={{ color: cfg.color }}>{cfg.icon}</span>
					<span className="font-bold text-slate-700">{cfg.label}</span>
				</div>
			),
			onClick: () => handleStatusChange(key as OperatorStatus),
		}));
	}, [handleStatusChange]);

	// Profil so'rovi hali tugamagan — hech qanday holat ko'rsatilmaydi.
	if (hasOperatorProfile === null) {
		return (
			<Button
				disabled
				className="flex h-10 items-center gap-2 rounded-xl border-none bg-slate-50 px-4 shadow-sm"
			>
				<LoadingOutlined className="text-slate-400" />
				<span className="text-xs font-bold uppercase tracking-wider text-slate-400">
					Yuklanmoqda
				</span>
			</Button>
		);
	}

	// Operator profili yo'q — holatni o'zgartirish mumkin emas.
	if (hasOperatorProfile === false) {
		return (
			<Tooltip title="Sizda operator profili yo'q — ichki raqam berilmagan. Holat faqat operatorlar uchun.">
				<Button
					disabled
					className="flex h-10 items-center gap-2 rounded-xl border-none bg-slate-50 px-4 shadow-sm"
				>
					<UserDeleteOutlined className="text-slate-400" />
					<span className="text-xs font-bold uppercase tracking-wider text-slate-400">
						Operator emas
					</span>
				</Button>
			</Tooltip>
		);
	}

	const config = operatorStatusConfig[operatorStatus];

	// Softfon ulanmagan bo'lsa, operator haqiqatan chaqiruv qabul qilolmasligini
	// ko'rsatamiz: "online" deb ko'rsatib, amalda erishib bo'lmaydigan holatni
	// yashirish eng yomoni.
	const button = (
		<Button
			loading={isSaving}
			className={`flex h-10 items-center gap-2 rounded-xl border-none px-4 shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98] ${
				phoneUnreachable ? "bg-amber-50" : config.bg
			}`}
		>
			{!isSaving &&
				(phoneUnreachable ? (
					<ApiOutlined className="text-amber-600" />
				) : (
					<span className={config.text}>{config.icon}</span>
				))}
			<span
				className={`text-xs font-bold uppercase tracking-wider ${
					phoneUnreachable ? "text-amber-600" : config.text
				}`}
			>
				{phoneUnreachable ? "Ulanmoqda" : config.label}
			</span>
			<DownOutlined
				className={`ml-1 text-[10px] ${phoneUnreachable ? "text-amber-600" : config.text} opacity-50`}
			/>
		</Button>
	);

	return (
		<Dropdown
			menu={{ items: menuItems }}
			trigger={["click"]}
			placement="bottomRight"
			disabled={isSaving}
		>
			{phoneUnreachable ? (
				<Tooltip title="Softfon hali ro'yxatdan o'tmagan — chaqiruvlar hozircha qabul qilinmaydi. Ulangach avtomatik onlayn bo'lasiz.">
					{button}
				</Tooltip>
			) : (
				button
			)}
		</Dropdown>
	);
}
