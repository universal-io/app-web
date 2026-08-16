"use client";

import type { RoomConnection, SignalMessage } from "@/lib/room";

/**
 * The peer-to-peer video link.
 *
 * Public STUN only. On the same network — a laptop and the phone next to it,
 * which is the case this is built for — that is enough, and the screen never
 * leaves the local network. Across networks, or behind a symmetric NAT, the
 * connection will fail and needs a TURN relay we do not run yet. That failure
 * is reported rather than left hanging: a mirror that silently never arrives is
 * the exact shape of bug this product refuses to ship (app-mac R11).
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/** How long to wait for the two peers to find a working path before saying so. */
const CONNECT_TIMEOUT_MS = 30_000;

export type PeerHandle = {
  close: () => void;
};

export type PeerEvents = {
  onStream?: (stream: MediaStream) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onFailed?: (message: string) => void;
};

function attach(
  peer: RTCPeerConnection,
  room: RoomConnection,
  events: PeerEvents,
): void {
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      room.send({ type: "ice", candidate: event.candidate.toJSON() });
    }
  };
  peer.onconnectionstatechange = () => {
    events.onStateChange?.(peer.connectionState);
    if (peer.connectionState === "failed") {
      events.onFailed?.(
        "端末どうしを直接つなげませんでした。同じWi-Fiに接続しているか確認してください"
        + "（別のネットワークをまたぐ接続には中継サーバーが必要で、まだ用意していません）。",
      );
    }
  };

  const timer = setTimeout(() => {
    if (peer.connectionState !== "connected") {
      events.onFailed?.(
        "接続に時間がかかりすぎました。両方の端末が同じWi-Fiにあるか確認してください。",
      );
    }
  }, CONNECT_TIMEOUT_MS);
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") clearTimeout(timer);
  });
}

/** The PC: holds the capture and offers it. */
export function createSharerPeer(
  stream: MediaStream,
  room: RoomConnection,
  events: PeerEvents = {},
): PeerHandle & { handleSignal: (message: SignalMessage) => Promise<void> } {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  attach(peer, room, events);
  for (const track of stream.getTracks()) peer.addTrack(track, stream);

  async function offer(): Promise<void> {
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    room.send({ type: "offer", sdp: description.sdp! });
  }

  return {
    close: () => peer.close(),
    handleSignal: async (message) => {
      // The viewer announces itself on arrival, which is what triggers the
      // offer. Offering earlier would send into an empty room, and a viewer
      // that joins later would wait for something already gone.
      if (message.type === "viewer-ready") await offer();
      else if (message.type === "answer") {
        await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
      } else if (message.type === "ice") {
        await peer.addIceCandidate(message.candidate).catch(() => {});
      }
    },
  };
}

/** The phone: receives the mirror. */
export function createViewerPeer(
  room: RoomConnection,
  events: PeerEvents = {},
): PeerHandle & { handleSignal: (message: SignalMessage) => Promise<void> } {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  attach(peer, room, events);
  peer.ontrack = (event) => {
    if (event.streams[0]) events.onStream?.(event.streams[0]);
  };

  return {
    close: () => peer.close(),
    handleSignal: async (message) => {
      if (message.type === "offer") {
        await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
        const description = await peer.createAnswer();
        await peer.setLocalDescription(description);
        room.send({ type: "answer", sdp: description.sdp! });
      } else if (message.type === "ice") {
        await peer.addIceCandidate(message.candidate).catch(() => {});
      }
    },
  };
}
