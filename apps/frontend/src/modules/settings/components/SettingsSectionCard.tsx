import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card } from "antd";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { getApiErrorMessage } from "@/shared/utils/apiError";
import { useUpdateSettings } from "../hooks/useSettings";
import type { SettingCategoryGroup, SettingItem, SettingValue } from "../types";
import { isFullWidthSetting, SettingField } from "./SettingField";

/** What the section currently holds, for a test panel that wants unsaved values. */
export interface SettingsDraft {
	values: Record<string, SettingValue>;
	touchedSecrets: Record<string, boolean>;
}

interface Props {
	group: SettingCategoryGroup;
	canEdit: boolean;
	/** Extra controls under the fields, e.g. an integration test button. */
	renderExtra?: (draft: SettingsDraft) => ReactNode;
}

/**
 * A secret is never delivered to the browser, so its input always starts empty
 * and is only sent when the user actually types in it.
 */
function seedValues(items: SettingItem[]): Record<string, SettingValue> {
	const values: Record<string, SettingValue> = {};

	for (const item of items) {
		values[item.key] = item.isSecret ? "" : item.value;
	}

	return values;
}

/**
 * Changes to this string mean the server values really moved (a save, or another
 * supervisor's edit). A plain refetch returning identical data leaves it alone, so
 * a window-focus refetch cannot wipe what the user is halfway through typing.
 */
function serverSignature(items: SettingItem[]): string {
	return items.map((item) => `${item.key}=${String(item.value)}|${item.isSet ? 1 : 0}`).join(";");
}

interface FieldRun {
	/** Full-width fields stack; the rest sit two-up in a grid. */
	full: boolean;
	items: SettingItem[];
}

/**
 * Group consecutive fields by width instead of hoisting all the toggles to the
 * top, so the form reads in the order the registry declares - "SMTP server"
 * before "SMTP uchun SSL/TLS", not the other way round.
 */
function toRuns(items: SettingItem[]): FieldRun[] {
	const runs: FieldRun[] = [];

	for (const item of items) {
		const full = isFullWidthSetting(item);
		const last = runs.at(-1);

		if (last && last.full === full) {
			last.items.push(item);
		} else {
			runs.push({ full, items: [item] });
		}
	}

	return runs;
}

