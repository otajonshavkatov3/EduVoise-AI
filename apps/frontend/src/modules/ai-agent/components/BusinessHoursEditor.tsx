import { DeleteOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Select, Switch } from "antd";
import type { TimeRange, WeekDayKey } from "../types";
import { timezoneOptions, WEEK_DAYS } from "../utils/labels";
import { type DayDraft, type DayMode, isValidTime, MAX_RANGES_PER_DAY } from "../utils/profileForm";

interface Props {
	enabled: boolean;
	timezone: string;
	days: Record<WeekDayKey, DayDraft>;
	onEnabledChange: (next: boolean) => void;
	onTimezoneChange: (next: string) => void;
	onDaysChange: (next: Record<WeekDayKey, DayDraft>) => void;
	disabled?: boolean;
	error?: string;
}

const MODE_OPTIONS: { value: DayMode; label: string }[] = [
	{ value: "hours", label: "Ish vaqti" },
	{ value: "closed", label: "Yopiq" },
	{ value: "allday", label: "Kun bo'yi ochiq" },
];

const WEEKDAY_KEYS: WeekDayKey[] = ["mon", "tue", "wed", "thu", "fri"];

function TimeInput({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	disabled: boolean;
}) {
	const invalid = value.trim().length > 0 && !isValidTime(value);

	return (
		<Input
			value={value}
			onChange={(event) => onChange(event.target.value)}
			disabled={disabled}
			placeholder="09:00"
			maxLength={5}
			status={invalid ? "error" : undefined}
			className="h-10 w-24 rounded-xl border-slate-200 bg-white text-center font-mono"
		/>
	);
}

/**
 * Ish vaqti muharriri.
 *
 * Uchta holat ataylab ko'rinib turadi — "Kun bo'yi ochiq" bilan "Yopiq" ni
 * adashtirib yuborish AI ni tunda ham javob beradigan holatga olib keladi.
 */
