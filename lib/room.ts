"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowserClient } from "@/lib/supabase";

/**
 * The room two devices meet in.
 *
 * WebRTC needs a way for the two peers to exchange offers, answers, and ICE
 * candidates before they can talk directly. That normally means standing up a
 * WebSocket server — the one piece of this product that genuinely could not
 * live in serverless Next.js. Supabase Realtime already provides exactly that
 * channel, and it is already a dependency, so the signalling problem is solved
 * without a new service to deploy, monitor, or pay for.
 *
 * Only signalling passes through here. The screen itself flows peer to peer and
 * never touches our servers, which is both cheaper and a stronger privacy
 * statement than any policy text.
 */

export type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "viewer-ready" }
  | { type: "sharer-gone" };

/**
 * Room ids are guessable-resistant rather than merely unique: the id is the
 * only thing standing between a room and anyone who tries one, until the
 * privacy model in requirements.md §10 exists. 128 bits from the platform CSPRNG.
 */
export function createRoomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type RoomConnection = {
  send: (message: SignalMessage) => void;
  leave: () => Promise<void>;
};

export async function joinRoom(
  roomId: string,
  onMessage: (message: SignalMessage) => void,
): Promise<RoomConnection> {
  const channel: RealtimeChannel = supabaseBrowserClient()
    .channel(`uio-room-${roomId}`, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      onMessage(payload as SignalMessage);
    });

  await new Promise<void>((resolve, reject) => {
    // Without a deadline a channel that never subscribes leaves the caller
    // waiting forever with nothing on screen to explain why.
    const timer = setTimeout(
      () => reject(new Error("シグナリングに接続できませんでした。")),
      15_000,
    );
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`シグナリングに接続できませんでした（${status}）。`));
      }
    });
  });

  return {
    send: (message) => {
      void channel.send({ type: "broadcast", event: "signal", payload: message });
    },
    leave: async () => {
      await supabaseBrowserClient().removeChannel(channel);
    },
  };
}
