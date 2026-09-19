import { Card } from "antd";
import { Link } from "react-router-dom";
import { formatDateTime, formatDuration } from "@/shared/utils/datetime";
import { formatPhone } from "@/shared/utils/phoneFormat";
import type { CallFullCall } from "../../types/callFull";
import { Fact, FactGrid } from "./FactGrid";

/** Kutish soniyasi. 0 ham javob — shuning uchun null bilan aralashtirilmaydi. */
function waitLabel(waitSeconds: number | null): string | undefined {
	return waitSeconds === null ? undefined : `${waitSeconds} s`;
}

/**
 * Qo'ng'iroqning o'zi: kim, kimga, qachon, qancha.
 *
 * Operator biriktirilmagani uch xil ma'noni bildiradi: AI javob bergan, hech kim
 * javob bermagan, yoki qo'ng'iroq javobsiz qolgan. Faqat operator yo'qligiga
 * qarab "AI javob bergan" deyish javobsiz qo'ng'iroqni ham shunday belgilab
 * qo'yardi — shuning uchun AI sessiyasi bor-yo'qligi alohida so'raladi.
 */
export function CallSummaryCard({
	call,
	hasAiSession,
}: {
	call: CallFullCall;
	hasAiSession: boolean;
}) {
	const contactName = call.contactName?.trim();

	return (
		<Card className="mb-6 overflow-hidden rounded-2xl border-none shadow-sm">
			<FactGrid>
				<Fact
					label="Mijoz"
					value={
						call.contactId ? (
							<Link to={`/contacts/${call.contactId}`} className="font-bold text-blue-600">
								{contactName || "Nomi kiritilmagan"}
							</Link>
						) : (
							contactName
						)
					}
					empty="Kontakt biriktirilmagan"
				/>
				<Fact label="Raqam" value={formatPhone(call.callerNumber)} />
				<Fact
					label="Ichki raqam"
					value={call.calleeExtension ? `#${call.calleeExtension}` : undefined}
					empty="To'g'ridan-to'g'ri"
				/>
				<Fact
					label="Operator"
					value={call.operatorName}
					empty={hasAiSession ? "AI javob bergan" : "Biriktirilmagan"}
					hint={call.operator?.extension ? `#${call.operator.extension}` : undefined}
				/>
				<Fact label="Suhbat davomiyligi" value={formatDuration(call.duration)} />
				<Fact label="Boshlandi" value={formatDateTime(call.startedAt)} />
				<Fact
					label="Javob berildi"
					value={call.answeredAt ? formatDateTime(call.answeredAt) : undefined}
					empty="Javobsiz"
				/>
				<Fact label="Kutish" value={waitLabel(call.waitSeconds)} empty="Javob berilmagan" />
				<Fact
					label="Tugadi"
					value={call.endedAt ? formatDateTime(call.endedAt) : undefined}
					empty="Davom etmoqda"
				/>
				<Fact
					label="Murojaat"
					value={
						call.ticketId ? (
							<Link to={`/tickets/${call.ticketId}`} className="font-bold text-blue-600">
								#{call.ticketId.slice(0, 8)}
							</Link>
						) : undefined
					}
					empty="Yaratilmagan"
				/>
			</FactGrid>
		</Card>
	);
}
