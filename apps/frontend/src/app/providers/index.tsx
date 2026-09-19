import type { ReactNode } from "react";
import { AntdProvider } from "./AntdProvider";
import { QueryProvider } from "./QueryProvider";

interface ProvidersProps {
	children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
	return (
		<QueryProvider>
			<AntdProvider>{children}</AntdProvider>
		</QueryProvider>
	);
}
