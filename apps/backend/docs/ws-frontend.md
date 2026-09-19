# WebSocket: frontend ulanishi

Endpoint: **`ws://<host>/api/ws`**

## 1. Token bilan (production)

Login qilingandan keyin `accessToken` ni query da yuboring:

```js
const token = localStorage.getItem("accessToken"); // yoki store
const ws = new WebSocket(`ws://localhost:3000/api/ws?token=${token}`);

ws.onopen = () => console.log("WS connected");
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "incoming_call") {
    // Qo'ng'iroq popup
    console.log("Incoming call:", data);
  }
  if (data.type === "connected") {
    console.log("Connected:", data.userId);
  }
  if (data.type === "pong") {
    console.log("Pong");
  }
};
ws.onclose = () => console.log("WS closed");
ws.onerror = (err) => console.error("WS error:", err);
```

## 2. Test: userId query (token siz)

Token verify o‘chirilmasa, faqat test uchun:

```js
const ws = new WebSocket("ws://localhost:3000/api/ws?userId=u-1");
// ... onopen, onmessage, onclose xuddi yuqoridagidek
```

## 3. React misol (hook)

```ts
import { useEffect, useRef, useState } from "react";

export function useCallWebSocket(accessToken: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [incomingCall, setIncomingCall] = useState<unknown>(null);

  useEffect(() => {
    if (!accessToken) return;

    const url = `${import.meta.env.VITE_WS_URL || "ws://localhost:3000"}/api/ws?token=${accessToken}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "incoming_call") {
        setIncomingCall(data);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [accessToken]);

  return { incomingCall, clearIncomingCall: () => setIncomingCall(null) };
}
```

## Server event turlari

| type           | Tavsif                          |
|----------------|----------------------------------|
| `connected`    | Ulanish muvaffaqiyatli, `userId` |
| `incoming_call`| Yangi qo'ng'iroq (FreePBX → broadcastToUser) |
| `pong`         | Client xabariga javob            |
