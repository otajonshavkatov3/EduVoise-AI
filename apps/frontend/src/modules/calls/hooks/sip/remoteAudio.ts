/**
 * Uzoq tomon ovozi — <audio> sink'i.
 *
 * WebRTC'da RTP kelishi yetarli emas: brauzer remote trekni faqat u biror
 * "sink"ka (media element yoki WebAudio) ulangandan keyin dekodlab chiqaradi.
 * Sink'siz qo'ng'iroq texnik jihatdan mukammal ishlaydi, lekin jim bo'ladi.
 *
 * NEGA ALOHIDA MODUL: sink'ni ikki joy ulaydi — asosiy sessiya (useSipSession) va
 * konsultatsiya sessiyasi (useSipTransfer). Har bir ulanish `pc`ga "track"
 * tinglovchisini qo'shadi, u esa sessiya tugaganda albatta olib tashlanishi kerak,
 * shuning uchun holat elementga bog'lab shu yerda saqlanadi.
 */

import { message } from "antd";
import type { Session } from "sip.js";

// biome-ignore lint/suspicious/noExplicitAny: SIP.js SDH internals
type SdhAny = any;

const BLOCKED_NOTICE_KEY = "sip-remote-audio-blocked";

/** Bitta <audio> elementiga bog'langan holat — `detachRemoteAudio` uchun kerak. */
interface RemoteAudioBinding {
	session: Session;
	stream: MediaStream;
	peerConnection: RTCPeerConnection | null;
	onTrack: (event: RTCTrackEvent) => void;
	gestureRetry: (() => void) | null;
}

const bindings = new WeakMap<HTMLAudioElement, RemoteAudioBinding>();
let blockedNoticeShown = false;

function getSdh(session: Session): SdhAny {
	return (session as SdhAny).sessionDescriptionHandler;
}

function getPeerConnection(session: Session): RTCPeerConnection | null {
	return (getSdh(session)?.peerConnection as RTCPeerConnection | undefined) ?? null;
}

/**
 * Sessiyadagi barcha jonli audio treklar.
 *
 * Ikki manba ham tekshiriladi: sip.js SDH streami (uni sip.js `ontrack`da yangilaydi)
 * va `pc.getReceivers()`. Bittasi kechikkan holatda ikkinchisi trekni beradi, shu
 * sababli ikkalasi birlashtiriladi va to'xtagan treklar tashlab yuboriladi.
 */
function collectRemoteAudioTracks(session: Session): MediaStreamTrack[] {
	const tracks = new Map<string, MediaStreamTrack>();

	const remoteStream = getSdh(session)?.remoteMediaStream as MediaStream | undefined;
	for (const track of remoteStream?.getAudioTracks() ?? []) {
		if (track.readyState !== "ended") {
			tracks.set(track.id, track);
		}
	}

	for (const receiver of getPeerConnection(session)?.getReceivers() ?? []) {
		const track = receiver.track;
		if (track?.kind === "audio" && track.readyState !== "ended") {
			tracks.set(track.id, track);
		}
	}

	return [...tracks.values()];
}

function syncStreamTracks(stream: MediaStream, tracks: MediaStreamTrack[]): void {
	// re-INVITE'da sip.js eski trekni to'xtatadi — jim trek elementda qolib ketmasin.
	for (const track of stream.getAudioTracks()) {
		if (track.readyState === "ended") {
			stream.removeTrack(track);
		}
	}
	for (const track of tracks) {
		if (!stream.getTrackById(track.id)) {
			stream.addTrack(track);
		}
	}
}

function showBlockedNotice(): void {
	if (blockedNoticeShown) {
		return;
	}
	blockedNoticeShown = true;
	message.warning({
		key: BLOCKED_NOTICE_KEY,
		content: "Brauzer ovozni to'sib qo'ydi — eshitish uchun sahifani bosing",
		duration: 0,
	});
}

/** Autoplay ogohlantirishini yopadi (ovoz eshitildi yoki qo'ng'iroq tugadi). */
export function clearAudioBlockedNotice(): void {
	if (!blockedNoticeShown) {
		return;
	}
	blockedNoticeShown = false;
	message.destroy(BLOCKED_NOTICE_KEY);
}

function clearGestureRetry(binding: RemoteAudioBinding): void {
	if (!binding.gestureRetry) {
		return;
	}
	document.removeEventListener("pointerdown", binding.gestureRetry);
	document.removeEventListener("keydown", binding.gestureRetry);
	binding.gestureRetry = null;
}

function armGestureRetry(element: HTMLAudioElement, binding: RemoteAudioBinding): void {
	if (binding.gestureRetry) {
		return;
	}
	const retry = () => {
		clearGestureRetry(binding);
		play(element, binding);
	};
	binding.gestureRetry = retry;
	document.addEventListener("pointerdown", retry);
	document.addEventListener("keydown", retry);
}

function play(element: HTMLAudioElement, binding: RemoteAudioBinding): void {
	element
		.play()
		.then(() => {
			clearGestureRetry(binding);
			clearAudioBlockedNotice();
		})
		.catch((error: unknown) => {
			// srcObject almashganda play() AbortError bilan uziladi — bu autoplay taqiqi emas.
			if (error instanceof DOMException && error.name === "AbortError") {
				return;
			}
			// Autoplay siyosati: sahifada hali bosish bo'lmasa play() rad etiladi.
			// Foydalanuvchi sukunat sababini bilishi kerak, keyingi bosishda esa
			// o'zi qayta urinadi — modal chiqarish shart emas.
			showBlockedNotice();
			armGestureRetry(element, binding);
		});
}

