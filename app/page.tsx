"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { createRoomId, formatRoomId, joinRoom, type RoomConnection } from "@/lib/room";
import { createSharerPeer } from "@/lib/peer";
import {
  messageForCaptureError,
  screenShareUnavailableReason,
  ScreenShareError,
  startScreenShare,
} from "@/lib/screen-share";
import { ensureSession, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";
import { Join } from "@/app/join";

/**
 * The shared side.
 *
 * This device is the one being looked at, so it deliberately offers almost
 * nothing to do: start sharing, show the link, stop. Asking happens on the
 * other device, because a panel for asking questions about this screen would
 * sit on top of the very screen in question (docs/two-device-mode.md §2).
 */
export default function SharePage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [peerState, setPeerState] = useState<RTCPeerConnectionState>("new");
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<RoomConnection | null>(null);
  const peerRef = useRef<ReturnType<typeof createSharerPeer> | null>(null);

  // Read once the session resolves, which only happens in the browser. The
  // server has no navigator, so deciding there would render the sharing side to
  // every device — including the phone, which is never the sharing side.
  const unavailable = ready ? screenShareUnavailableReason() : null;

  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then(() => !cancelled && setReady(true))
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof SessionError ? caught.message : "セッションを開始できませんでした。");
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const viewerURL = roomId ? `${typeof window !== "undefined" ? window.location.origin : ""}/watch/${roomId}` : null;

  useEffect(() => {
    if (!viewerURL) return;
    QRCode.toDataURL(viewerURL, { width: 240, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [viewerURL]);

  const stop = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    roomRef.current?.send({ type: "sharer-gone" });
    void roomRef.current?.leave();
    roomRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setRoomId(null);
    setQr(null);
    setPeerState("new");
  }, [stream]);

  const share = useCallback(async () => {
    setError(null);
    let captured: MediaStream;
    try {
      // The controller is not needed here: the phone is the thing looking at
      // this screen, so nothing is gained by keeping focus on this tab.
      captured = (await startScreenShare()).stream;
    } catch (caught) {
      setError(caught instanceof ScreenShareError ? caught.message : messageForCaptureError("capture-failed"));
      return;
    }

    const id = createRoomId();
    try {
      const room = await joinRoom(id, (message) => {
        void peerRef.current?.handleSignal(message);
      });
      roomRef.current = room;
      peerRef.current = createSharerPeer(captured, room, {
        onStateChange: setPeerState,
        onFailed: setError,
        // A connection that came good must take its own warning down.
        onRecovered: () => setError(null),
      });
      setRoomId(id);
      setStream(captured);
    } catch (caught) {
      captured.getTracks().forEach((track) => track.stop());
      setError(caught instanceof Error ? caught.message : "部屋を作成できませんでした。");
    }
  }, []);

  // Stopping the share from the browser's own bar has to end the session here
  // too, or the page keeps showing a link to a mirror that no longer exists.
  useEffect(() => {
    if (!stream) return;
    const [track] = stream.getVideoTracks();
    const onEnded = () => stop();
    track?.addEventListener("ended", onEnded);
    return () => track?.removeEventListener("ended", onEnded);
  }, [stream, stop]);

  if (!ready) return <Shell><p className="text-slate-500">読み込み中…</p></Shell>;

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">画面を見てもらう</h1>
        <p className="text-sm text-slate-500">
          この画面を共有し、手元のスマホやタブレットから質問します。作業画面は奪いません。
        </p>
      </header>

      {error && <Notice tone="error">{error}</Notice>}

      {/* A phone cannot capture a screen, so it is never the sharing side.
          Leading with a share button it can only fail at — which is what the
          installed Home Screen app opened to — makes the app look broken to
          the very device it exists to be used from. */}
      {unavailable ? (
        <div className="space-y-6">
          <Join />
          <p className="rounded-lg bg-slate-100 px-3 py-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            この端末では画面を共有できません（スマホ・タブレットのブラウザは画面共有に対応していないためです）。
            共有はパソコンから行い、この端末はそれを見る側として使います。
          </p>
        </div>
      ) : !stream ? (
        <div className="space-y-8">
          {/* Solo mode first. Somebody who was sent this link is stuck now, on
              this machine, and pairing a second device is a detour they did not
              ask for (docs/capabilities.md §1). */}
          <div className="space-y-2">
            <Link
              href="/solo"
              className="inline-block rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white"
            >
              このパソコンの画面について聞く
            </Link>
            <p className="text-sm text-slate-500">
              画面を選ぶと、直前に見ていた画面が映ります。分からないところを指して質問できます。
            </p>
          </div>
          <div className="space-y-3 border-t border-slate-200 pt-6 dark:border-slate-700">
            <div className="space-y-1">
              <h2 className="text-base font-medium">スマホやタブレットから質問する</h2>
              <p className="text-sm text-slate-500">
                この画面を手元の端末に映して質問します。作業画面を奪いません。
              </p>
            </div>
            <button
              onClick={share}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-600"
            >
              画面を共有
            </button>
          </div>
          <div className="border-t border-slate-200 pt-6 dark:border-slate-700">
            <Join />
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start gap-6">
            {qr && (
              <div className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="接続用QRコード" className="rounded-lg border border-slate-200 dark:border-slate-700" />
                <p className="text-xs text-slate-500">スマホのカメラで読み取ってください</p>
              </div>
            )}
            <div className="space-y-3">
              <ConnectionState state={peerState} />
              {roomId && (
                <div className="space-y-1">
                  <p className="text-xs text-slate-500">
                    またはスマホでこのコードを入力
                  </p>
                  <code className="block rounded bg-slate-100 px-3 py-2 font-mono text-xl tracking-widest dark:bg-slate-800">
                    {formatRoomId(roomId)}
                  </code>
                </div>
              )}
              {viewerURL && (
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer">URLで開く</summary>
                  <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
                    {viewerURL}
                  </code>
                </details>
              )}
              <button onClick={stop} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600">
                共有をやめる
              </button>
            </div>
          </div>

          {/* Small, but real and displayed: a hidden video is not guaranteed to
              decode, and this doubles as proof the share is still running. */}
          <video ref={videoRef} autoPlay muted playsInline className="w-40 rounded-lg border border-slate-200 dark:border-slate-700" />
        </div>
      )}
    </Shell>
  );
}

function ConnectionState({ state }: { state: RTCPeerConnectionState }) {
  const label: Record<RTCPeerConnectionState, string> = {
    new: "スマホの接続を待っています",
    connecting: "接続中…",
    connected: "接続しました。スマホから質問できます",
    disconnected: "接続が切れました",
    failed: "接続できませんでした",
    closed: "終了しました",
  };
  const tone = state === "connected" ? "text-green-700 dark:text-green-400" : "text-slate-500";
  return <p className={`text-sm ${tone}`}>{label[state]}</p>;
}