export function BusinessHoursEditor({
	enabled,
	timezone,
	days,
	onEnabledChange,
	onTimezoneChange,
	onDaysChange,
	disabled = false,
	error,
}: Props) {
	const patchDay = (key: WeekDayKey, next: DayDraft) => {
		onDaysChange({ ...days, [key]: next });
	};

	const setMode = (key: WeekDayKey, mode: DayMode) => {
		const current = days[key];
		const ranges: TimeRange[] =
			mode === "hours" && current.ranges.length === 0
				? [["09:00", "18:00"]]
				: current.ranges.map((range) => [range[0], range[1]] as TimeRange);

		patchDay(key, { mode, ranges: mode === "hours" ? ranges : [] });
	};

	const setRange = (key: WeekDayKey, index: number, position: 0 | 1, next: string) => {
		const ranges = days[key].ranges.map((range, current) => {
			if (current !== index) {
				return [range[0], range[1]] as TimeRange;
			}
			return position === 0 ? ([next, range[1]] as TimeRange) : ([range[0], next] as TimeRange);
		});

		patchDay(key, { mode: "hours", ranges });
	};

	// Server bir kunga ko'pi bilan MAX_RANGES_PER_DAY oraliq qabul qiladi.
	const addRange = (key: WeekDayKey) => {
		if (days[key].ranges.length >= MAX_RANGES_PER_DAY) {
			return;
		}

		patchDay(key, {
			mode: "hours",
			ranges: [...days[key].ranges, ["14:00", "18:00"]],
		});
	};

	const removeRange = (key: WeekDayKey, index: number) => {
		patchDay(key, {
			mode: "hours",
			ranges: days[key].ranges.filter((_, current) => current !== index),
		});
	};

	const applyWeekdayPreset = () => {
		const next = {} as Record<WeekDayKey, DayDraft>;

		for (const day of WEEK_DAYS) {
			next[day.key] = WEEKDAY_KEYS.includes(day.key)
				? { mode: "hours", ranges: [["09:00", "18:00"]] }
				: { mode: "closed", ranges: [] };
		}

		onDaysChange(next);
	};

	return (
		<div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-sm font-bold text-slate-900">Ish vaqti cheklovi</div>
					<div className="text-xs font-medium text-slate-500">
						O'chirilgan bo'lsa AI sutkaning har qanday vaqtida javob beradi
					</div>
				</div>
				<Switch checked={enabled} onChange={onEnabledChange} disabled={disabled} />
			</div>

			{enabled && (
				<div className="mt-4 space-y-3">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-[220px] flex-1">
							<div className="mb-1 text-[9px] font-black tracking-widest text-slate-400 uppercase">
								Vaqt mintaqasi
							</div>
							<Select
								value={timezone.length > 0 ? timezone : undefined}
								onChange={onTimezoneChange}
								options={timezoneOptions()}
								disabled={disabled}
								showSearch
								allowClear
								onClear={() => onTimezoneChange("")}
								placeholder="Asia/Tashkent"
								className="custom-select w-full"
								notFoundContent="Mintaqa topilmadi"
							/>
							<div className="mt-1 text-xs font-medium text-slate-500">
								Ma'lumot uchun saqlanadi: ish vaqti hozircha server soati bo'yicha tekshiriladi.
							</div>
						</div>
						<Button
							icon={<ThunderboltOutlined />}
							onClick={applyWeekdayPreset}
							disabled={disabled}
							className="h-10 rounded-xl px-4 font-bold"
						>
							Du–Ju 09:00–18:00
						</Button>
					</div>

					<div className="space-y-2">
						{WEEK_DAYS.map((day) => {
							const draft = days[day.key];

							return (
								<div
									key={day.key}
									className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2"
								>
									<span className="w-24 text-xs font-black text-slate-700">{day.label}</span>

									<Select<DayMode>
										value={draft.mode}
										onChange={(mode) => setMode(day.key, mode)}
										options={MODE_OPTIONS}
										disabled={disabled}
										className="custom-select w-40"
									/>

									{draft.mode === "hours" && (
										<div className="flex flex-wrap items-center gap-2">
											{draft.ranges.map((range, index) => (
												// Oraliqlar tartibi o'zgarmaydi, faqat qo'shiladi/o'chiriladi.
												// biome-ignore lint/suspicious/noArrayIndexKey: oraliqda barqaror id yo'q
												<div key={index} className="flex items-center gap-1">
													<TimeInput
														value={range[0]}
														onChange={(next) => setRange(day.key, index, 0, next)}
														disabled={disabled}
													/>
													<span className="text-slate-400">—</span>
													<TimeInput
														value={range[1]}
														onChange={(next) => setRange(day.key, index, 1, next)}
														disabled={disabled}
													/>
													{!disabled && (
														<Button
															type="text"
															size="small"
															icon={<DeleteOutlined />}
															onClick={() => removeRange(day.key, index)}
															className="text-slate-400 hover:text-rose-500"
														/>
													)}
												</div>
											))}

											{!disabled && draft.ranges.length < MAX_RANGES_PER_DAY && (
												<Button
													size="small"
													icon={<PlusOutlined />}
													onClick={() => addRange(day.key)}
													className="rounded-lg font-bold"
												>
													Oraliq
												</Button>
											)}
										</div>
									)}

									{draft.mode === "allday" && (
										<span className="text-xs font-medium text-slate-400">
											Bu kuni cheklov yo'q — AI istalgan vaqtda javob beradi
										</span>
									)}

									{draft.mode === "closed" && (
										<span className="text-xs font-medium text-slate-400">
											Bu kuni AI "ish vaqtidan tashqari" matnini aytadi
										</span>
									)}
								</div>
							);
						})}
					</div>

					{error && (
						<Alert
							type="error"
							showIcon
							className="rounded-xl border-rose-200 bg-rose-50"
							title={<span className="font-bold text-rose-600">{error}</span>}
						/>
					)}
				</div>
			)}
		</div>
	);
}
