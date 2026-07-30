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
  | { type: "room-check"; roomId: string; peerId: string; requestId: string }
  | { type: "room-member"; roomId: string; peerId: string; requestId: string }
  | { type: "room-full"; roomId: string; peerId: string; targetPeerId: string; requestId?: string }
  | { type: "ready"; roomId: string; peerId: string }
  | { type: "offer"; roomId: string; peerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; peerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; roomId: string; peerId: string; candidate: RTCIceCandidateInit }
  | { type: "leave"; roomId: string; peerId: string };

const maxRoomMembers = 2;
const roomCheckTimeoutMs = 650;
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
  const [remoteMessage, setRemoteMessage] = useState("Waiting");
  const [roomFull, setRoomFull] = useState(false);

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
  const knownPeerIdsRef = useRef<Set<string>>(new Set());
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const clearDisconnectTimer = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  }, []);

  const resetCallState = useCallback((nextStatus = "Idle", nextRoomFull = false) => {
    clearDisconnectTimer();
    pcRef.current?.close();
    pcRef.current = null;
    videoSenderRef.current = null;
    audioSenderRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    joinedRef.current = false;
    makingOfferRef.current = false;
    hasSentOfferRef.current = false;
    hasRemoteDescriptionRef.current = false;
    knownPeerIdsRef.current.clear();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.pause();
      remoteVideoRef.current.srcObject = null;
      remoteVideoRef.current.removeAttribute("src");
      remoteVideoRef.current.load();
    }
    setJoined(false);
    setRemoteReady(false);
    setRemoteMessage("Waiting");
    setRoomFull(nextRoomFull);
    setStatus(nextStatus);
  }, [clearDisconnectTimer]);

  const clearRemotePeer = useCallback((nextStatus: string, nextRemoteMessage = "Guest left") => {
    clearDisconnectTimer();
    pcRef.current?.close();
    pcRef.current = null;
    videoSenderRef.current = null;
    audioSenderRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.pause();
      remoteVideoRef.current.srcObject = null;
      remoteVideoRef.current.removeAttribute("src");
      remoteVideoRef.current.load();
    }
    knownPeerIdsRef.current.clear();
    makingOfferRef.current = false;
    hasSentOfferRef.current = false;
    hasRemoteDescriptionRef.current = false;
    setRemoteReady(false);
    setRemoteMessage(nextRemoteMessage);
    setStatus(nextStatus);
  }, [clearDisconnectTimer]);

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
      setRemoteMessage("Guest");
      clearDisconnectTimer();
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
      if (pc.connectionState === "connected") {
        clearDisconnectTimer();
        setRemoteMessage("Guest");
        setStatus("Connected");
      }
      if (pc.connectionState === "disconnected") {
        setStatus("Reconnecting...");
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            if (pcRef.current === pc && pc.connectionState !== "connected") {
              clearRemotePeer("Guest connection lost", "Guest disconnected");
            }
          }, 8000);
        }
      }
      if (pc.connectionState === "failed") {
        setStatus("Connection issue. Waiting for guest...");
      }
    };

    localStreamRef.current?.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localStreamRef.current as MediaStream);
      if (track.kind === "video") videoSenderRef.current = sender;
      if (track.kind === "audio") audioSenderRef.current = sender;
    });

    pcRef.current = pc;
    return pc;
  }, [cleanRoomId, clearDisconnectTimer, clearRemotePeer, peerId, sendSignal]);

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
      if (message.roomId !== cleanRoomId || message.peerId === peerId) return;

      if (message.type === "room-check") {
        if (!joinedRef.current) return;

        if (knownPeerIdsRef.current.size >= maxRoomMembers - 1) {
          sendSignal({
            type: "room-full",
            roomId: cleanRoomId,
            peerId,
            targetPeerId: message.peerId,
            requestId: message.requestId,
          });
        } else {
          sendSignal({
            type: "room-member",
            roomId: cleanRoomId,
            peerId,
            requestId: message.requestId,
          });
        }
        return;
      }

      if (message.type === "room-full") {
        if (message.targetPeerId === peerId) {
          resetCallState("Room full", true);
        }
        return;
      }

      if (!joinedRef.current) return;

      const isKnownPeer = knownPeerIdsRef.current.has(message.peerId);
      if (!isKnownPeer && knownPeerIdsRef.current.size >= maxRoomMembers - 1) {
        sendSignal({
          type: "room-full",
          roomId: cleanRoomId,
          peerId,
          targetPeerId: message.peerId,
        });
        return;
      }

      if (message.type === "leave") {
        if (!knownPeerIdsRef.current.has(message.peerId)) return;

        clearRemotePeer("Guest left the meeting");
        return;
      }

      knownPeerIdsRef.current.add(message.peerId);

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

      } catch {
        setStatus("Signaling message skipped. Rejoin if the call does not connect.");
      }
    },
    [cleanRoomId, clearRemotePeer, getPeerConnection, makeOffer, peerId, resetCallState, sendSignal]
  );

  const startMedia = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    setMicOn(true);
    setCameraOn(true);
  }, []);

  const checkRoomCapacity = useCallback(async () => {
    const requestId = crypto.randomUUID();
    const members = new Set<string>();

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const finish = (canJoin: boolean) => {
        if (settled) return;
        settled = true;
        socketRef.current?.off("signal", onSignal);
        resolve(canJoin);
      };

      const onSignal = (message: SignalMessage) => {
        if (message.roomId !== cleanRoomId || message.peerId === peerId) {
          return;
        }

        if (message.type === "room-member" && message.requestId === requestId) {
          members.add(message.peerId);
          if (members.size >= maxRoomMembers) finish(false);
        }

        if (
          message.type === "room-full" &&
          message.targetPeerId === peerId &&
          message.requestId === requestId
        ) {
          finish(false);
        }
      };

      channelRef.current!.onmessage = (event) => onSignal(event.data);
      socketRef.current?.on("signal", onSignal);

      sendSignal({ type: "room-check", roomId: cleanRoomId, peerId, requestId });
      window.setTimeout(() => finish(true), roomCheckTimeoutMs);
    });
  }, [cleanRoomId, peerId, sendSignal]);

  const joinRoom = useCallback(async () => {
    try {
      const nextUrl = `${window.location.origin}/?room=${cleanRoomId}`;
      setShareUrl(nextUrl);
      window.history.replaceState(null, "", `/?room=${cleanRoomId}`);
      setRoomFull(false);
      setRemoteMessage("Waiting");
      setStatus("Checking room...");

      channelRef.current?.close();
      channelRef.current = new BroadcastChannel(`video-call-${cleanRoomId}`);

      if (signalingUrl && !socketRef.current) {
        const { io } = await import("socket.io-client");
        socketRef.current = io(signalingUrl, { transports: ["websocket"] });
        socketRef.current.emit("join-room", { roomId: cleanRoomId, peerId });
      }

      const canJoin = await checkRoomCapacity();
      if (!canJoin) {
        resetCallState("Room full", true);
        return;
      }

      channelRef.current.onmessage = (event) => handleSignal(event.data);
      socketRef.current?.on("signal", handleSignal);

      setStatus("Opening camera...");
      await startMedia();

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
      resetCallState("Camera or microphone permission was blocked");
    }
  }, [checkRoomCapacity, cleanRoomId, handleSignal, peerId, resetCallState, sendSignal, signalingUrl, startMedia]);

  const leaveRoom = useCallback(() => {
    if (joinedRef.current) sendSignal({ type: "leave", roomId: cleanRoomId, peerId });
    resetCallState();
  }, [cleanRoomId, peerId, resetCallState, sendSignal]);

  useEffect(() => leaveRoom, [leaveRoom]);

  useEffect(() => {
    const announceLeave = () => {
      if (joinedRef.current) {
        sendSignal({ type: "leave", roomId: cleanRoomId, peerId });
      }
    };

    window.addEventListener("pagehide", announceLeave);
    window.addEventListener("beforeunload", announceLeave);

    return () => {
      window.removeEventListener("pagehide", announceLeave);
      window.removeEventListener("beforeunload", announceLeave);
    };
  }, [cleanRoomId, peerId, sendSignal]);

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
          {roomFull && !joined ? (
            <div className="video-tile md:col-span-2">
              <div className="avatar">
                <div className="max-w-sm px-5 text-center">
                  <p className="text-2xl font-semibold">Room full</p>
                  <p className="mt-2 text-sm font-normal text-white/65">Only two people can be in this call at once.</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="video-tile">
                <video ref={localVideoRef} autoPlay playsInline muted className="video-feed" />
                <div className="tile-label">You {micOn ? "" : "(muted)"}</div>
                {!cameraOn && <div className="avatar">You</div>}
              </div>
              <div className="video-tile">
                <video ref={remoteVideoRef} autoPlay playsInline className="video-feed" />
                {!remoteReady && <div className="avatar">{remoteMessage}</div>}
                <div className="tile-label">Guest</div>
              </div>
            </>
          )}
        </div>

        <aside className="flex flex-col gap-4 border-t border-white/10 pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div className="panel">
            <label className="text-sm text-white/60" htmlFor="room">Room code</label>
            <div className="mt-2 flex gap-2">
              <input
                id="room"
                value={roomId}
                onChange={(event) => {
                  setRoomId(event.target.value.toUpperCase());
                  if (!joined) {
                    setRoomFull(false);
                    setStatus("Idle");
                  }
                }}
                disabled={joined}
                className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/8 px-3 py-2 text-white outline-none focus:border-white/45"
              />
              <button
                className="icon-button"
                onClick={() => {
                  setRoomId(makeRoomId());
                  setRoomFull(false);
                  setStatus("Idle");
                }}
                disabled={joined}
                title="New room"
                aria-label="New room"
              >
                <Plus size={20} />
              </button>
            </div>
          </div>

          {roomFull && (
            <div className="panel border-[#fbbc04]/35 bg-[#fbbc04]/10">
              <p className="text-sm font-semibold text-[#fbbc04]">Room is full</p>
              <p className="mt-2 text-sm text-white/75">This call only supports two people. Start a new room or wait for someone to leave.</p>
            </div>
          )}

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
          <button className={roomFull ? "secondary-button" : "primary-button"} onClick={joinRoom}>
            <LogIn size={20} />
            {roomFull ? "Try again" : "Join now"}
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
