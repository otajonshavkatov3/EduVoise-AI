/**
 * One settings field, rendered from its registry metadata.
 *
 * How a field looks is decided purely by the `type` the backend reports - no
 * branch here keys off an individual setting name. A hardcoded key list used to
 * pick out the one multiline field, and it silently stopped matching anything the
 * day that key left the registry. If a multiline setting ever comes back, it
 * arrives as a new SettingValueType the backend declares, not as a name in here.
 */
import { Input, InputNumber, Switch, Tag } from "antd";

import type { SettingItem, SettingValue } from "../types";

interface Props {
	item: SettingItem;
	value: SettingValue;
	disabled: boolean;
	/** The user has typed into this secret field since the form was seeded. */
	secretTouched: boolean;
	onChange: (value: SettingValue) => void;
}

function FieldLabel({ item }: { item: SettingItem }) {
	return (
		<div className="mb-1.5 flex items-center gap-2">
			<span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
				{item.label}
			</span>
			{item.isDefault && (
				<Tag className="m-0 rounded-md border-slate-200 bg-slate-50 px-1.5 py-0 text-[9px] font-bold text-slate-400">
					standart
				</Tag>
			)}
		</div>
	);
}

/**
 * A stored secret is never sent to the browser, so the input starts empty and the
 * help text is the only place its state is described.
 */
function secretHint(item: SettingItem, typed: string, touched: boolean): string {
	if (!item.isSet) {
		return `${item.description} Hozircha kiritilmagan.`;
	}

	if (touched && typed.trim().length === 0) {
		return "Diqqat: bo'sh holda saqlansa saqlangan qiymat o'chiriladi.";
	}

	return `${item.description} Saqlangan qiymat mavjud — yangi qiymat kiritsangiz almashtiriladi.`;
}

function ToggleField({ item, value, disabled, onChange }: Omit<Props, "secretTouched">) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-4">
			<div>
				<div className="flex items-center gap-2">
					<span className="text-sm font-bold text-slate-900">{item.label}</span>
					{item.isDefault && (
						<Tag className="m-0 rounded-md border-slate-200 bg-white px-1.5 py-0 text-[9px] font-bold text-slate-400">
							standart
						</Tag>
					)}
				</div>
				<div className="text-xs text-slate-500">{item.description}</div>
			</div>
			<Switch checked={value === true} disabled={disabled} onChange={(next) => onChange(next)} />
		</div>
	);
}

function SecretField({ item, value, disabled, secretTouched, onChange }: Props) {
	const typed = typeof value === "string" ? value : "";
	const isClearing = secretTouched && typed.trim().length === 0 && item.isSet;

	return (
		<div>
			<FieldLabel item={item} />
			<Input.Password
				value={typed}
				disabled={disabled}
				autoComplete="new-password"
				placeholder={item.isSet ? "*** (saqlangan)" : "Kiritilmagan"}
				onChange={(event) => onChange(event.target.value)}
				className="h-11 rounded-xl"
			/>
			<p className={`mt-1.5 text-xs ${isClearing ? "text-amber-600" : "text-slate-500"}`}>
				{secretHint(item, typed, secretTouched)}
			</p>
		</div>
	);
}

function NumberField({ item, value, disabled, onChange }: Omit<Props, "secretTouched">) {
	return (
		<div>
			<FieldLabel item={item} />
			<InputNumber
				value={typeof value === "number" ? value : 0}
				disabled={disabled}
				// The registry owns the real bounds; an out-of-range value comes back as a
				// 400 naming the field rather than being silently clamped here.
				onChange={(next) => {
					if (typeof next === "number") {
						onChange(next);
					}
				}}
				className="h-11 w-full rounded-xl"
			/>
			<p className="mt-1.5 text-xs text-slate-500">{item.description}</p>
		</div>
	);
}

function TextField({ item, value, disabled, onChange }: Omit<Props, "secretTouched">) {
	const text = typeof value === "string" ? value : String(value);

	return (
		<div>
			<FieldLabel item={item} />
			<Input
				value={text}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				className="h-11 rounded-xl"
			/>
			<p className="mt-1.5 text-xs text-slate-500">{item.description}</p>
		</div>
	);
}

export function SettingField(props: Props) {
	if (props.item.type === "boolean") {
		return <ToggleField {...props} />;
	}

	if (props.item.type === "secret") {
		return <SecretField {...props} />;
	}

	if (props.item.type === "number") {
		return <NumberField {...props} />;
	}

	return <TextField {...props} />;
}

/** Booleans get a full-width row; the rest sit two-up on wide screens. */
export function isFullWidthSetting(item: SettingItem): boolean {
	return item.type === "boolean";
}
