import {
	CheckOutlined,
	ExperimentOutlined,
	LoadingOutlined,
	PauseCircleFilled,
	PlayCircleFilled,
	SearchOutlined,
	SoundOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Segmented, Tag } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { getApiErrorMessage } from "@/shared/utils/apiError";
import { usePreviewVoice } from "../hooks/useAiAssistant";
import type { AiVoiceOption } from "../types";
import { phoneClarityTone } from "../utils/labels";

interface Props {
	voices: AiVoiceOption[];
	/** Shakldagi tanlov — hali saqlanmagan bo'lishi mumkin. */
	value: string;
	/** Serverdagi qiymat: keyingi qo'ng'iroqda mijoz aynan shu ovozni eshitadi. */
	liveVoice: string;
	disabled: boolean;
	/** Namuna faqat Gemini ovozlari uchun ishlaydi (TTS ham o'sha ovozlarni biladi). */
	previewEnabled: boolean;
	onChange: (voice: string) => void;
}

/** WAV base64 -> brauzer ijro eta oladigan Blob. */
function toAudioBlob(base64: string, mimeType: string): Blob {
	const binary = atob(base64);

	return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: mimeType });
}

/**
 * Ovoz telefonda qanchalik tushunarli eshitilishi — o'lchangan qiymat.
 *
 * Yorliqning o'zi ham, chegaralari ham backenddan keladi (`phoneClarity`), bu
 * yerda faqat rangi va aniq soni qo'shiladi: son ko'rsatilmasa «tiniq» degan
 * so'z provayderning maqtovidan farq qilmay qoladi.
 */
function ClarityTag({ voice }: { voice: AiVoiceOption }) {
	const tone = phoneClarityTone(voice.phoneClarity);

	return (
		<Tag
			color={tone.color}
			className="m-0 shrink-0 rounded-md border-none text-[9px] font-bold"
			title={
				voice.phoneClarityDb === null
					? "Bu ovoz telefon diapazonida o'lchanmagan"
					: `O'lchangan: undosh/unli nisbati ${voice.phoneClarityDb} dB (300–3400 Hz telefon filtri orqali)`
			}
		>
			{voice.phoneClarity}
			{voice.phoneClarityDb !== null && ` · ${voice.phoneClarityDb} dB`}
		</Tag>
	);
}

interface RowProps {
	voice: AiVoiceOption;
	/** Shaklda tanlangan (hali saqlanmagan bo'lishi mumkin). */
	isSelected: boolean;
	/** Serverda amalda turgan ovoz — keyingi qo'ng'iroqda shu eshitiladi. */
	isLive: boolean;
	isPlaying: boolean;
	isPending: boolean;
	previewBusy: boolean;
	disabled: boolean;
	previewEnabled: boolean;
	onSelect: () => void;
	onPreview: () => void;
}