export function SettingsSectionCard({ group, canEdit, renderExtra }: Props) {
	const { message } = App.useApp();
	const update = useUpdateSettings();

	const signature = serverSignature(group.items);
	const [seededSignature, setSeededSignature] = useState(signature);
	const [values, setValues] = useState<Record<string, SettingValue>>(() => seedValues(group.items));
	const [touchedSecrets, setTouchedSecrets] = useState<Record<string, boolean>>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [serverChangedWhileEditing, setServerChangedWhileEditing] = useState(false);
	/** O'z saqlashimiz keshni yangilaganini boshqa supervisor tahriridan ajratadi. */
	const ownSave = useRef(false);

	const changedKeys = useMemo(() => {
		return group.items
			.filter((item) => {
				if (item.isSecret) {
					return touchedSecrets[item.key] === true;
				}
				return values[item.key] !== item.value;
			})
			.map((item) => item.key);
	}, [group.items, values, touchedSecrets]);

	const reseed = () => {
		ownSave.current = false;
		setSeededSignature(signature);
		setValues(seedValues(group.items));
		setTouchedSecrets({});
		setFormError(null);
		setServerChangedWhileEditing(false);
	};

	// Adjusting state during render rather than in an effect: an effect would paint
	// one frame of stale inputs after a save. Unsaved edits are never thrown away -
	// somebody else's save raises a banner instead, the same rule AgentProfileForm
	// follows. Our own save always re-seeds: a secret still counts as "changed"
	// after it is written (the server never sends it back), so without the flag
	// saving a secret would raise the banner about ourselves.
	if (seededSignature !== signature) {
		if (ownSave.current || changedKeys.length === 0) {
			reseed();
		} else {
			setSeededSignature(signature);
			setServerChangedWhileEditing(true);
		}
	}

	const handleChange = (item: SettingItem, next: SettingValue) => {
		setValues((current) => ({ ...current, [item.key]: next }));

		if (item.isSecret) {
			setTouchedSecrets((current) => ({ ...current, [item.key]: true }));
		}
	};

	const handleReset = () => {
		reseed();
	};

	const handleSave = async () => {
		if (changedKeys.length === 0) {
			message.info("O'zgarish kiritilmadi");
			return;
		}

		const payload: Record<string, SettingValue> = {};

		for (const key of changedKeys) {
			payload[key] = values[key];
		}

		setFormError(null);
		ownSave.current = true;

		try {
			const response = await update.mutateAsync({ values: payload });
			const saved = response.data.changed.length;
			message.success(saved > 0 ? `${saved} sozlama saqlandi` : "Sozlamalar o'zgarmadi");
		} catch (error) {
			ownSave.current = false;
			setFormError(getApiErrorMessage(error, "Sozlamalarni saqlab bo'lmadi"));
		}
	};

	const runs = toRuns(group.items);
	const draft: SettingsDraft = { values, touchedSecrets };

	const renderField = (item: SettingItem) => (
		<SettingField
			key={item.key}
			item={item}
			value={values[item.key]}
			disabled={!canEdit || update.isPending}
			secretTouched={touchedSecrets[item.key] === true}
			onChange={(next) => handleChange(item, next)}
		/>
	);

	return (
		<Card
			className="border-none shadow-sm rounded-2xl overflow-hidden"
			title={
				<div className="flex items-center justify-between gap-4 py-1">
					<span className="text-sm font-black text-slate-900">{group.label}</span>
					{changedKeys.length > 0 && (
						<span className="text-[10px] font-bold uppercase tracking-widest text-amber-500">
							Saqlanmagan o'zgarish: {changedKeys.length}
						</span>
					)}
				</div>
			}
		>
			<div className="space-y-5">
				{serverChangedWhileEditing && (
					<Alert
						type="warning"
						showIcon
						className="rounded-xl border-amber-200 bg-amber-50"
						title={
							<span className="font-bold text-amber-600">
								Sozlamalar boshqa joyda o'zgartirildi
							</span>
						}
						description={
							<div className="space-y-2 text-slate-600">
								<div>
									Sizda saqlanmagan o'zgarish bor, shuning uchun u saqlab qolindi. Saqlasangiz
									sizning qiymatlaringiz yoziladi.
								</div>
								<Button size="small" onClick={handleReset} className="rounded-lg font-bold">
									Serverdagi holatni yuklash
								</Button>
							</div>
						}
					/>
				)}

				{!canEdit && (
					<Alert
						type="info"
						showIcon
						className="rounded-xl border-blue-100 bg-blue-50"
						title={
							<span className="font-bold text-blue-600">Faqat nazoratchi o'zgartira oladi</span>
						}
						description={
							<span className="text-slate-600">
								Sizning rolingizda bu bo'lim faqat ko'rish uchun ochiq.
							</span>
						}
					/>
				)}

				{runs.map((run) =>
					run.full ? (
						<div key={run.items[0].key} className="space-y-5">
							{run.items.map((item) => renderField(item))}
						</div>
					) : (
						<div key={run.items[0].key} className="grid grid-cols-1 gap-5 sm:grid-cols-2">
							{run.items.map((item) => renderField(item))}
						</div>
					)
				)}

				{formError && (
					<Alert
						type="error"
						showIcon
						closable={{ onClose: () => setFormError(null) }}
						className="rounded-xl border-rose-200 bg-rose-50"
						title={<span className="font-bold text-rose-600">{formError}</span>}
					/>
				)}

				{renderExtra?.(draft)}

				{canEdit && (
					<div className="flex flex-wrap gap-3 border-t border-slate-100 pt-5">
						<Button
							type="primary"
							icon={<SaveOutlined />}
							loading={update.isPending}
							disabled={changedKeys.length === 0}
							onClick={handleSave}
							className="h-11 rounded-xl px-6 font-bold shadow-lg shadow-blue-500/20"
						>
							Saqlash
						</Button>
						<Button
							icon={<ReloadOutlined />}
							onClick={handleReset}
							disabled={changedKeys.length === 0 || update.isPending}
							className="h-11 rounded-xl px-6 font-bold"
						>
							Bekor qilish
						</Button>
					</div>
				)}
			</div>
		</Card>
	);
}
