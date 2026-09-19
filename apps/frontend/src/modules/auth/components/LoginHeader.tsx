import { Typography } from "antd";

const { Title, Text } = Typography;

export function LoginHeader() {
	return (
		<div className="mb-10 text-center lg:text-left">
			<Title level={2} className="mb-2 text-3xl font-bold text-gray-900">
				Xush kelibsiz
			</Title>
			<Text className="text-lg text-gray-500">
				Tizimga kirish uchun ma'lumotlaringizni kiriting.
			</Text>
		</div>
	);
}
