import type { ReactNode } from "react";

interface Props {
	label: string;
	/** Tayyor qiymat (tag, matn va h.k.). `null`/`undefined` bo'lsa `emptyText` chiqadi. */
	value?: ReactNode;
	/** Qiymat bo'lmaganda ko'rsatiladigan matn. Nol yoki soxta qiymat ishlatilmaydi. */
	emptyText?: string;
	icon?: ReactNode;
	mono?: boolean;
}

/**
 * Profil sahifasidagi bitta "yorliq → qiymat" qatori.
 *
 * Qiymat bo'lmasa, o'rniga hech qanday soxta ma'lumot qo'yilmaydi — faqat
 * kursiv holatda "ko'rsatilmagan" turidagi izoh chiqadi.
 */
export function ProfileField({ label, value, emptyText = "Ko'rsatilmagan", icon, mono }: Props) {
	const isEmpty = value === null || value === undefined || value === "";

	return (
		<div className="flex flex-col gap-1.5 border-b border-[#f1f5f9] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#64748b]">
				{icon}
				{label}
			</div>
			<div className="min-w-0 sm:text-right">
				{isEmpty ? (
					<span className="text-xs italic text-slate-400">{emptyText}</span>
				) : (
					<div
						className={`break-words font-semibold text-[#0f172a] ${mono ? "font-mono text-sm" : "text-sm"}`}
					>
						{value}
					</div>
				)}
			</div>
		</div>
	);
}
