"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  LogIn,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Video,
  VideoOff,
} from "lucide-react";
import type { Socket } from "socket.io-client";

type SignalMessage =
  | { type: "ready"; roomId: string; peerId: string }
  | { type: "offer"; roomId: string; peerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; peerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; roomId: string; peerId: string; candidate: RTCIceCandidateInit }
  | { type: "leave"; roomId: string; peerId: string };

const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function makeRoomId() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

export default function VideoCall() {
  const [roomId, setRoomId] = useState("MEET");
  const [peerId] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState("Idle");
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [shareUrl, setShareUrl] = useState("");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const joinedRef = useRef(false);
  const makingOfferRef = useRef(false);
  const hasSentOfferRef = useRef(false);
  const hasRemoteDescriptionRef = useRef(false);

  const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_SERVER_URL;
  const cleanRoomId = useMemo(() => roomId.trim().toUpperCase() || "MEET", [roomId]);

  useEffect(() => {
    window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get("room");
      if (urlRoom) {
        setRoomId(urlRoom.toUpperCase());
        setOrigin(window.location.origin);
        return;
      }
      const freshRoom = makeRoomId();
      setRoomId(freshRoom);
      setOrigin(window.location.origin);
      window.history.replaceState(null, "", `/?room=${freshRoom}`);
    }, 0);
  }, []);

  const sendSignal = useCallback(
    (message: SignalMessage) => {
      channelRef.current?.postMessage(message);
      socketRef.current?.emit("signal", message);
    },
    []
  );

  const getPeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({ iceServers });
    remoteStreamRef.current = new MediaStream();

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStreamRef.current?.addTrack(track));
      if (remoteVideoRef.current && remoteStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
      setRemoteReady(true);
      setStatus("Connected");
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "candidate",
          roomId: cleanRoomId,
          peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setStatus("Connected");
      if (pc.connectionState === "disconnected") setStatus("Peer disconnected");
      if (pc.connectionState === "failed") setStatus("Connection failed. Try rejoining.");
    };

    localStreamRef.current?.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localStreamRef.current as MediaStream);
      if (track.kind === "video") videoSenderRef.current = sender;
      if (track.kind === "audio") audioSenderRef.current = sender;
    });

    pcRef.current = pc;
    return pc;
  }, [cleanRoomId, peerId, sendSignal]);

  const makeOffer = useCallback(async () => {
    const pc = getPeerConnection();
    makingOfferRef.current = true;
    try {
      if (hasSentOfferRef.current || pc.signalingState !== "stable") return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      hasSentOfferRef.current = true;
      sendSignal({ type: "offer", roomId: cleanRoomId, peerId, sdp: offer });
      setStatus("Calling...");
    } finally {
      makingOfferRef.current = false;
    }
  }, [cleanRoomId, getPeerConnection, peerId, sendSignal]);

  const handleSignal = useCallback(
    async (message: SignalMessage) => {
      if (message.roomId !== cleanRoomId || message.peerId === peerId || !joinedRef.current) return;

      try {
        const pc = getPeerConnection();
        if (message.type === "ready") {
          setStatus("Peer joined");
          if (peerId < message.peerId && !hasSentOfferRef.current) {
            await makeOffer();
          }
        }

        if (message.type === "offer") {
          if (hasRemoteDescriptionRef.current && pc.signalingState === "stable") return;

          const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
          if (offerCollision && peerId < message.peerId) return;
          if (offerCollision) {
            await pc.setLocalDescription({ type: "rollback" });
            hasSentOfferRef.current = false;
          }
          await pc.setRemoteDescription(message.sdp);
          hasRemoteDescriptionRef.current = true;
          const answer = await pc.createAnswer();
          if (pc.signalingState !== "have-remote-offer") return;
          await pc.setLocalDescription(answer);
          sendSignal({ type: "answer", roomId: cleanRoomId, peerId, sdp: answer });
          setStatus("Answer sent");
        }

        if (message.type === "answer") {
          if (pc.signalingState !== "have-local-offer") return;
          await pc.setRemoteDescription(message.sdp);
          hasRemoteDescriptionRef.current = true;
          setStatus("Connecting...");
        }

        if (message.type === "candidate") {
          if (!pc.remoteDescription) return;
          await pc.addIceCandidate(message.candidate);
        }

        if (message.type === "leave") {
          setRemoteReady(false);
          setStatus("Peer left");
        }
      } catch {
        setStatus("Signaling message skipped. Rejoin if the call does not connect.");
      }
    },
    [cleanRoomId, getPeerConnection, makeOffer, peerId, sendSignal]
  );

  const startMedia = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    setMicOn(true);
    setCameraOn(true);
  }, []);

  const joinRoom = useCallback(async () => {
    try {
      setStatus("Opening camera...");
      await startMedia();
      const nextUrl = `${window.location.origin}/?room=${cleanRoomId}`;
      setShareUrl(nextUrl);
      window.history.replaceState(null, "", `/?room=${cleanRoomId}`);

      channelRef.current?.close();
      channelRef.current = new BroadcastChannel(`video-call-${cleanRoomId}`);
      channelRef.current.onmessage = (event) => handleSignal(event.data);

      if (signalingUrl && !socketRef.current) {
        const { io } = await import("socket.io-client");
        socketRef.current = io(signalingUrl, { transports: ["websocket"] });
        socketRef.current.on("signal", handleSignal);
        socketRef.current.emit("join-room", { roomId: cleanRoomId, peerId });
      }

      joinedRef.current = true;
      setJoined(true);
      setStatus("Waiting for one person");
      [250, 1000, 2000].forEach((delay) => {
        setTimeout(() => {
          if (joinedRef.current) {
            sendSignal({ type: "ready", roomId: cleanRoomId, peerId });
          }
        }, delay);
      });
    } catch {
      setStatus("Camera or microphone permission was blocked");
    }
  }, [cleanRoomId, handleSignal, peerId, sendSignal, signalingUrl, startMedia]);

  const leaveRoom = useCallback(() => {
    sendSignal({ type: "leave", roomId: cleanRoomId, peerId });
    pcRef.current?.close();
    pcRef.current = null;
    videoSenderRef.current = null;
    audioSenderRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    joinedRef.current = false;
    hasSentOfferRef.current = false;
    hasRemoteDescriptionRef.current = false;
    setJoined(false);
    setRemoteReady(false);
    setStatus("Idle");
  }, [cleanRoomId, peerId, sendSignal]);

  useEffect(() => leaveRoom, [leaveRoom]);

  const toggleMic = () => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    });
  };

  const toggleCamera = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    if (cameraOn) {
      stream.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
      await videoSenderRef.current?.replaceTrack(null);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setCameraOn(false);
      return;
    }

    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const [videoTrack] = cameraStream.getVideoTracks();
      stream.addTrack(videoTrack);
      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(videoTrack);
      } else if (pcRef.current) {
        videoSenderRef.current = pcRef.current.addTrack(videoTrack, stream);
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setCameraOn(true);
    } catch {
      setStatus("Camera permission was blocked");
    }
  };

  const copyInvite = async () => {
    await navigator.clipboard.writeText(shareUrl || `${window.location.origin}/?room=${cleanRoomId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="min-h-screen bg-[#0f0f10] text-white">
      <header className="flex min-h-16 items-center justify-between border-b border-white/8 bg-[#141416] px-4 sm:px-6">
        <div>
          <p className="text-sm text-white/55">Private call</p>
          <h1 className="text-xl font-semibold tracking-normal">Room {cleanRoomId}</h1>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-white/75">{status}</span>
      </header>

      <section className="grid min-h-[calc(100vh-8rem)] gap-3 p-3 lg:grid-cols-[1fr_300px]">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="video-tile">
            <video ref={localVideoRef} autoPlay playsInline muted className="video-feed" />
            <div className="tile-label">You {micOn ? "" : "(muted)"}</div>
            {!cameraOn && <div className="avatar">You</div>}
          </div>
          <div className="video-tile">
            <video ref={remoteVideoRef} autoPlay playsInline className="video-feed" />
            {!remoteReady && <div className="avatar">Waiting</div>}
            <div className="tile-label">Guest</div>
          </div>
        </div>

        <aside className="flex flex-col gap-4 border-t border-white/10 pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div className="panel">
            <label className="text-sm text-white/60" htmlFor="room">Room code</label>
            <div className="mt-2 flex gap-2">
              <input
                id="room"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value.toUpperCase())}
                disabled={joined}
                className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/8 px-3 py-2 text-white outline-none focus:border-white/45"
              />
              <button className="icon-button" onClick={() => setRoomId(makeRoomId())} disabled={joined} title="New room" aria-label="New room">
                <Plus size={20} />
              </button>
            </div>
          </div>

          <div className="panel">
            <p className="text-sm text-white/60">Invite link</p>
            <p className="mt-2 break-all text-sm text-white/80">{shareUrl || `${origin}/?room=${cleanRoomId}`}</p>
            <button className="mt-3 w-full secondary-button" onClick={copyInvite}>
              <Copy size={18} />
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </aside>
      </section>

      <footer className="fixed inset-x-0 bottom-0 flex h-16 items-center justify-center gap-3 border-t border-white/10 bg-[#151515]/95 px-3 backdrop-blur">
        {!joined ? (
          <button className="primary-button" onClick={joinRoom}>
            <LogIn size={20} />
            Join now
          </button>
        ) : (
          <>
            <button className="control-button" onClick={toggleMic} title={micOn ? "Mute microphone" : "Unmute microphone"} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
              {micOn ? <Mic size={21} /> : <MicOff size={21} />}
            </button>
            <button className="control-button" onClick={toggleCamera} title={cameraOn ? "Turn camera off" : "Turn camera on"} aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}>
              {cameraOn ? <Video size={21} /> : <VideoOff size={21} />}
            </button>
            <button className="leave-button" onClick={leaveRoom} title="Leave call" aria-label="Leave call">
              <PhoneOff size={22} />
            </button>
          </>
        )}
      </footer>
    </main>
  );
}
