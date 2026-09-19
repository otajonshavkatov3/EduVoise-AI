import dayjs from "dayjs";
import "dayjs/locale/uz-latn";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// antd's locale only covers component chrome; the month and weekday names inside
// every calendar panel come from dayjs, so both have to be switched.
dayjs.locale("uz-latn");

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Root element not found");
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>
);
