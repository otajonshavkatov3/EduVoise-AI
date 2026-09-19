import { PhoneOutlined, SearchOutlined } from "@ant-design/icons";
import { Avatar, Button, Empty, Input, List, Typography } from "antd";

const { Text } = Typography;

interface ContactType {
	id: string;
	firstName?: string | null;
	lastName?: string | null;
	phoneNumber: string;
}

interface DialpadContactsProps {
	contacts: ContactType[];
	isLoading: boolean;
	onSearch: (q: string) => void;
	onCall: (number: string) => void;
}

export function DialpadContacts({ contacts, isLoading, onSearch, onCall }: DialpadContactsProps) {
	return (
		<div className="flex flex-col h-full animate-fadeIn">
			<div className="px-6 py-4">
				<Input
					prefix={<SearchOutlined className="text-slate-400" />}
					placeholder="Kontaktlarni qidirish..."
					onChange={(e) => onSearch(e.target.value)}
					className="h-10 rounded-xl bg-slate-50 border-none focus:bg-white transition-all shadow-none"
				/>
			</div>
			<div className="flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
				<List
					dataSource={contacts}
					loading={isLoading}
					locale={{ emptyText: <Empty description="Kontaktlar topilmadi" /> }}
					renderItem={(contact) => (
						<List.Item
							className="px-4 py-3 border-none hover:bg-slate-50 rounded-2xl cursor-pointer group transition-colors"
							onClick={() => onCall(contact.phoneNumber)}
						>
							<div className="flex items-center justify-between w-full">
								<div className="flex items-center gap-4">
									<Avatar className="bg-blue-600 rounded-xl font-bold">
										{contact.firstName?.[0]}
									</Avatar>
									<div>
										<Text className="font-bold text-slate-900 block">
											{contact.firstName} {contact.lastName}
										</Text>
										<Text className="text-[10px] text-slate-400 font-medium">
											{contact.phoneNumber}
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
