"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { GatewayError, TRANSLATED_GATEWAY_CODES } from "@/lib/gateway";
import { RoomError } from "@/lib/room";
import { ScreenShareError } from "@/lib/screen-share";
import { SessionError } from "@/lib/session";

/**
 * One place that turns a thrown thing into a sentence the user can act on.
 *
 * The library layer throws codes, not prose: it runs outside React, where there
 * is no translator, and a message baked in there could only ever exist in one
 * language. So the mapping lives here, next to the component that will show it.
 *
 * The rule the family shares is that no operation ends in silence — every
 * failure reaches either a result or a stated cause (app-mac R11). That is why
 * the last branch never returns an empty string: an error nobody wrote a phrase
 * for still has to say something, so it says what it knows.
 */
export function useErrorText(): (caught: unknown, fallback?: string) => string {
  const t = useTranslations();

  return useCallback(
    (caught: unknown, fallback?: string): string => {
      if (caught instanceof ScreenShareError) return t(`capture.${caught.kind}`);
      if (caught instanceof SessionError) return t(`sessionError.${caught.code}`);
      if (caught instanceof RoomError) return t(`roomError.${caught.code}`);
      if (caught instanceof GatewayError) {
        // A code we have a phrase for gets the phrase. Anything else keeps what
        // the Gateway said, which for an unknown code is the only text that
        // describes what actually happened.
        return isTranslatedGatewayCode(caught.code)
          ? t(`gatewayError.${caught.code}`)
          : caught.message || t("error.generic");
      }
      if (fallback) return fallback;
      return caught instanceof Error && caught.message ? caught.message : t("error.generic");
    },
    [t],
  );
}

/** Codes the peer connection reports, which arrive as bare strings rather than
 * as Error objects — WebRTC failures are events, not throws. */
export function usePeerErrorText(): (code: string) => string {
  const t = useTranslations("peerError");
  return useCallback(
    (code: string) => (code === "no-direct-path" || code === "connect-timeout" ? t(code) : code),
    [t],
  );
}

function isTranslatedGatewayCode(code: string): boolean {
  return (TRANSLATED_GATEWAY_CODES as readonly string[]).includes(code);
}
