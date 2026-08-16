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
  /** Fired once a link is established, so a message about not having one can
   * be taken down. An error that outlives its cause is a lie the user has to
   * learn to ignore, and then they ignore the real ones too. */
  onRecovered?: () => void;
};

/**
 * Wires up a peer and returns a watchdog the caller arms itself.
 *
 * The wait is only meaningful once both sides are present. Arming it when the
 * sharer starts meant counting down while the QR code was still being walked
 * over to a phone, and announcing a failure to connect to somebody who had not
 * finished picking the phone up.
 */
function attach(
  peer: RTCPeerConnection,
  room: RoomConnection,
  events: PeerEvents,
): { armWatchdog: () => void } {
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      room.send({ type: "ice", candidate: event.candidate.toJSON() });
    }
  };
  peer.onconnectionstatechange = () => {
    events.onStateChange?.(peer.connectionState);
    if (peer.connectionState === "connected") {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      events.onRecovered?.();
      return;
    }
    // "disconnected" is routine — a lost packet, a network switching over —
    // and recovers on its own. Only "failed" means the path is gone.
    if (peer.connectionState === "failed") {
      events.onFailed?.(
        "端末どうしを直接つなげませんでした。同じWi-Fiに接続しているか確認してください"
        + "（別のネットワークをまたぐ接続には中継サーバーが必要で、まだ用意していません）。",
      );
    }
  };

  return {
    armWatchdog: () => {
      if (watchdog) return;
      watchdog = setTimeout(() => {
        if (peer.connectionState !== "connected") {
          events.onFailed?.(
            "接続に時間がかかりすぎました。両方の端末が同じWi-Fiにあるか確認してください。",
          );
        }
      }, CONNECT_TIMEOUT_MS);
    },
  };
}

/** The PC: holds the capture and offers it. */
export function createSharerPeer(
  stream: MediaStream,
  room: RoomConnection,
  events: PeerEvents = {},
): PeerHandle & { handleSignal: (message: SignalMessage) => Promise<void> } {
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const { armWatchdog } = attach(peer, room, events);
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
      // that joins later would wait for something already gone. It is also
      // the first moment a connection could succeed, so the clock starts here
      // rather than while the room sat empty waiting for someone to scan.
      if (message.type === "viewer-ready") {
        armWatchdog();
        await offer();
      }
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
  const { armWatchdog } = attach(peer, room, events);
  peer.ontrack = (event) => {
    if (event.streams[0]) events.onStream?.(event.streams[0]);
  };
  // The viewer opened a link somebody just handed them, so the sharer is
  // expected to be there already; waiting from this moment is fair.
  armWatchdog();

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
