import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from "@vercel/functions";
import {
  handleClientEvent,
  registerConnection,
  unregisterConnection,
} from "@/lib/signaling";

export const runtime = "nodejs";
export const maxDuration = 300;

export function GET() {
  return experimental_upgradeWebSocket((socket) => {
    registerConnection(socket);

    socket.on("message", (data: WebSocketData) => {
      handleClientEvent(socket, data);
    });

    const close = () => unregisterConnection(socket);
    socket.on("close", close);
    socket.on("error", close);
  });
}
