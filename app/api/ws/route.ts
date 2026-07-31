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
    // Do not process signaling until this Function instance is listening to
    // Redis, otherwise early offers and ICE candidates can be lost.
    const connectionReady = registerConnection(socket);
    let closed = false;

    socket.on("message", (data: WebSocketData) => {
      void connectionReady.then(() => {
        if (!closed) handleClientEvent(socket, data);
      });
    });

    const close = () => {
      closed = true;
      unregisterConnection(socket);
    };
    socket.on("close", close);
    socket.on("error", close);
  });
}
