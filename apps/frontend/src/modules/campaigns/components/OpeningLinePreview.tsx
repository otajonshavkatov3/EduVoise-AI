import { AudioOutlined, SoundOutlined, WarningOutlined } from "@ant-design/icons";
import { composeOpeningLine, type PreviewLanguage } from "../utils/openingLine";

interface Props {
	businessName: string;
	recordingNotice: string | null;
	language: PreviewLanguage;
	purpose: string;
	/** Ro'yxatdan olingan ism — qo'ng'iroq nomma-nom ekanini ko'rsatish uchun. */
	leadName?: string | null;
	/** false — bu kampaniya boshqa profil bilan gapiradi, yozuv ogohlantirishi noma'lum. */
	noticeKnown?: boolean;
}

/**
 * The whole point of the purpose field, made visible.
 *
 * Somebody typing into a box labelled "why are we calling" cannot hear what
 * comes out the other end. This shows it, sentence by sentence, with the part
 * they wrote highlighted and the parts the platform always says greyed - so it
 * is obvious that the identity sentence is not optional and that a phrase gets
 * wrapped into a sentence before it is spoken.
 */
export function OpeningLinePreview({
	businessName,
	recordingNotice,
	language,
	purpose,
	leadName,
	noticeKnown = true,
}: Props) {
	const line = composeOpeningLine({
		businessName,
		recordingNotice: noticeKnown ? recordingNotice : null,
		language,
		purpose,
		leadName,
	});

	return (
		<div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
			<div className="mb-3 flex items-center gap-2">
				<div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white">
					<SoundOutlined />
				</div>
				<div>
					<div className="text-sm font-black text-slate-900">
						Odam go'shakni ko'targanda nima eshitadi
					</div>
					<div className="text-[9px] font-bold tracking-widest text-slate-400 uppercase">
						Taxminiy matn — model ohangni bir oz o'zgartirishi mumkin
					</div>
				</div>
			</div>

			<div className="rounded-2xl rounded-bl-sm border border-blue-100 bg-white px-4 py-3">
				<div className="mb-2 flex items-center gap-2 text-[10px] font-black tracking-widest text-blue-500 uppercase">
					<AudioOutlined />
					Birinchi gap
				</div>
				<p className="m-0 text-sm leading-relaxed font-medium text-slate-500">
					{line.identity}{" "}
					{line.reason === null ? (
						<span className="rounded bg-amber-50 px-1 font-bold text-amber-600">
							[maqsad yozilmagan — AI nima uchun qo'ng'iroq qilganini ayta olmaydi]
						</span>
					) : (
						<span className="font-bold text-slate-900">{line.reason}</span>
					)}{" "}
					{line.notice !== null && <span>{line.notice} </span>}
					{line.handover}
				</p>
			</div>

			<div className="mt-3 flex flex-wrap items-start gap-2 text-xs font-medium text-slate-500">
				<WarningOutlined className="mt-0.5 text-slate-400" />
				<span className="flex-1">
					Qalin yozilgan qism — siz yozgan maqsad. Qolgani har doim aytiladi: AI kim nomidan
					qo'ng'iroq qilayotganini va mashina ekanini yashirmaydi, so'ngida esa vaqt so'raydi.
					{!noticeKnown && " Suhbat yozilishi haqidagi ogohlantirish tanlangan profildan olinadi."}
				</span>
			</div>
		</div>
	);
}
