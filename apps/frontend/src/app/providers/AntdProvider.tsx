import { StyleProvider } from "@ant-design/cssinjs";
import { App as AntApp, ConfigProvider } from "antd";
import uzUZ from "antd/locale/uz_UZ";
import type { ReactNode } from "react";

interface AntdProviderProps {
	children: ReactNode;
}

/**
 * antd's bundled uz_UZ is Latin Uzbek but ships a few typos and a couple of
 * strings that read wrong in this product. Spread it and correct only those —
 * everything else (pagination, pickers, upload, form) comes from antd.
 */
const uzLocale: typeof uzUZ = {
	...uzUZ,
	Table: {
		...uzUZ.Table,
		expand: "Satrni ochish",
		collapse: "Satrni yig'ish",
		cancelSort: "Tartiblashni bekor qilish uchun bosing",
		selectNone: "Tanlovni tozalash",
		filterConfirm: "Qo'llash",
		filterEmptyText: "Filtrlar yo'q",
	},
	Modal: {
		...uzUZ.Modal,
		okText: "Tasdiqlash",
		cancelText: "Bekor qilish",
		justOkText: "Yopish",
	},
	Popconfirm: {
		okText: "Tasdiqlash",
		cancelText: "Bekor qilish",
	},
	Text: {
		...uzUZ.Text,
		expand: "Ochish",
	},
};

export function AntdProvider({ children }: AntdProviderProps) {
	return (
		<StyleProvider layer>
			<ConfigProvider
				locale={uzLocale}
				theme={{
					token: {
						colorPrimary: "#2154B2",
						borderRadius: 12,
						fontFamily: "Inter, system-ui, sans-serif",
					},
					components: {
						Button: {
							controlHeightLG: 48,
							fontWeight: 600,
						},
						Card: {
							boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
						},
						Layout: {
							headerBg: "rgba(255, 255, 255, 0.8)",
						},
					},
				}}
			>
				<AntApp>{children}</AntApp>
			</ConfigProvider>
		</StyleProvider>
	);
}
