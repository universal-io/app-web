"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createRoomId, joinRoom, type RoomConnection } from "@/lib/room";
import { createSharerPeer } from "@/lib/peer";
import {
  messageForCaptureError,
  screenShareUnavailableReason,
  ScreenShareError,
  startScreenShare,
} from "@/lib/screen-share";
import { ensureSession, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";

/**
 * The shared side.
 *
 * This device is the one being looked at, so it deliberately offers almost
 * nothing to do: start sharing, show the link, stop. Asking happens on the
 * other device, because a panel for asking questions about this screen would
 * sit on top of the very screen in question (docs/requirements.md §10).
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

  const unavailable = typeof window === "undefined" ? null : screenShareUnavailableReason();

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
      captured = await startScreenShare();
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

      {unavailable && <Notice tone="warn">{messageForCaptureError(unavailable)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {!stream ? (
        <button
          onClick={share}
          disabled={Boolean(unavailable)}
          className="self-start rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          画面を共有
        </button>
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
              {viewerURL && (
                <div className="space-y-1">
                  <p className="text-xs text-slate-500">またはこのURLを開く</p>
                  <code className="block break-all rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
                    {viewerURL}
                  </code>
                </div>
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
