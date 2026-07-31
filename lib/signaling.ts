import Redis from "ioredis";
import type { WebSocket } from "ws";

type SignalMessage = {
  type: string;
  roomId: string;
  peerId: string;
  [key: string]: unknown;
};

type ClientEvent =
  | { type: "join-room"; roomId: string; peerId: string }
  | { type: "signal"; message: SignalMessage };

type ConnectionState = {
  roomId: string | null;
  peerId: string | null;
};

type RelayEnvelope = {
  instanceId: string;
  message: SignalMessage;
};

const relayChannel = "video-call:signals";
const instanceId = crypto.randomUUID();
const connections = new Map<WebSocket, ConnectionState>();
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

const redisUrl = process.env.REDIS_URL;
const publisher = redisUrl
  ? new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    })
  : null;
publisher?.on("error", (error) => {
  console.error("[signaling] Redis publisher error", error);
});
let subscriber: Redis | null = null;
let subscriberStartPromise: Promise<void> | null = null;
let warnedAboutRedis = false;

function normalizeRoomId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const roomId = value.trim().toUpperCase();
  return roomId && roomId.length <= 64 ? roomId : null;
}

function normalizePeerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const peerId = value.trim();
  return peerId && peerId.length <= 128 ? peerId : null;
}

function parseEvent(data: unknown): ClientEvent | null {
  try {
    const event = JSON.parse(String(data)) as ClientEvent;
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, serialized: string): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(serialized);
  } catch {
    unregisterConnection(socket);
  }
}

function broadcastLocally(message: SignalMessage, excludedSocket?: WebSocket): void {
  const serialized = JSON.stringify(message);
  for (const [socket, state] of connections) {
    if (socket !== excludedSocket && state.roomId === message.roomId) {
      send(socket, serialized);
    }
  }
}

async function startSubscriber(): Promise<void> {
  if (subscriber) return;
  if (subscriberStartPromise) return subscriberStartPromise;

  if (!publisher) {
    if (!warnedAboutRedis) {
      warnedAboutRedis = true;
      console.warn("[signaling] REDIS_URL is not configured; relay is limited to one instance.");
    }
    return;
  }

  subscriberStartPromise = (async () => {
    const nextSubscriber = publisher.duplicate();
    nextSubscriber.on("message", (channel, serialized) => {
      if (channel !== relayChannel) return;
      try {
        const envelope = JSON.parse(serialized) as RelayEnvelope;
        if (envelope.instanceId !== instanceId) broadcastLocally(envelope.message);
      } catch {
        // Ignore malformed relay entries.
      }
    });
    nextSubscriber.on("error", (error) => {
      console.error("[signaling] Redis subscriber error", error);
    });

    try {
      await nextSubscriber.subscribe(relayChannel);
      subscriber = nextSubscriber;
    } catch (error) {
      console.error("[signaling] Unable to subscribe to Redis relay", error);
      nextSubscriber.disconnect();
    } finally {
      subscriberStartPromise = null;
    }
  })();

  return subscriberStartPromise;
}

function publish(message: SignalMessage): void {
  if (!publisher) return;
  const envelope: RelayEnvelope = { instanceId, message };
  void publisher.publish(relayChannel, JSON.stringify(envelope)).catch((error) => {
    console.error("[signaling] Unable to publish signal", error);
  });
}

export async function registerConnection(socket: WebSocket): Promise<void> {
  connections.set(socket, { roomId: null, peerId: null });
  await startSubscriber();
}

export function unregisterConnection(socket: WebSocket): void {
  connections.delete(socket);
}

export function handleClientEvent(socket: WebSocket, data: unknown): void {
  const event = parseEvent(data);
  if (!event) return;

  if (event.type === "join-room") {
    const roomId = normalizeRoomId(event.roomId);
    const peerId = normalizePeerId(event.peerId);
    if (roomId && peerId) connections.set(socket, { roomId, peerId });
    return;
  }

  if (event.type !== "signal" || !event.message || typeof event.message !== "object") return;

  const state = connections.get(socket);
  const message = event.message;
  const roomId = normalizeRoomId(message.roomId);
  const peerId = normalizePeerId(message.peerId);
  if (
    !state ||
    !roomId ||
    !peerId ||
    !signalTypes.has(message.type) ||
    roomId !== state.roomId ||
    peerId !== state.peerId
  ) {
    return;
  }

  const normalizedMessage = { ...message, roomId, peerId };
  broadcastLocally(normalizedMessage, socket);
  publish(normalizedMessage);
}
