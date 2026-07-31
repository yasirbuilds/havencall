# Video call app

A two-person WebRTC video call app with native WebSocket signaling. It supports local Node.js development and Vercel WebSocket Functions.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), join a room, and open its invite link in another browser. The bundled `server.mjs` serves Next.js and the local WebSocket endpoint together.

For a production-style local run:

```bash
npm run build
npm start
```

## Deploy to Vercel

The Vercel deployment uses `app/api/ws/route.ts`. Fluid Compute is enabled in `vercel.json`, and the browser automatically connects to `/api/ws` on the deployment's HTTPS domain.

Vercel can place two callers on different Function instances, so a Redis relay is required for reliable real-device calls:

1. Import the repository into Vercel.
2. Add an Upstash Redis integration to the project, or provide another Redis service.
3. Confirm the integration created a `REDIS_URL` environment variable for Production and Preview.
4. Redeploy the project after adding Redis.

With the Vercel CLI, the equivalent setup is:

```bash
vercel link
vercel integration add upstash
vercel --prod
```

No public frontend environment variable is required. `REDIS_URL` is server-only and must not be prefixed with `NEXT_PUBLIC_`.

## How signaling works

- Locally, `server.mjs` relays WebSocket messages in one Node.js process.
- On Vercel, the `/api/ws` Function relays messages to sockets on the same instance.
- Redis pub/sub forwards the same transient signaling messages between Vercel Function instances.
- Video and audio remain peer-to-peer through WebRTC; Redis never carries media.

The client automatically reconnects the signaling socket when a Vercel Function reaches its duration limit. An established WebRTC media connection continues independently.
