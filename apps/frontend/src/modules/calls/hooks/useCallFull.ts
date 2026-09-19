import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { callService } from "../services/call.service";

/**
 * Kartaning kesh kaliti prefiksi — `includeInterim` variantlarisiz.
 *
 * Tuzatish/qo'shish amallari shu prefiks bilan invalidate qiladi, shunda
 * oraliq qatorlar yoqilgan va o'chirilgan ikkala nusxa ham yangilanadi.
 */
export function callFullKey(id: string) {
	return ["calls", "full", id] as const;
}

/**
 * networkMode "always": backend LAN/localhost'da turadi, shuning uchun
 * brauzerning "offline" signaliga qarab so'rovni to'xtatib turish noto'g'ri —
 * sahifa xato o'rniga bo'sh karta ko'rsatib qolardi.
 *
 * keepPreviousData: oraliq qatorlarni yoqish kalitni o'zgartiradi, lekin butun
 * kartani bo'shatib yuborish kerak emas — eski nusxa yangi javob kelgunicha
 * ekranda qoladi.
 */
export function useCallFull(id: string, includeInterim: boolean) {
	return useQuery({
		queryKey: [...callFullKey(id), includeInterim],
		queryFn: () => callService.getFull(id, includeInterim),
		enabled: id.length > 0,
		networkMode: "always",
		placeholderData: keepPreviousData,
	});
}
