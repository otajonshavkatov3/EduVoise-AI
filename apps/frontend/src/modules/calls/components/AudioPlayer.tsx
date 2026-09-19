import {
	CloudDownloadOutlined,
	PauseCircleFilled,
	PlayCircleFilled,
	SoundOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import { Button, Select, Slider, Tooltip, Typography } from "antd";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

const { Text } = Typography;

const SPEED_OPTIONS = [
	{ value: 0.5, label: "0.5x" },
	{ value: 0.75, label: "0.75x" },
	{ value: 1, label: "1x" },
	{ value: 1.25, label: "1.25x" },
	{ value: 1.5, label: "1.5x" },
	{ value: 2, label: "2x" },
];

/** Sekundlarni m:ss formatida ko'rsatish */
function formatClock(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return "0:00";
	}
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function safePlay(element: HTMLAudioElement | null): void {
	if (!element) {
		return;
	}
	const result = element.play();
	if (result && typeof result.catch === "function") {
		result.catch(() => {
			// Brauzer avtomatik o'ynatishni to'xtatgan bo'lishi mumkin — jim o'tamiz
		});
	}
}

export interface AudioPlayerHandle {
	/** Berilgan millisekundga o'tish (transkript qatorini bosganda) */
	seekTo: (ms: number) => void;
	play: () => void;
	pause: () => void;
	/** Joriy pozitsiya (ms) */
	currentMs: () => number;
}

interface Props {
	/** Yozuv manzili. null bo'lsa "yozuv yo'q" holati ko'rsatiladi. */
	src: string | null;
	/** Yuklab olish uchun fayl nomi */
	fileName?: string;
	/** Yozuvning ma'lum davomiyligi (sekund) — metadata kelmaguncha ko'rsatiladi */
	fallbackDuration?: number | null;
	/** Har bir vaqt o'zgarishida chaqiriladi (ms) */
	onProgress?: (ms: number) => void;
	/** Ixcham ko'rinish (jadval ichida) */
	compact?: boolean;
	/** Yuklab olish tugmasini ko'rsatish */
	showDownload?: boolean;
}

/**
 * Qayta ishlatiladigan audio pleer.
 * Yozuvlar ro'yxati va transkript sahifasi bir xil pleerdan foydalanadi.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
	{ src, fileName, fallbackDuration, onProgress, compact = false, showDownload = true },
	ref
) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [rate, setRate] = useState(1);
	const [volume, setVolume] = useState(100);
	const [hasError, setHasError] = useState(false);

	// Yangi yozuv kelganda pleer holatini tozalash.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `src` — prop; Biome forwardRef ichidagi komponentni tanimaydi va uni "tashqi qiymat" deb hisoblaydi
	useEffect(() => {
		setIsPlaying(false);
		setCurrentTime(0);
		setDuration(0);
		setHasError(false);
	}, [src]);

	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.playbackRate = rate;
		}
	}, [rate]);

	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.volume = volume / 100;
		}
	}, [volume]);

	useImperativeHandle(
		ref,
		() => ({
			seekTo: (ms: number) => {
				const element = audioRef.current;
				if (!element) {
					return;
				}
				element.currentTime = Math.max(0, ms / 1000);
				setCurrentTime(element.currentTime);
				safePlay(element);
			},
			play: () => safePlay(audioRef.current),
			pause: () => audioRef.current?.pause(),
			currentMs: () => Math.round((audioRef.current?.currentTime ?? 0) * 1000),
		}),
		[]
	);

	const handleToggle = useCallback(() => {
		const element = audioRef.current;
		if (!element) {
			return;
		}
		if (element.paused) {
			safePlay(element);
		} else {
			element.pause();
		}
	}, []);

	const handleSeek = useCallback((value: number) => {
		const element = audioRef.current;
		if (!element) {
			return;
		}
		element.currentTime = value;
		setCurrentTime(value);
	}, []);

	const effectiveDuration = duration || fallbackDuration || 0;

	if (!src) {
		return (
			<div className="flex items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3">
				<SoundOutlined className="text-slate-400" />
				<Text className="text-xs font-medium text-slate-500">Yozuv mavjud emas</Text>
			</div>
		);
	}

	return (
		<div className={`rounded-2xl border border-slate-100 bg-slate-50 ${compact ? "p-3" : "p-5"}`}>
			<audio
				ref={audioRef}
				src={src}
				preload="metadata"
				onLoadedMetadata={(event) => {
					const element = event.currentTarget;
					element.playbackRate = rate;
					element.volume = volume / 100;
					setDuration(Number.isFinite(element.duration) ? element.duration : 0);
				}}
				onTimeUpdate={(event) => {
					const seconds = event.currentTarget.currentTime;
					setCurrentTime(seconds);
					onProgress?.(Math.round(seconds * 1000));
				}}
				onPlay={() => setIsPlaying(true)}
				onPause={() => setIsPlaying(false)}
				onEnded={() => setIsPlaying(false)}
				onError={() => setHasError(true)}
			>
				<track kind="captions" />
			</audio>

			{hasError ? (
				<div className="flex items-center gap-2 text-rose-500">
					<WarningOutlined />
					<Text className="text-xs font-bold text-rose-500">
						Yozuvni yuklab bo'lmadi — fayl serverda topilmadi
					</Text>
				</div>
			) : (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<Button
							type="text"
							onClick={handleToggle}
							aria-label={isPlaying ? "Pauza" : "O'ynatish"}
							icon={
								isPlaying ? (
									<PauseCircleFilled className="text-3xl text-blue-600" />
								) : (
									<PlayCircleFilled className="text-3xl text-blue-600" />
								)
							}
							className="flex h-11 w-11 items-center justify-center rounded-full p-0 hover:bg-blue-50!"
						/>

						<div className="flex-1">
							<Slider
								min={0}
								max={Math.max(effectiveDuration, 1)}
								step={0.1}
								value={Math.min(currentTime, Math.max(effectiveDuration, 1))}
								onChange={handleSeek}
								tooltip={{ formatter: (value) => formatClock(Number(value ?? 0)) }}
								className="custom-slider m-0"
								styles={{ track: { backgroundColor: "#2154B2" } }}
							/>
						</div>

						<Text className="w-24 shrink-0 text-right font-mono text-xs font-bold text-slate-500">
							{formatClock(currentTime)} / {formatClock(effectiveDuration)}
						</Text>
					</div>

					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex items-center gap-2">
							<Text className="text-[10px] font-black uppercase tracking-widest text-slate-500">
								Tezlik
							</Text>
							<Select
								size="small"
								value={rate}
								options={SPEED_OPTIONS}
								onChange={setRate}
								className="w-20"
							/>
						</div>

						<div className="flex min-w-[140px] flex-1 items-center gap-2">
							<SoundOutlined className="text-slate-400" />
							<Slider
								min={0}
								max={100}
								value={volume}
								onChange={setVolume}
								className="custom-slider m-0 w-full"
								styles={{ track: { backgroundColor: "#64748b" } }}
								tooltip={{ formatter: (value) => `${value ?? 0}%` }}
							/>
						</div>

						{showDownload && (
							<Tooltip title="Yozuvni yuklab olish">
								<Button
									href={src}
									download={fileName}
									target="_blank"
									rel="noreferrer"
									icon={<CloudDownloadOutlined />}
									className="rounded-xl border-none bg-blue-50 font-bold text-blue-600 hover:bg-blue-100!"
								>
									Yuklash
								</Button>
							</Tooltip>
						)}
					</div>
				</div>
			)}
		</div>
	);
});
