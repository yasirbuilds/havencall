# Video call app

This is a two-person WebRTC video call app. A small Socket.IO signaling server is included so separate browsers and devices can discover each other and exchange WebRTC connection details.

## Getting started

Install dependencies and run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), join a room, and open its invite link in the other browser. `npm run dev` starts both Next.js and the same-origin Socket.IO signaling endpoint.

For a production-style local run:

```bash
npm run build
npm start
```

## Signaling configuration

No signaling environment variables are needed. Browsers connect to the Socket.IO server on the same origin as the app.

## Deployment note

The included custom server requires a long-running Node.js host with WebSocket support. Deploy the Next.js app and `server.mjs` together using `npm start`.

For reliable calls between restrictive corporate or mobile networks, configure a TURN server in addition to the existing public STUN server.
