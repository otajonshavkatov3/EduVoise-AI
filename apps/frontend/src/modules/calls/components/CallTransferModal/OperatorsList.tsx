import { UserOutlined } from "@ant-design/icons";
import { Avatar, List, Tag } from "antd";
import { OPERATOR_STATUS_LABELS } from "@/shared/utils/labels";

interface Operator {
	id: string;
	extension?: string;
	user?: { phone?: string };
	currentStatus?: string;
}

interface OperatorsListProps {
	operators: Operator[];
	isLoading: boolean;
	isCallEstablished: boolean;
	isTransferring: boolean;
	actionLabel: string;
	onSelect: (extension: string, label: string) => void;
}

export function OperatorsList({
	operators,
	isLoading,
	isCallEstablished,
	isTransferring,
	actionLabel,
	onSelect,
}: OperatorsListProps) {
	return (
		<List
			loading={isLoading}
			dataSource={operators}
			className="max-h-[280px] overflow-y-auto pr-1 custom-scrollbar"
			locale={{ emptyText: "Operator topilmadi" }}
			renderItem={(op) => {
				const ext = op.extension || "";
				const label = op.user?.phone || `Ext ${ext}`;
				const isOnline = op.currentStatus === "online";
				return (
					<button
						key={op.id}
						type="button"
						disabled={!ext || isTransferring || !isCallEstablished}
						onClick={() => {
							if (ext) {
								onSelect(ext, label);
							}
						}}
						className={`group flex items-center justify-between p-3 mb-2 rounded-2xl cursor-pointer transition-all border w-full text-left font-inherit disabled:opacity-40 disabled:cursor-not-allowed ${
							isCallEstablished && ext
								? "bg-slate-50 hover:bg-blue-50 border-transparent hover:border-blue-100"
								: "bg-slate-50 border-transparent"
						}`}
					>
						<div className="flex items-center gap-3">
							<div className="relative">
								<Avatar
									size={40}
									icon={<UserOutlined />}
									className="bg-blue-600 text-white rounded-xl shadow-sm"
								/>
								<div
									className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${
										isOnline ? "bg-emerald-400" : "bg-slate-300"
									}`}
								/>
							</div>
							<div>
								<div className="font-bold text-slate-800 text-sm leading-none mb-0.5">{label}</div>
								<div className="flex items-center gap-1.5">
									<Tag className="text-[9px] font-bold rounded-md border-none px-1.5 py-0 bg-blue-50 text-blue-500 m-0">
										№ {ext || "—"}
									</Tag>
									{isOnline && (
										<Tag className="text-[9px] font-bold rounded-md border-none px-1.5 py-0 bg-emerald-50 text-emerald-600 m-0">
											{OPERATOR_STATUS_LABELS.online}
										</Tag>
									)}
								</div>
							</div>
						</div>
						<div
							className={`text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-xl shadow-sm transition-all ${
								isCallEstablished && ext
									? "bg-white text-blue-500 opacity-0 group-hover:opacity-100"
									: "opacity-0"
							}`}
						>
							{actionLabel}
						</div>
					</button>
				);
			}}
		/>
	);
}
