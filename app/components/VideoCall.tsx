"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  LogIn,
  Maximize2,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  ShieldCheck,
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
  | { type: "media-state"; roomId: string; peerId: string; micOn: boolean; cameraOn: boolean }
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
  const [remoteMicOn, setRemoteMicOn] = useState(true);
  const [remoteCameraOn, setRemoteCameraOn] = useState(true);
  const [roomFull, setRoomFull] = useState(false);
  const [mobileLocalPrimary, setMobileLocalPrimary] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const micOnRef = useRef(true);
  const cameraOnRef = useRef(true);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const joinedRef = useRef(false);
  const makingOfferRef = useRef(false);
  const hasSentOfferRef = useRef(false);
  const hasRemoteDescriptionRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const knownPeerIdsRef = useRef<Set<string>>(new Set());
  const readyReplyPeerIdsRef = useRef<Set<string>>(new Set());
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (remoteReady && remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [remoteCameraOn, remoteReady]);

  const sendSignal = useCallback(
    (message: SignalMessage) => {
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
    socketRef.current?.disconnect();
    socketRef.current = null;
    joinedRef.current = false;
    makingOfferRef.current = false;
    hasSentOfferRef.current = false;
    hasRemoteDescriptionRef.current = false;
    pendingCandidatesRef.current = [];
    knownPeerIdsRef.current.clear();
    readyReplyPeerIdsRef.current.clear();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.pause();
      remoteVideoRef.current.srcObject = null;
      remoteVideoRef.current.removeAttribute("src");
      remoteVideoRef.current.load();
    }
    setJoined(false);
    micOnRef.current = true;
    cameraOnRef.current = true;
    setMicOn(true);
    setCameraOn(true);
    setRemoteReady(false);
    setRemoteMicOn(true);
    setRemoteCameraOn(true);
    setMobileLocalPrimary(false);
    setRoomFull(nextRoomFull);
    setStatus(nextStatus);
  }, [clearDisconnectTimer]);

  const clearRemotePeer = useCallback((nextStatus: string) => {
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
    readyReplyPeerIdsRef.current.clear();
    makingOfferRef.current = false;
    hasSentOfferRef.current = false;
    hasRemoteDescriptionRef.current = false;
    pendingCandidatesRef.current = [];
    setRemoteReady(false);
    setRemoteMicOn(true);
    setRemoteCameraOn(true);
    setMobileLocalPrimary(false);
    setStatus(nextStatus);
  }, [clearDisconnectTimer]);

  const sendMediaState = useCallback(
    (nextMicOn = micOnRef.current, nextCameraOn = cameraOnRef.current) => {
      if (!joinedRef.current) return;
      sendSignal({
        type: "media-state",
        roomId: cleanRoomId,
        peerId,
        micOn: nextMicOn,
        cameraOn: nextCameraOn,
      });
    },
    [cleanRoomId, peerId, sendSignal]
  );

  const getPeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({ iceServers });
    remoteStreamRef.current = new MediaStream();

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStreamRef.current?.addTrack(track);
        if (track.kind === "video") {
          setRemoteCameraOn(track.readyState === "live" && !track.muted);
          track.onmute = () => setRemoteCameraOn(false);
          track.onunmute = () => setRemoteCameraOn(true);
          track.onended = () => setRemoteCameraOn(false);
        }
      });
      if (remoteVideoRef.current && remoteStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
      setRemoteReady(true);
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
        setStatus("Connected");
      }
      if (pc.connectionState === "disconnected") {
        setStatus("Reconnecting...");
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            if (pcRef.current === pc && pc.connectionState !== "connected") {
              clearRemotePeer("Guest connection lost");
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

  const addPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate);
    }
  }, []);

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

      if (message.type === "media-state") {
        setRemoteMicOn(message.micOn);
        setRemoteCameraOn(message.cameraOn);
        setRemoteReady(true);
        return;
      }

      try {
        const pc = getPeerConnection();
        if (message.type === "ready") {
          setStatus("Peer joined");
          if (!readyReplyPeerIdsRef.current.has(message.peerId)) {
            readyReplyPeerIdsRef.current.add(message.peerId);
            sendSignal({ type: "ready", roomId: cleanRoomId, peerId });
          }
          sendMediaState();
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
          await addPendingCandidates(pc);
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
          await addPendingCandidates(pc);
          setStatus("Connecting...");
        }

        if (message.type === "candidate") {
          if (!pc.remoteDescription) {
            pendingCandidatesRef.current.push(message.candidate);
            return;
          }
          await pc.addIceCandidate(message.candidate);
        }

      } catch {
        setStatus("Signaling message skipped. Rejoin if the call does not connect.");
      }
    },
    [addPendingCandidates, cleanRoomId, clearRemotePeer, getPeerConnection, makeOffer, peerId, resetCallState, sendMediaState, sendSignal]
  );

  const startMedia = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    micOnRef.current = true;
    cameraOnRef.current = true;
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
      setStatus("Checking room...");

      if (!socketRef.current) {
        const { io } = await import("socket.io-client");
        const socket = io({
          transports: ["websocket", "polling"],
          timeout: 5000,
        });
        socketRef.current = socket;

        socket.on("connect", () => {
          socket.emit("join-room", { roomId: cleanRoomId, peerId });
          if (joinedRef.current) {
            socket.emit("signal", { type: "ready", roomId: cleanRoomId, peerId });
            socket.emit("signal", {
              type: "media-state",
              roomId: cleanRoomId,
              peerId,
              micOn: micOnRef.current,
              cameraOn: cameraOnRef.current,
            });
          }
        });

        await new Promise<void>((resolve, reject) => {
          if (socket.connected) {
            resolve();
            return;
          }

          const onConnect = () => {
            socket.off("connect_error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            socket.off("connect", onConnect);
            reject(error);
          };
          socket.once("connect", onConnect);
          socket.once("connect_error", onError);
        });
      }

      const canJoin = await checkRoomCapacity();
      if (!canJoin) {
        resetCallState("Room full", true);
        return;
      }

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
            sendMediaState();
          }
        }, delay);
      });
    } catch (error) {
      resetCallState(
        error instanceof DOMException
          ? "Camera or microphone permission was blocked"
          : "Unable to reach the signaling server"
      );
    }
  }, [checkRoomCapacity, cleanRoomId, handleSignal, peerId, resetCallState, sendMediaState, sendSignal, startMedia]);

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
    const nextMicOn = !micOnRef.current;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = nextMicOn;
    });
    micOnRef.current = nextMicOn;
    setMicOn(nextMicOn);
    sendMediaState(nextMicOn, cameraOnRef.current);
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
      cameraOnRef.current = false;
      setCameraOn(false);
      sendMediaState(micOnRef.current, false);
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
      cameraOnRef.current = true;
      setCameraOn(true);
      sendMediaState(micOnRef.current, true);
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
    <main className={`call-shell ${joined && remoteReady ? "call-shell-connected" : ""}`}>
      <header className="call-header">
        <div className="call-brand">
          <div className="brand-mark" aria-hidden="true">
            <Video size={20} strokeWidth={2.2} />
          </div>
          <div className="min-w-0">
            <div className="call-eyebrow">
              <ShieldCheck size={14} />
              <span>Private meeting</span>
            </div>
            <h1 className="call-title">Room {cleanRoomId}</h1>
          </div>
        </div>

        <div className="header-room-tools">
          <label className="header-room-field" htmlFor="room">
            <span className="header-tool-label">Meeting ID</span>
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
              className="header-room-input"
              aria-label="Meeting ID"
            />
          </label>
          <button
            className="header-icon-button"
            onClick={() => {
              setRoomId(makeRoomId());
              setRoomFull(false);
              setStatus("Idle");
            }}
            disabled={joined}
            title="Create a new room"
            aria-label="Create a new room"
          >
            <Plus size={19} />
          </button>
          <span className="header-divider" aria-hidden="true" />
          <button
            className="invite-button"
            onClick={copyInvite}
            title={shareUrl || `${origin}/?room=${cleanRoomId}`}
            aria-label="Copy invite link"
          >
            <Copy size={18} />
            <span>{copied ? "Copied" : "Copy invite"}</span>
          </button>
        </div>

        <div className="status-pill" title={status}>
          <span className={joined ? "status-dot status-dot-live" : "status-dot"} />
          <span className="status-text">{status}</span>
        </div>
      </header>

      <section className="call-workspace">
        <div className={`video-stage ${remoteReady ? "video-stage-split" : ""}`}>
          {roomFull && !joined ? (
            <div className="video-tile">
              <div className="avatar">
                <div className="max-w-sm px-5 text-center">
                  <p className="text-2xl font-semibold">Room full</p>
                  <p className="mt-2 text-sm font-normal text-white/65">Only two people can be in this call at once.</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`video-tile video-tile-local ${
                  remoteReady
                    ? mobileLocalPrimary
                      ? "mobile-video-primary"
                      : "mobile-video-secondary"
                    : ""
                }`}
              >
                <video ref={localVideoRef} autoPlay playsInline muted className="video-feed" />
                {!joined && (
                  <div className="preview-placeholder">
                    <div className="placeholder-icon">
                      <Video size={26} />
                    </div>
                    <p>Ready when you are</p>
                    <span>Your camera preview will appear after you join</span>
                  </div>
                )}
                <div className="tile-label">
                  <span className="participant-dot" aria-hidden="true" />
                  <span>You</span>
                  <span className="tile-state-icons">
                    {!micOn && (
                      <span className="tile-state-icon tile-state-icon-danger" title="Microphone muted" aria-label="Microphone muted">
                        <MicOff size={14} />
                      </span>
                    )}
                    {!cameraOn && (
                      <span className="tile-state-icon tile-state-icon-warning" title="Camera off" aria-label="Camera off">
                        <VideoOff size={14} />
                      </span>
                    )}
                  </span>
                </div>
                {joined && !cameraOn && (
                  <div className="avatar">
                    <div className="avatar-orb">Y</div>
                  </div>
                )}
                {remoteReady && (
                  <button
                    type="button"
                    className="mobile-video-swap-target"
                    onClick={() => setMobileLocalPrimary(true)}
                    aria-label="Show your video full screen"
                  >
                    <Maximize2 className="mobile-swap-icon" size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              {remoteReady && (
                <div
                  className={`video-tile video-tile-remote ${
                    mobileLocalPrimary ? "mobile-video-secondary" : "mobile-video-primary"
                  }`}
                >
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className={`video-feed ${remoteCameraOn ? "" : "video-feed-hidden"}`}
                  />
                  {!remoteCameraOn && (
                    <div className="avatar">
                      <div className="avatar-orb avatar-orb-guest">G</div>
                    </div>
                  )}
                  <div className="tile-label">
                    <span className="participant-dot participant-dot-guest" aria-hidden="true" />
                    <span>Guest</span>
                    <span className="tile-state-icons">
                      {!remoteMicOn && (
                        <span className="tile-state-icon tile-state-icon-danger" title="Microphone muted" aria-label="Microphone muted">
                          <MicOff size={14} />
                        </span>
                      )}
                      {!remoteCameraOn && (
                        <span className="tile-state-icon tile-state-icon-warning" title="Camera off" aria-label="Camera off">
                          <VideoOff size={14} />
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="mobile-video-swap-target"
                    onClick={() => setMobileLocalPrimary(false)}
                    aria-label="Show guest video full screen"
                  >
                    <Maximize2 className="mobile-swap-icon" size={16} aria-hidden="true" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <footer className="control-dock">
        {!joined ? (
          <button className={roomFull ? "secondary-button" : "primary-button"} onClick={joinRoom}>
            <LogIn size={20} />
            {roomFull ? "Try again" : "Join now"}
          </button>
        ) : (
          <>
            <button className={`control-button ${micOn ? "" : "control-button-off"}`} onClick={toggleMic} title={micOn ? "Mute microphone" : "Unmute microphone"} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
              {micOn ? <Mic size={21} /> : <MicOff size={21} />}
            </button>
            <button className={`control-button ${cameraOn ? "" : "control-button-off"}`} onClick={toggleCamera} title={cameraOn ? "Turn camera off" : "Turn camera on"} aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}>
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
