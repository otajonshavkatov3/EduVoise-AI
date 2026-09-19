export async function requestNotificationPermission() {
	if (!("Notification" in window)) {
		return false;
	}
	if (Notification.permission === "granted") {
		return true;
	}
	if (Notification.permission !== "denied") {
		const permission = await Notification.requestPermission();
		return permission === "granted";
	}
	return false;
}

export function showCallNotification(
	callerName: string,
	callerNumber: string,
	onAction?: () => void
) {
	if (!("Notification" in window) || Notification.permission !== "granted") {
		return null;
	}

	const notification = new Notification("Kiruvchi qo'ng'iroq", {
		body: `${callerName} (${callerNumber}) qo'ng'iroq qilmoqda...`,
		icon: "/favicon.ico", // Or a phone icon if available
		tag: "incoming-call",
		requireInteraction: true,
		silent: false, // We already play a ringtone in the app
	});

	notification.onclick = () => {
		window.focus();
		if (onAction) {
			onAction();
		}
		notification.close();
	};

	return notification;
}
