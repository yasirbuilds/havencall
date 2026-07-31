# Video Call App

A lightweight, two-person video calling application built with Next.js,
WebRTC, WebSockets, and Redis. It runs with a bundled Node.js signaling server
locally and uses Vercel WebSocket Functions in production.

## Features

- Two-person rooms with shareable invite links
- Peer-to-peer audio and video with WebRTC
- Microphone and camera controls
- Responsive desktop and mobile interface
- Automatic signaling reconnection
- Cross-instance signaling through Redis on Vercel
- Optional TURN relay support for restrictive networks
- No account or client-side public environment variable required

## Architecture

The application separates signaling from media transport:

1. The browser opens a WebSocket connection and exchanges WebRTC offers,
   answers, and ICE candidates with the other participant.
2. During local development, `server.mjs` relays signaling messages in one
   Node.js process.
3. On Vercel, `app/api/ws/route.ts` accepts WebSocket connections. Redis
   pub/sub forwards messages between callers assigned to different Function
   instances.
4. WebRTC sends audio and video directly between participants whenever the
   network permits it. A configured TURN server relays encrypted media only
   when a direct connection cannot be established.

Redis carries signaling messages only; it never carries audio or video.

## Technology

- Next.js 16 and React 19
- TypeScript
- WebRTC browser APIs
- Vercel WebSocket Functions
- Redis with `ioredis`
- Tailwind CSS

## Requirements

- Node.js 20 or newer
- npm
- A modern browser with WebRTC and camera/microphone support
- Redis for reliable Vercel deployments
- A TURN service for reliable calls across different or restrictive networks

Camera and microphone access require HTTPS in production. Localhost is treated
as a secure context by modern browsers.

## Local Development

Install dependencies and start the custom development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Join a room, then open its
invite link in another browser or device.

The custom `server.mjs` process runs Next.js and the local WebSocket endpoint
together. Redis and TURN are optional for same-machine local testing.

To test a production build locally:

```bash
npm run build
npm start
```

## Environment Variables

| Variable | Required | Scope | Purpose |
| --- | --- | --- | --- |
| `REDIS_URL` | Production | Server | Relays signaling between Vercel Function instances. |
| `TURN_URL` | Recommended | Server | One TURN URL or multiple comma-separated TURN URLs. |
| `TURN_USERNAME` | With TURN | Server | Username issued by the TURN provider. |
| `TURN_CREDENTIAL` | With TURN | Server | Credential issued by the TURN provider. |
| `PORT` | No | Local server | Overrides the local port; defaults to `3000`. |
| `VIDEO_CALL_HOST` | No | Local server | Overrides the local bind address; defaults to `0.0.0.0`. |

Do not prefix Redis or TURN variables with `NEXT_PUBLIC_`. The `/api/ice`
endpoint returns only the ICE configuration required by the browser.

Keep local secrets in `.env.local`, which is ignored by Git:

```text
REDIS_URL=rediss://default:password@example.com:6379
TURN_URL=turn:relay.example.com:3478,turns:relay.example.com:5349
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-credential
```

## Deploying to Vercel

### 1. Import the project

Push the repository to a Git provider and import it into Vercel. Vercel should
detect Next.js automatically. No custom build command or output directory is
needed.

Fluid Compute is enabled through `vercel.json`. The production client connects
to `/api/ws` on the deployment's HTTPS domain.

### 2. Configure Redis

Vercel can assign callers to different Function instances. Without Redis, only
callers connected to the same instance can exchange signaling reliably.

From the Vercel dashboard, install an Upstash Redis integration or connect
another Redis-compatible service. Confirm that it adds `REDIS_URL` to the
Production environment and to Preview if preview deployments should support
calls. Redeploy after changing environment variables.

The equivalent Vercel CLI flow is:

```bash
vercel link
vercel integration add upstash
vercel --prod
```

### 3. Configure TURN

STUN is enough when browsers can establish a direct connection. Some corporate
networks, mobile carriers, VPNs, and restrictive NAT configurations block that
path. In those cases, users can see their own camera while the remote media
remains blank. TURN provides the fallback relay required for dependable calls.

TURN is not provided by Vercel. Use a managed TURN provider or operate a Coturn
server. For experimentation, providers such as Metered Open Relay offer a free
tier. Review the provider's current quotas and production terms before launch.

Add the credentials supplied by the provider to the Vercel project:

```text
TURN_URL=turn:your-turn-host:3478,turns:your-turn-host:5349
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-credential
```

Set them for Production and, if needed, Preview, then redeploy. Prefer
short-lived TURN credentials for a public production application. The included
configuration supports provider-issued static credentials; providers that
generate credentials through an API require adapting `app/api/ice/route.ts`.

### 4. Verify the deployment

Test with two physical devices on different networks, such as Wi-Fi and mobile
data. Verify:

- Camera and microphone permissions
- Joining through a copied invitation URL
- Remote audio and video in both directions
- Microphone and camera toggles
- Leaving and rejoining
- Recovery after a temporary network interruption

Check Vercel Function logs for Redis, WebSocket, or TURN configuration errors.

## Available Scripts

```bash
npm run dev    # Start Next.js with the local WebSocket server
npm run build  # Create an optimized production build
npm start      # Run the production build with the local Node.js server
npm run lint   # Run ESLint
```

## Troubleshooting

### Local preview works, but remote video is blank

Configure a TURN server and test from different networks. Seeing the local
preview only confirms camera access; it does not confirm that WebRTC established
a route to the other participant.

### Calls work locally but fail on Vercel

Confirm that `REDIS_URL` exists in the exact Vercel environment being tested and
redeploy after adding it. Also verify that TURN variables are configured for
cross-network reliability.

### The WebSocket reconnects periodically

Vercel WebSocket connections are tied to the lifetime of their Function
invocation. The client reconnects automatically, re-joins its room, and
re-announces its media state. An established WebRTC media path is independent
of the signaling socket.

### Camera or microphone access is denied

Use HTTPS, check the browser's site permissions, and ensure no other application
has exclusive access to the device.

## Security and Production Considerations

This project is intentionally small and does not include authentication. Room
links act as invitations, but short room IDs should not be considered access
control. Before using the project for sensitive meetings, consider adding:

- Authentication and room authorization
- Longer, cryptographically random room identifiers
- Rate limiting for HTTP and WebSocket endpoints
- Short-lived TURN credentials
- Abuse monitoring and usage limits
- A privacy policy and deployment-specific data retention documentation

WebRTC encrypts media in transit. When TURN is used, the server relays encrypted
packets and does not need to decode the call media.

## Contributing

Contributions are welcome. Before opening a pull request:

1. Create a focused branch.
2. Run `npm run lint` and `npm run build`.
3. Describe the behavior changed and how it was tested.
4. Avoid committing `.env*` files, credentials, or service tokens.

For bugs, include the browser, operating system, network type, reproduction
steps, and relevant signaling logs without secrets.

## License

No open-source license has been added yet. Add a `LICENSE` file before publicly
distributing the project so contributors and users clearly understand the terms
under which they may use, modify, and redistribute it.
