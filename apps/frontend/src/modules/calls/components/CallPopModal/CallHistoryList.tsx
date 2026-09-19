import { ClockCircleOutlined } from "@ant-design/icons";
import { List, Typography } from "antd";
import type { Call } from "../../types";

const { Text } = Typography;

interface CallHistoryListProps {
	history: Call[];
}

export function CallHistoryList({ history }: CallHistoryListProps) {
	return (
		<div>
			<div className="flex items-center gap-2 px-2 mb-3">
				<ClockCircleOutlined className="text-slate-400" />
				<Text className="font-bold text-slate-800 text-xs">Oxirgi qo'ng'iroqlar</Text>
			</div>
			<List
				dataSource={history}
				split={false}
				locale={{ emptyText: <span className="text-xs text-slate-400">Tarix yo'q</span> }}
				renderItem={(item: Call) => (
					<div
						key={item.id}
						className="flex justify-between items-center py-1.5 px-3 mb-1 hover:bg-blue-50 rounded-xl transition-all cursor-pointer border border-transparent hover:border-blue-100 shadow-xs"
					>
						<div>
							<div className="text-xs font-bold text-slate-700">
								{item.direction === "inbound" ? "Kiruvchi" : "Chiquvchi"}
							</div>
							<div className="text-[10px] text-slate-400">
								{new Date(item.startedAt).toLocaleDateString("uz-UZ", {
									month: "long",
									day: "numeric",
								})}
							</div>
						</div>
						<div className="text-[10px] font-bold text-blue-500 bg-blue-50 px-2 py-1 rounded-lg">
							{new Date(item.startedAt).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</div>
					</div>
				)}
			/>
		</div>
	);
}
