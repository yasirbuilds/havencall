"use client";

import dynamic from "next/dynamic";

const VideoCall = dynamic(() => import("./VideoCall"), {
  ssr: false,
  loading: () => (
    <main className="grid min-h-screen place-items-center bg-[#0f0f10] px-4 text-white">
      <div className="text-center">
        <p className="text-sm text-white/55">Private call</p>
        <h1 className="mt-1 text-xl font-semibold">Loading room...</h1>
      </div>
    </main>
  ),
});

export default function ClientVideoCall() {
  return <VideoCall />;
}