function createBinding(
	session: Session,
	element: HTMLAudioElement,
	sdh: SdhAny
): RemoteAudioBinding {
	// sip.js SDH `remoteMediaStream` — sessiya davomida o'zgarmas MediaStream: har bir
	// `ontrack`da treklarni sip.js o'zi almashtiradi (hold, re-INVITE, yo'naltirish).
	const stream = (sdh.remoteMediaStream as MediaStream | undefined) ?? new MediaStream();

	// Kech kelgan yoki qayta kelishilgan trek (early media, re-INVITE, hold'dan
	// qaytish, yo'naltirish) ham eshitilishi uchun. `element.muted` bu yerda
	// o'zgartirilmaydi — hold holati saqlanib qolishi kerak.
	const onTrack = (event: RTCTrackEvent) => {
		if (event.track.kind !== "audio") {
			return;
		}
		syncStreamTracks(stream, collectRemoteAudioTracks(session));
		if (element.srcObject !== stream) {
			element.srcObject = stream;
		}
		play(element, binding);
	};

	const binding: RemoteAudioBinding = {
		session,
		stream,
		peerConnection: null,
		onTrack,
		gestureRetry: null,
	};
	bindings.set(element, binding);
	return binding;
}

function bindPeerConnection(binding: RemoteAudioBinding, pc: RTCPeerConnection | null): void {
	if (!pc || binding.peerConnection === pc) {
		return;
	}
	// `pc.ontrack = ...` QILINMAYDI: bu xossani sip.js o'zi egallagan va uni
	// almashtirish `remoteMediaStream`ni, hold va transferni buzadi.
	binding.peerConnection?.removeEventListener("track", binding.onTrack);
	pc.addEventListener("track", binding.onTrack);
	binding.peerConnection = pc;
}

/**
 * Sessiya ovozini elementga ulaydi. Bir sessiya uchun qayta chaqirish xavfsiz —
 * tinglovchi ikkilanmaydi, faqat treklar qaytadan tekshiriladi va play() urinadi.
 */
export function attachRemoteAudio(session: Session, element: HTMLAudioElement | null): void {
	if (!element) {
		return;
	}
	const sdh = getSdh(session);
	if (!sdh) {
		// Sessiya hali media qatlamini yaratmagan — Established'da qayta chaqiriladi.
		return;
	}

	const previous = bindings.get(element);
	if (previous && previous.session !== session) {
		detachRemoteAudio(element);
	}

	const binding = bindings.get(element) ?? createBinding(session, element, sdh);
	bindPeerConnection(binding, getPeerConnection(session));
	syncStreamTracks(binding.stream, collectRemoteAudioTracks(session));

	// Sink hech qachon `muted` bo'lmaydi: jim autoplay har doim ruxsat etiladi va
	// aynan shu — tekshirilayotgan sukunat.
	element.muted = false;
	element.volume = 1;

	if (binding.stream.getAudioTracks().length === 0) {
		// Trek hali yo'q (INVITE ketdi, javob kelmadi). "track" tinglovchisi
		// qo'yilgan — trek kelganda ovoz o'zi ulanadi. Bo'sh stream elementga
		// berilmaydi, aks holda ba'zi brauzerlarda o'yinlash boshlanmay qoladi.
		return;
	}

	if (element.srcObject !== binding.stream) {
		element.srcObject = binding.stream;
	}
	play(element, binding);
}

/** Tinglovchilarni olib tashlaydi va elementni bo'shatadi (qo'ng'iroqlar orasida oqmasin). */
export function detachRemoteAudio(element: HTMLAudioElement | null): void {
	if (!element) {
		return;
	}
	const binding = bindings.get(element);
	if (binding) {
		binding.peerConnection?.removeEventListener("track", binding.onTrack);
		binding.peerConnection = null;
		clearGestureRetry(binding);
		bindings.delete(element);
	}
	element.pause();
	element.srcObject = null;
	// Keyingi qo'ng'iroq oldingi hold holatini meros qilib olmasin.
	element.muted = false;
}

/**
 * Hold/konsultatsiya vaqtida uzoq tomon ovozini o'chiradi.
 *
 * NEGA element `muted`, trek `enabled = false` emas: MediaRecorder trekdan yozadi,
 * shuning uchun trekni o'chirish yozuvga sukunat teshigi solib qo'yadi.
 */
export function setRemoteAudioMuted(element: HTMLAudioElement | null, muted: boolean): void {
	if (element) {
		element.muted = muted;
	}
}

/**
 * MediaRecorder uchun treklarning shaxsiy nusxasi.
 *
 * NEGA nusxa: yozuv davomida stream trek to'plami o'zgarsa (re-INVITE, hold)
 * spetsifikatsiya bo'yicha MediaRecorder yig'ilganini tashlab, InvalidModificationError
 * beradi. Sink jonli sip.js streamini oladi, yozuvchi esa qotib qolgan nusxani.
 */
export function createRemoteRecordingStream(session: Session): MediaStream | null {
	const tracks = collectRemoteAudioTracks(session);
	return tracks.length > 0 ? new MediaStream(tracks) : null;
}