function VoiceRow({
	voice,
	isSelected,
	isLive,
	isPlaying,
	isPending,
	previewBusy,
	disabled,
	previewEnabled,
	onSelect,
	onPreview,
}: RowProps) {
	const playIcon = isPlaying ? (
		<PauseCircleFilled className="text-blue-600" />
	) : (
		<PlayCircleFilled className="text-slate-400" />
	);

	return (
		<div
			className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
				isSelected
					? "border-blue-400 bg-blue-50/70"
					: "border-slate-100 bg-slate-50 hover:border-slate-200"
			}`}
		>
			<button
				type="button"
				disabled={disabled}
				onClick={onSelect}
				className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
			>
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-black text-slate-900">{voice.name}</span>
					{isSelected && <CheckOutlined className="shrink-0 text-xs text-blue-600" />}
					{isLive && (
						<Tag color="green" className="m-0 shrink-0 rounded-md border-none text-[9px] font-bold">
							HOZIR JONLI
						</Tag>
					)}
				</div>
				<div className="truncate text-xs font-medium text-slate-500">
					{voice.description || "—"}
					{voice.character && <span className="ml-1 text-slate-400">· {voice.character}</span>}
				</div>
				<div className="mt-1.5 flex">
					<ClarityTag voice={voice} />
				</div>
			</button>

			{previewEnabled && (
				<Button
					type="text"
					shape="circle"
					aria-label={`${voice.name} ovozini eshitish`}
					icon={isPending ? <LoadingOutlined /> : playIcon}
					disabled={previewBusy && !isPending}
					onClick={onPreview}
					className="shrink-0"
				/>
			)}
		</div>
	);
}

type SortMode = "clarity" | "name";

/**
 * Standart tartib — eng tiniqlari yuqorida.
 *
 * O'lchov bo'yicha eng tiniq va eng bo'g'iq ovoz orasida 12 dB farq bor, ya'ni
 * tanlov mahsulot sifatiga jiddiy ta'sir qiladi. Alifbo tartibida esa birinchi
 * o'nlikda («Achernar», «Aoede») aynan eng bo'g'iqlari turadi — shuning uchun
 * ro'yxat o'lchov bo'yicha saralanadi, alifboga qaytarish esa bir bosishda.
 */
function sortVoices(voices: AiVoiceOption[], mode: SortMode): AiVoiceOption[] {
	if (mode === "name") {
		return voices;
	}

	return [...voices].sort((left, right) => {
		// O'lchanmaganlar oxirida: null — «nol dB» emas, «ma'lum emas».
		const leftDb = left.phoneClarityDb ?? Number.NEGATIVE_INFINITY;
		const rightDb = right.phoneClarityDb ?? Number.NEGATIVE_INFINITY;

		return rightDb - leftDb || left.name.localeCompare(right.name);
	});
}

/**
 * O'ttiz ovozdan bittasini tanlash.
 *
 * Ro'yxat ataylab ochiq turadi — yopiq select ichida o'ttizta yulduz nomi
 * tanlab bo'lmaydigan ro'yxat: har birining xarakteri va telefondagi o'lchangan
 * tiniqligi yonida turishi kerak, qidiruv ham nomi, ham xarakteri, ham tiniqlik
 * yorlig'i bo'yicha ishlaydi («iliq» deb qidirilganda Sulafat, «tiniq» deb
 * qidirilganda telefonda tiniq eshitiladigan ovozlar chiqadi).
 */
export function VoicePicker({
	voices,
	value,
	liveVoice,
	disabled,
	previewEnabled,
	onChange,
}: Props) {
	const [search, setSearch] = useState("");
	const [sortMode, setSortMode] = useState<SortMode>("clarity");
	const [playing, setPlaying] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sampleText, setSampleText] = useState<string | null>(null);

	const preview = usePreviewVoice();
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const objectUrlRef = useRef<string | null>(null);

	/**
	 * Bitta ijro etuvchi va bitta ochiq Blob URL.
	 *
	 * Har bir namuna ~380 KB. Ularni yig'ib borish o'ttiz ovozda o'nlab megabayt
	 * bo'ladi, shuning uchun oldingi URL yangisidan oldin bo'shatiladi; takroriy
	 * eshitish backend keshidan (millisekundlar) keladi.
	 */
	useEffect(() => {
		const audio = new Audio();

		audio.addEventListener("ended", () => setPlaying(null));
		audio.addEventListener("error", () => setPlaying(null));
		audioRef.current = audio;

		return () => {
			audio.pause();
			audioRef.current = null;

			if (objectUrlRef.current) {
				URL.revokeObjectURL(objectUrlRef.current);
				objectUrlRef.current = null;
			}
		};
	}, []);

	/** Kamida bitta ovoz o'lchangan bo'lsa — saralash va izoh mazmunli. */
	const hasMeasurements = useMemo(
		() => voices.some((voice) => voice.phoneClarityDb !== null),
		[voices]
	);

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		const matching =
			needle.length === 0
				? voices
				: voices.filter((voice) =>
						`${voice.name} ${voice.character} ${voice.description} ${voice.phoneClarity}`
							.toLowerCase()
							.includes(needle)
					);

		return sortVoices(matching, hasMeasurements ? sortMode : "name");
	}, [voices, search, sortMode, hasMeasurements]);

	const stop = () => {
		audioRef.current?.pause();
		setPlaying(null);
	};

	const play = async (voice: string) => {
		if (playing === voice) {
			stop();
			return;
		}

		setError(null);
		setPending(voice);

		try {
			const response = await preview.mutateAsync({ voice });
			const audio = audioRef.current;

			if (!audio) {
				return;
			}

			if (objectUrlRef.current) {
				URL.revokeObjectURL(objectUrlRef.current);
			}

			const url = URL.createObjectURL(
				toAudioBlob(response.data.audioBase64, response.data.mimeType)
			);

			objectUrlRef.current = url;
			audio.src = url;
			setSampleText(response.data.text);
			await audio.play();
			setPlaying(voice);
		} catch (caught) {
			setError(getApiErrorMessage(caught, "Namunani tayyorlab bo'lmadi"));
			setPlaying(null);
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					allowClear
					prefix={<SearchOutlined className="text-slate-400" />}
					placeholder="Nomi, xarakteri yoki tiniqligi bo'yicha qidirish — «iliq», «qat'iy», «tiniq»"
					className="h-11 flex-1 rounded-xl border-slate-200 bg-slate-50"
				/>

				{hasMeasurements && (
					<Segmented<SortMode>
						value={sortMode}
						onChange={(next) => setSortMode(next)}
						options={[
							{ value: "clarity", label: "Avval tiniqlari" },
							{ value: "name", label: "Alifbo bo'yicha" },
						]}
						className="shrink-0 rounded-xl bg-slate-100 p-1 font-bold"
					/>
				)}
			</div>

			{filtered.length === 0 ? (
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={<span className="text-slate-500">Bunday ovoz topilmadi</span>}
				/>
			) : (
				<div className="grid max-h-[26rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
					{filtered.map((voice) => (
						<VoiceRow
							key={voice.name}
							voice={voice}
							isSelected={voice.name === value}
							isLive={voice.name === liveVoice}
							isPlaying={playing === voice.name}
							isPending={pending === voice.name}
							// Bir vaqtda bitta namuna tayyorlanadi: Google bu modelga
							// daqiqasiga 10 ta so'rovga ruxsat beradi.
							previewBusy={pending !== null}
							disabled={disabled}
							previewEnabled={previewEnabled}
							onSelect={() => onChange(voice.name)}
							onPreview={() => {
								// play() o'z ichida xatoni ushlaydi, shuning uchun bu promise
								// hech qachon rad etilmaydi.
								play(voice.name);
							}}
						/>
					))}
				</div>
			)}

			{error && (
				<Alert
					type="error"
					showIcon
					closable
					onClose={() => setError(null)}
					className="rounded-xl border-rose-200 bg-rose-50"
					message={<span className="font-bold text-rose-600">{error}</span>}
				/>
			)}

			{hasMeasurements && (
				<div className="flex gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-relaxed font-medium text-slate-500">
					<ExperimentOutlined className="mt-0.5 shrink-0 text-slate-400" />
					<span>
						<span className="font-bold text-slate-600">
							Tiniqlik — shu tizimda o'lchangan, provayderning va'dasi emas.
						</span>{" "}
						Har bir ovoz shu sahifaning o'z namunasi orqali o'qitilib, telefon diapazoniga (300–3400
						Hz) filtrlanadi va so'zni ajratib turadigan undosh tovushlar energiyasi (1200–3400 Hz)
						unli tovushlarnikiga (300–1200 Hz) taqqoslanadi. Son qanchalik nolga yaqin bo'lsa, mijoz
						so'zlarni shunchalik aniq ajratadi. Eng tiniq va eng bo'g'iq ovoz orasida 12 dB farq bor
						— bu tiniqlik filtri qo'sha oladigan darajadan bir necha barobar katta, ya'ni ovoz
						tanlash eng kuchli vosita. O'lchov xatosi ~1,4 dB, shuning uchun 4 dB dan kichik farqni
						sezilarli deb hisoblamang.
					</span>
				</div>
			)}

			{previewEnabled ? (
				<div className="flex gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-relaxed font-medium text-slate-500">
					<SoundOutlined className="mt-0.5 shrink-0 text-slate-400" />
					<span>
						Namuna Google'ning TTS modelida o'qiladi — ovoz aynan qo'ng'iroqdagi ovoz, lekin jonli
						suhbat sozlamalari (temperatura, VAD) va tiniqlik filtri unda ko'rinmaydi: ular jonli
						sessiyada qo'llanadi. Matn — biznes profilidagi salomlashish.
						{sampleText && <span className="block mt-1 text-slate-600">«{sampleText}»</span>}
					</span>
				</div>
			) : (
				<div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
					Ovoz namunasi faqat Gemini provayderida ishlaydi.
				</div>
			)}
		</div>
	);
}
