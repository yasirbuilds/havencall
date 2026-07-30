import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";

const dev = !process.argv.includes("--production");
const hostname = process.env.VIDEO_CALL_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3001", 10);

const nextApp = next({ dev, hostname, port });
const handle = nextApp.getRequestHandler();

await nextApp.prepare();

const httpServer = createServer((request, response) => {
  handle(request, response);
});

const io = new Server(httpServer, {
  maxHttpBufferSize: 100_000,
});

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

io.on("connection", (socket) => {
  socket.on("join-room", (payload) => {
    const roomId = normalizeRoomId(payload?.roomId);
    const peerId = normalizePeerId(payload?.peerId);
    if (!roomId || !peerId) return;

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(socket.data.roomId);
    }

    socket.data.roomId = roomId;
    socket.data.peerId = peerId;
    socket.join(roomId);
  });

  socket.on("signal", (message) => {
    if (!message || typeof message !== "object" || !signalTypes.has(message.type)) return;

    const roomId = normalizeRoomId(message.roomId);
    const peerId = normalizePeerId(message.peerId);
    if (
      !roomId ||
      !peerId ||
      roomId !== socket.data.roomId ||
      peerId !== socket.data.peerId
    ) {
      return;
    }

    socket.to(roomId).emit("signal", message);
  });

  socket.on("disconnecting", () => {
    const { roomId, peerId } = socket.data;
    if (!roomId || !peerId) return;
    socket.to(roomId).emit("signal", { type: "leave", roomId, peerId });
  });
});

httpServer.listen(port, hostname, () => {
  console.log(`> Video call server ready at http://${hostname}:${port}`);
});
