import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Tooltip } from "antd";
import { explainFailure } from "../../utils/analysis";

interface Props {
	errorMessage: string | null;
	canRetry: boolean;
	/** Saqlangan matnda mijoz gapi bormi — yo'q bo'lsa qayta tahlil ma'nosiz. */
	retryPossible: boolean;
	isRetrying: boolean;
	onRetry: () => void;
}

const NO_TRANSCRIPT_HINT =
	"Mijoz gapi yozib olinmagan — qayta tahlil qilib bo'lmaydi. Xulosa o'ylab topilmaydi.";

/**
 * Nega bajarilmagani. Serverdagi asl matn har doim ko'rsatiladi; tanilgan
 * naqshlar uchun ustiga o'zbekcha izoh qo'shiladi.
 */
export function AnalysisFailureAlert({
	errorMessage,
	canRetry,
	retryPossible,
	isRetrying,
	onRetry,
}: Props) {
	const failure = explainFailure(errorMessage);

	if (!failure) {
		return (
			<Alert
				type="warning"
				showIcon
				className="rounded-2xl"
				message="Tahlil bajarilmadi"
				description="Server xato sababini saqlamagan."
			/>
		);
	}

	return (
		<Alert
			type="error"
			showIcon
			className="rounded-2xl"
			message={failure.title ?? "Tahlil bajarilmadi"}
			description={
				<div className="space-y-2">
					<div className="font-mono text-[11px] leading-relaxed text-slate-600">{failure.raw}</div>
					{canRetry && (
						<Tooltip
							title={
								retryPossible
									? "Saqlangan transkript qaytadan tahlil modeliga yuboriladi"
									: NO_TRANSCRIPT_HINT
							}
						>
							<Button
								size="small"
								type="primary"
								danger
								icon={<ReloadOutlined />}
								disabled={!retryPossible}
								loading={isRetrying}
								onClick={onRetry}
								className="rounded-xl font-bold"
							>
								Qayta tahlil qilish
							</Button>
						</Tooltip>
					)}
				</div>
			}
		/>
	);
}
