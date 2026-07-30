import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

const dev = !process.argv.includes("--production");
const hostname = process.env.VIDEO_CALL_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3001", 10);

const httpServer = createServer((request, response) => {
  handle(request, response);
});
const nextApp = next({ dev, hostname, port });
const handle = nextApp.getRequestHandler();

await nextApp.prepare();

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 100_000 });
const connections = new Map();
const signalTypes = new Set([
  "room-check",
  "room-member",
  "room-full",
  "ready",
  "offer",
  "answer",
  "candidate",
  "media-state",
  "leave",
]);

function normalizeRoomId(value) {
  if (typeof value !== "string") return null;
  const roomId = value.trim().toUpperCase();
  return roomId && roomId.length <= 64 ? roomId : null;
}

function normalizePeerId(value) {
  if (typeof value !== "string") return null;
  const peerId = value.trim();
  return peerId && peerId.length <= 128 ? peerId : null;
}

function relaySignal(sender, message) {
  const senderState = connections.get(sender);
  if (!senderState || !message || typeof message !== "object") return;
  if (!signalTypes.has(message.type)) return;

  const roomId = normalizeRoomId(message.roomId);
  const peerId = normalizePeerId(message.peerId);
  if (!roomId || !peerId || roomId !== senderState.roomId || peerId !== senderState.peerId) {
    return;
  }

  const serialized = JSON.stringify(message);
  for (const [socket, state] of connections) {
    if (socket !== sender && state.roomId === roomId && socket.readyState === 1) {
      socket.send(serialized);
    }
  }
}

webSocketServer.on("connection", (socket) => {
  connections.set(socket, { roomId: null, peerId: null });

  socket.on("message", (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event?.type === "join-room") {
      const roomId = normalizeRoomId(event.roomId);
      const peerId = normalizePeerId(event.peerId);
      if (roomId && peerId) connections.set(socket, { roomId, peerId });
      return;
    }

    if (event?.type === "signal") relaySignal(socket, event.message);
  });

  socket.on("close", () => connections.delete(socket));
  socket.on("error", () => connections.delete(socket));
});

const handleWebSocketUpgrade = (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname !== "/api/ws") return false;

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
  return true;
};

// Next owns its development/HMR upgrade listener. Intercept only the app's
// signaling endpoint before EventEmitter dispatches an upgrade to Next.
const emit = httpServer.emit;
httpServer.emit = function (eventName, ...args) {
  if (eventName === "upgrade" && handleWebSocketUpgrade(...args)) return true;

  return Reflect.apply(emit, this, [eventName, ...args]);
};

httpServer.listen(port, hostname, () => {
  console.log(`> Video call server ready at http://${hostname}:${port}`);
});
