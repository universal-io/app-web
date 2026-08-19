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
 * Room codes have to be typed, not just scanned.
 *
 * On iOS a link opened from the camera goes to Safari, never to an installed
 * Home Screen app — so for the device this is meant to be installed on, the QR
 * code cannot be the only way in. A 128-bit hex string was unreadable and
 * unenterable; eight characters can be read off a screen and typed.
 *
 * The alphabet drops the pairs people transcribe wrongly (0/O, 1/I/L), leaving
 * about 39 bits. That is far short of unguessable, and deliberately so for now:
 * rooms are ephemeral and the privacy model is explicitly deferred until the
 * idea has proven useful (docs/companion-mode.md §2). It must be revisited
 * before this is put in front of anyone who is not the person sharing.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export function createRoomId(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Accepts what a person actually types: lower case, stray spaces, the hyphen
 * the code is displayed with. Returns null when nothing usable is left. */
export function normalizeRoomId(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  if (![...code].every((character) => CODE_ALPHABET.includes(character))) return null;
  return code;
}

/** Grouped for reading aloud and copying by eye. */
export function formatRoomId(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
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
