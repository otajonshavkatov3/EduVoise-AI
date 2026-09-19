import { PhoneOutlined } from "@ant-design/icons";
import { Button, Empty, List, Typography } from "antd";
import type { Call } from "../../types";

const { Text } = Typography;

interface DialpadHistoryProps {
	calls: Call[];
	isLoading: boolean;
	onCall: (number: string) => void;
}

export function DialpadHistory({ calls, isLoading, onCall }: DialpadHistoryProps) {
	return (
		<div className="flex flex-col h-full animate-fadeIn">
			<div className="flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
				<List
					dataSource={calls}
					loading={isLoading}
					locale={{ emptyText: <Empty description="Qo'ng'iroqlar yo'q" /> }}
					renderItem={(call) => (
						<List.Item
							className="px-4 py-3 border-none hover:bg-slate-50 rounded-2xl cursor-pointer group transition-colors"
							onClick={() => onCall(call.callerNumber)}
						>
							<div className="flex items-center justify-between w-full">
								<div className="flex items-center gap-4">
									<div
										className={`w-10 h-10 rounded-xl flex items-center justify-center ${
											call.direction === "inbound"
												? "bg-blue-50 text-blue-500"
												: "bg-emerald-50 text-emerald-500"
										}`}
									>
										<PhoneOutlined className={call.direction === "outbound" ? "rotate-90" : ""} />
									</div>
									<div>
										<Text className="font-bold text-slate-900 block">{call.callerNumber}</Text>
										<Text className="text-[10px] text-slate-400 font-medium">
											{new Date(call.startedAt).toLocaleString("uz-UZ", {
												hour: "2-digit",
												minute: "2-digit",
												day: "2-digit",
												month: "short",
											})}
										</Text>
									</div>
								</div>
								<Button
									type="primary"
									shape="circle"
									icon={<PhoneOutlined />}
									className="bg-emerald-500 border-none opacity-0 group-hover:opacity-100 transition-opacity"
									size="small"
								/>
							</div>
						</List.Item>
					)}
				/>
			</div>
		</div>
	);
}
