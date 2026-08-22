// Exercises the solo-mode buffer against a synthetic screen share.
//
// getDisplayMedia is replaced by a canvas stream we can repaint, and
// document.hidden / hasFocus are made controllable, so the real recorder, the
// real dedupe and the real UI all run — without a picker, a permission, or a
// human. This is the "look at the picture before forming a hypothesis" tool
// that app-ios's investigation §7 asks for, in the one form a browser allows.
//
//   npm run dev                       # in another terminal
//   npm i --no-save playwright && node scripts/check-solo-buffer.mjs
//
// It drives the user's installed Chrome, so no browser download is needed.
//
// What it CANNOT tell you: whether a real backgrounded tab keeps being fed
// frames, and how often. The tab here is only pretending to be hidden, so its
// timers are not throttled. That number has to come from `?debug` on a real
// share (docs/solo-mode.md §7).
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = "http://localhost:7380";
let failures = 0;

function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
}

const stub = ({ surface, holdsFocus }) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");

  // Two applications that a brightness-only signature would struggle with:
  // both mostly white, differing in layout the way real web apps do.
  window.__paint = (kind, scroll = 0) => {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 1280, 800);
    if (kind === "sidebar") {
      context.fillStyle = "#f1f3f4";
      context.fillRect(0, 0, 260, 800);
      context.fillStyle = "#3c4043";
      for (let row = 0; row < 12; row += 1) context.fillRect(30, 60 + row * 55 - scroll, 190, 18);
      context.fillStyle = "#1a73e8";
      context.fillRect(340, 90 - scroll, 700, 360);
    } else {
      context.fillStyle = "#202124";
      context.fillRect(0, 0, 1280, 64);
      context.fillStyle = "#5f6368";
      for (let row = 0; row < 14; row += 1) context.fillRect(80, 110 + row * 48 - scroll, 1080, 16);
    }
  };
  window.__paint("sidebar");

  const stream = canvas.captureStream(10);
  const [track] = stream.getVideoTracks();
  const settings = track.getSettings.bind(track);
  track.getSettings = () => ({ ...settings(), displaySurface: surface });
  navigator.mediaDevices.getDisplayMedia = async () => stream;

  // setFocusBehavior only works on a controller the browser itself handed to a
  // real getDisplayMedia call, so a stand-in stands in for it. What is being
  // tested here is what the page does once focus IS held, not the API.
  if (holdsFocus) {
    window.CaptureController = class {
      setFocusBehavior() {}
      forwardWheel() { return Promise.resolve(); }
    };
  } else {
    delete window.CaptureController;
  }

  let away = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => away });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (away ? "hidden" : "visible"),
  });
  document.hasFocus = () => !away;
  window.__setAway = (value) => {
    away = value;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(value ? "blur" : "focus"));
  };
};

const browser = await chromium.launch({ channel: "chrome" });

/**
 * A signed-in session, without signing in.
 *
 * The product requires a Google account and this check cannot hold one, so the
 * parts that depend on an account are stood in for: Supabase's session getter
 * and the provisioning RPC. Everything else — capture, gestures, the buffer,
 * the request the Gateway would receive — is the real code.
 *
 * The token is deliberately obvious nonsense. The Gateway is stubbed too, so
 * nothing ever presents it anywhere, and a real one must never end up here.
 */
/**
 * A signed-in session, without signing in.
 *
 * The product requires a Google account and this check cannot hold one, so the
 * two things that depend on an account are stood in for: the stored session and
 * the provisioning RPC. Everything else — capture, gestures, the buffer, the
 * request the Gateway would receive — is the real code.
 */
// The app answers in the language the browser asks for, so this check has to
// ask for one: without it the assertions below (written against the Japanese
// wording) would be compared against an English page on an English machine.
const context = await browser.newContext({ locale: "ja-JP" });

// supabase-js reads its session from this localStorage key, so putting one
// there is enough to be signed in. The token is obvious nonsense and the
// Gateway is stubbed, so it is never presented to anything.
const ref = fs
  .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .match(/NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) throw new Error(".env.local から Supabase のプロジェクト ref を読めませんでした。");

const SESSION = {
  access_token: "test-token-not-a-real-credential",
  refresh_token: "test-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  // Far enough ahead that the client never tries to refresh it over the wire.
  expires_at: 4102444800,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "check@example.invalid",
    app_metadata: {},
    user_metadata: {},
    created_at: "2020-01-01T00:00:00.000Z",
  },
};

/** Every request body the Gateway would have received, for the checks to read. */
const sent = [];

async function stubGateway(page) {
  // Provisioning is an RPC against the real project, which a made-up token
  // cannot do. It is answered here so the account gate opens.
  await page.route("**/rest/v1/rpc/bs_initialize_current_user", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '"00000000-0000-4000-8000-000000000002"' }),
  );
  await page.route("**/ai/vision", async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    // A beat of latency, so the "reading…" state exists long enough to be
    // seen — the real Gateway takes seconds, and instant answers would leave
    // the waiting UI untested.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        request_id: "test",
        capture_id: "test",
        result: {
          mode: "answer",
          message: "これはテストの回答です。",
          observations: [],
          uncertainties: [],
          target_candidate_id: null,
          annotations: [{ id: "a", kind: "highlight", box: { x: 0.3, y: 0.3, w: 0.2, h: 0.1 }, label: "ここ" }],
          skill: null,
        },
        meta: { latency_ms: 1200 },
      }),
    });
  });
}

async function open(surface, holdsFocus = false) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("PAGE ERROR:", error.message));
  await page.addInitScript(
    ([key, session]) => window.localStorage.setItem(key, JSON.stringify(session)),
    [`sb-${ref}-auth-token`, SESSION],
  );
  if (process.env.TRACE) page.on("console", (m) => console.log("  console:", m.text()));
  if (process.env.TRACE) page.on("requestfailed", (r) => console.log("  reqfail:", r.url(), r.failure()?.errorText));
  await stubGateway(page);
  await page.addInitScript(stub, { surface, holdsFocus });
  await page.goto(`${BASE}/?debug`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "画面を選ぶ" }).click();
  return page;
}

const panel = (page) => page.locator("div.font-mono").first().innerText();
/** The screens on offer, which live inside the bubble — there is one place
 * that talks to the user, and the buffer speaks from it like everything else. */
const strip = (page) => page.locator("[data-bubble] img").count();

// ── サインインしていない場合 ──────────────────────────────
// The page is free to look at — only a question costs anything — so there is
// no wall. The sign-in happens on the first action: pressing 画面を選ぶ with
// no session is the trip to Google, not the picker.
console.log("\n[サインインしていない]");
{
  const page = await context.newPage();
  // No session is planted on this page, and this scenario runs before any
  // signed-in one so the context's localStorage is still clean.
  let sentToGoogle = false;
  await page.route("**/auth/v1/authorize*", (route) => {
    sentToGoogle = true;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>oauth</title>" });
  });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    (await page.getByRole("button", { name: "画面を選ぶ" }).count()) === 1,
    "サインインしていなくてもページは見える",
  );
  check(
    await page.locator("text=質問にはGoogleサインインが必要です").isVisible(),
    "サインインが要ることが先に書いてある",
  );
  await page.getByRole("button", { name: "画面を選ぶ" }).click();
  await page.waitForURL("**/auth/v1/authorize*", { timeout: 5000 });
  check(sentToGoogle, "ボタンがGoogleサインインへ連れて行く");
  check((await page.locator("video").count()) === 0, "サインインせずに画面共有は始まらない");
  await page.close();
}

// ── 画面全体を共有した場合（ライブが既定） ────────────────
console.log("\n[画面全体を共有]");
{
  const page = await open("monitor");
  await page.waitForSelector("video");
  check(
    (await page.locator("video").first().isVisible()) &&
      (await page.locator('img[alt="共有された画面"]').count()) === 0,
    "共有直後からライブ映像が出る（静止画も指示文も無い）",
  );
  check(
    (await page.locator("text=分からない画面に戻ってください").count()) === 0,
    "「戻ってください」は存在しない",
  );
  check((await page.locator("div[data-guide]").count()) === 1, "指す前はカバーとスポットライトが出ている");
  check((await panel(page)).includes("表示 ライブ"), "デバッグパネルがライブ表示を報告する");

  // Whole-monitor sharing is the one case that cannot explain itself: the
  // picture may well be this page, and nobody works out on their own that the
  // way through is to go elsewhere and come back. The bubble says so — and
  // says it conditionally, because which monitor was shared is not knowable
  // (capabilities.md §4-B).
  check(
    await page.locator("[data-bubble]").getByText("画面全体を共有しています").isVisible(),
    "画面全体のときは、コンパニオンがその状況を説明する",
  );
  check(
    await page.locator("[data-bubble]").getByText("解説してほしい画面へ一度行き").isVisible(),
    "「行って戻る」という次の一手まで言う",
  );

  // Pointing at the live picture freezes that moment and asks about it — the
  // same gesture as a watched tab. This is the dual-monitor case: the shared
  // monitor is another one, so live is exactly right and must be pointable.
  sent.length = 0;
  const live = await page.locator("video").first().boundingBox();
  await page.mouse.click(live.x + live.width / 2, live.y + live.height / 2);
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check(true, "ライブをクリックすると静止する");
  check((await page.locator("[data-pin]").count()) === 1, "その1クリックがそのまま印になる");
  check(await page.locator("text=読んでいます…").isVisible(), "答えを待つ間「読んでいます…」が出る");
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(sent.length === 1 && sent[0]?.input?.pointer?.kind === "point", "指した1点が送られている");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "Escで閉じるとライブに戻る");

  // Turning away briefly must record nothing: the first frame after a switch
  // would still be of this page, which is the one screen never worth keeping.
  await page.evaluate(() => window.__setAway(true));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(300);
  check((await strip(page)) === 0, "一瞬離れただけでは何も残らない");
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "戻ってもライブのまま");

  await page.evaluate(() => window.__setAway(true));
  await page.evaluate(() => window.__paint("sidebar"));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.__paint("rows"));
  await page.waitForTimeout(2400);
  // Scrolling the same page must not become a third candidate: at one frame a
  // second, a long page would otherwise fill every slot and push out the
  // application the user came back to ask about.
  await page.evaluate(() => window.__paint("rows", 50));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.__paint("rows", 110));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(500);

  console.log("  " + (await panel(page)).replace(/\n/g, " | "));
  check((await strip(page)) === 2, "似た配色でも別アプリは別候補になり、スクロールでは増えない", `候補=${await strip(page)}`);
  check(
    (await page.locator('img[alt="共有された画面"]').count()) === 1,
    "離れて戻ると、直前に見ていた画面が大写しになっている",
  );

  const shown = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(shown === (await page.locator("[data-bubble] img").first().getAttribute("src")), "大写しは最新の候補");

  /**
   * The rescue has to say it is a rescue.
   *
   * Having chosen to watch their own screen, the user can only ever be shown
   * themselves live — so what is on display after coming back is a frame kept
   * while they were away, which is a different thing from everything else in
   * the product and never said so. Unexplained, it just looks like the picture
   * quietly stopped following along.
   */
  check(
    (await page.locator('[data-mode="guide"]').count()) === 1,
    "戻ってきた直後はガイド（＝ライブではない）",
  );
  check(
    await page.locator("[data-bubble]").getByText("これはスクリーンショットです").isVisible(),
    "コンパニオンが「これはスクリーンショットです」と言う",
  );
  check(
    await page.locator("[data-bubble]").getByText("ライブにこのページ自身が映ることがある").isVisible(),
    "なぜ静止画なのか（合わせ鏡）まで言う",
  );
  check(
    await page.locator("[data-bubble]").getByText("これについて解説しますか").isVisible(),
    "そのうえで「解説しますか」と聞く",
  );
  check(
    (await page.locator("[data-bubble]").getByText("画面全体を共有しています").count()) === 0,
    "候補が出たら、もう「行って戻る」の案内は言わない",
  );

  const box = await page.locator('img[alt="共有された画面"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  check((await page.locator("[data-pin]").count()) === 1, "タップで印がつく");

  sent.length = 0;
  await page.locator("[data-bubble] img").nth(1).click();
  await page.waitForTimeout(250);
  const swapped = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(swapped !== shown, "候補を選ぶと大写しが切り替わる");
  check((await page.locator("[data-pin]").count()) === 0, "画面を変えると前の印は消える");

  // The bubble asked "was it this one?", so a tap has to be answered. It used
  // to swap the picture and say nothing, which reads as a control that did not
  // work — and did, to the person who built it.
  //
  // Waited for by watching the request rather than the answer text: the answer
  // from the previous tap is still on screen, so waiting for those words
  // returns instantly and reads a `sent` that has not been filled yet.
  for (let waited = 0; waited < 40 && sent.length === 0; waited += 1) {
    await page.waitForTimeout(100);
  }
  check(
    sent.length === 1 && sent[0]?.input?.question?.includes("この画面について"),
    "候補をタップすると、その画面の説明がすぐ返ってくる",
    sent[0]?.input?.question ?? "何も送っていない",
  );
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(
    swapped === (await page.locator("[data-bubble] img").nth(1).getAttribute("src")),
    "説明されているのは、タップした画面そのもの",
  );

  // Returning must jump back to the newest screen without being asked.
  await page.evaluate(() => window.__setAway(true));
  await page.evaluate(() => window.__paint("sidebar", 40));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(500);
  const afterReturn = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(
    afterReturn === (await page.locator("[data-bubble] img").first().getAttribute("src")),
    "また戻ると最新の画面が出ている",
  );

  // The margin around the picture is "outside": clicking it puts the still
  // away, which on a live surface means back to the moving picture.
  await page.mouse.click(8, 400);
  await page.waitForTimeout(300);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "余白をクリックするとライブに戻る");

  await page.getByRole("button", { name: "ホームに戻る（共有をやめます）" }).click();
  await page.waitForTimeout(250);
  check((await page.getByRole("button", { name: "画面を選ぶ" }).count()) === 1, "やめると初期状態に戻る");
  check((await strip(page)) === 0, "やめると候補も消える");
  await page.close();
}

// ── ウィンドウを共有した場合（ライブが既定） ──────────────
console.log("\n[ウィンドウを共有]");
{
  const page = await open("window");
  await page.waitForSelector("video");

  /**
   * A window is live like everything else, and looks like everything else.
   *
   * It was on a still for as long as the product existed, on the untested
   * theory that the OS stops drawing a window that is not in front. Measured on
   * a real share, an unfocused window kept producing 0.03–0.04 of real change
   * per second where a stopped source reads exactly 0.000 (log.md 2026-08-22).
   *
   * This section also used to check three things, none of them the wash, the
   * bubble or a word of guidance — so "does a window share look like the rest
   * of the product" was never asked at all.
   */
  check(
    (await page.locator("video").first().isVisible()) &&
      (await page.locator('img[alt="共有された画面"]').count()) === 0,
    "共有直後からライブ映像が出る（静止画ではない）",
  );
  check((await strip(page)) === 0, "候補の切り替えは出ない");
  check((await page.locator("div[data-guide]").count()) === 1, "指す前はカバーとスポットライトが出ている");
  check((await page.locator('[data-mode="live"]').count()) === 1, "右上は「ライブ」と名乗る");
  check(
    await page.locator("[data-bubble]").getByText("ウィンドウを共有しています").isVisible(),
    "コンパニオンが、いま何を見ているかを言う",
  );
  check(
    (await page.locator("[data-bubble]").getByText("いま映っているのは静止画です").count()) === 0,
    "もう「静止画です」とは言わない",
  );

  // Pointing on live video freezes that moment and asks about it, exactly as
  // on the other two surfaces.
  sent.length = 0;
  const live = await page.locator("video").first().boundingBox();
  await page.mouse.click(live.x + live.width / 2, live.y + live.height / 2);
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check((await page.locator("[data-pin]").count()) === 1, "ライブをクリックすると静止して印がつく");
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(
    sent.length === 1 && sent[0]?.input?.pointer?.kind === "point",
    "クリックすればそのまま解説が走る（他と同じ）",
  );
  check((await page.locator('[data-mode="guide"]').count()) === 1, "静止している間は「ガイド」と名乗る");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "Escで閉じるとライブに戻る");

  // Going to the window and back must leave the live view alone: there is
  // nothing to re-take when the picture never stopped.
  await page.evaluate(() => window.__setAway(true));
  await page.evaluate(() => window.__paint("rows"));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(900);
  check(
    (await page.locator('img[alt="共有された画面"]').count()) === 0,
    "行って戻ってもライブのまま（撮り直しは要らない）",
  );
  await page.close();
}

// ── タブを共有し、フォーカスをこのページに留めた場合（主経路） ──────
console.log("\n[タブを共有・フォーカス保持]");
{
  const page = await open("browser", true);
  await page.waitForSelector("text=ライブ表示・バッファなし");
  check(true, "タブ共有としてフォーカス保持ありで開始する");
  check(
    (await page.locator("video").first().isVisible()) &&
      (await page.locator('img[alt="共有された画面"]').count()) === 0,
    "既定はライブ映像で、静止画は出ていない",
  );
  check((await strip(page)) === 0, "候補バッファは動かない");

  // Live and held-still look identical when nothing on the shared screen is
  // moving, so the live state has to say so — its absence is what marks the
  // still. Checked in both directions: a badge that never leaves says nothing.
  // Located by its attribute, not its wording: `text=ライブ` also matched the
  // debug panel's "ライブ表示" and reported the badge in states it was not in.
  const liveBadge = page.locator('[data-mode="live"]');
  check((await liveBadge.count()) === 1, "ライブのときは右上に「ライブ」の印が出る");

  // With nothing pointed at, the bubble waits in the bottom-right corner. The
  // browser's own "you are sharing your screen" bar is an OS-level window
  // floating at the bottom centre, and it covered the question box outright
  // when the bubble waited there. That bar is not in the document, so this can
  // only be checked as "not in the middle third along the bottom".
  {
    const view = page.viewportSize();
    const at = await page.locator("[data-bubble]").boundingBox();
    const right = at.x + at.width;
    const bottom = at.y + at.height;
    check(
      right > view.width - 40 && bottom > view.height - 40,
      "何も指していないとき、バブルは右下で待つ",
      `右端まで${Math.round(view.width - right)}px・下端まで${Math.round(view.height - bottom)}px`,
    );
    check(
      at.x > view.width * 0.34,
      "共有バーが浮く下部中央には置かない",
      `左端 ${Math.round(at.x)}px > ${Math.round(view.width * 0.34)}px`,
    );
  }

  // Freezing is what makes a question answerable at all, but it is not a step
  // the user performs: touching the live picture does it, and the touch itself
  // becomes the mark.
  // The picture is indistinguishable from the real application until something
  // says otherwise, so a wash with a spotlight under the cursor asks for the
  // first move — and gets out of the way once it has been made.
  const spotlight = page.locator("div[data-guide]");
  check((await spotlight.count()) === 1, "指す前はカバーとスポットライトが出ている");

  // The page says what it is and what to do, and it says it from the bubble —
  // the one thing here that talks. It used to be a card in the middle of the
  // picture, which is exactly where the user is trying to look.
  check(
    await page.locator("[data-bubble]").getByText("この画面について解説します").isVisible(),
    "何もしていない間、コンパニオンが何をすればいいか言う",
  );
  check(
    (await page.locator("[data-invite]").count()) === 0,
    "絵の真ん中には何も置かない",
  );
  // The wash is paint, not a filter: a tint and a lattice, and nothing that
  // touches the brightness of what shows through. It was a dimming filter once
  // — the version before that laid blue over the picture and inverted on dark
  // pages — and the two were weighed against each other by measurement before
  // this one was chosen (log.md 2026-08-22).
  const paint = await spotlight.evaluate((el) => el.style.background || "");
  check(/rgba\(\d+,\s*\d+,\s*\d+/.test(paint) && paint.includes("radial-gradient"),
    "カバーはティントと格子でできている", paint.slice(0, 48) + "…");

  // The core must be left completely alone. Whatever the wash is made of, the
  // one thing the spotlight promises is that the pointed-at place is shown
  // untouched — light it, tint it, or fog it and the promise is broken.
  const hole = await spotlight.evaluate((el) => el.style.maskImage || el.style.webkitMaskImage || "");
  check(/transparent\s+0%,\s*transparent\s+\d+%/.test(hole), "スポットライトの芯は完全に素のまま", hole.slice(0, 56) + "…");

  const live = await page.locator("video").first().boundingBox();
  await page.mouse.move(live.x + live.width / 3, live.y + live.height / 3);
  await page.waitForTimeout(120);
  const moved = await spotlight.evaluate((el) => el.style.getPropertyValue("--x"));
  check(moved !== "", "スポットライトがマウスに追従する", `--x=${moved || "未設定"}`);

  // Movement is listened for on the window, not on the picture, so the cursor
  // does not have to be over the picture for the light to keep up with it.
  await page.mouse.move(6, 300);
  await page.waitForTimeout(120);
  const offPicture = await spotlight.evaluate((el) => el.style.getPropertyValue("--x"));
  check(offPicture !== moved, "絵の外に出ても追従を続ける", `--x=${offPicture}`);
  await page.mouse.move(live.x + live.width / 3, live.y + live.height / 3);
  await page.waitForTimeout(120);

  // macOS reports continuous cursor movement only to the focused window, so a
  // spotlight left behind would point at somewhere the cursor has left.
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
  await page.waitForTimeout(150);
  const unfocused = await spotlight.evaluate((el) => el.style.maskImage || el.style.webkitMaskImage || "");
  check(!unfocused.includes("radial-gradient"), "フォーカスが無い間はスポットライトを出さない");

  await page.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForTimeout(150);
  const refocused = await spotlight.evaluate((el) => el.style.maskImage || el.style.webkitMaskImage || "");
  check(refocused.includes("radial-gradient"), "フォーカスが戻ればスポットライトも戻る");

  sent.length = 0;
  await page.mouse.click(live.x + live.width / 2, live.y + live.height / 2);
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check(true, "ライブをクリックすると静止する（ボタンは無い）");
  check(
    (await page.locator("[data-pin]").count()) === 1,
    "その1クリックがそのまま印になる",
  );
  // The pair is the point: an absence is not a label, so the still has to name
  // itself rather than be inferred from the live badge being gone.
  check((await liveBadge.count()) === 0, "静止したら「ライブ」の印は消える");
  check(
    (await page.locator('[data-mode="guide"]').count()) === 1,
    "静止している間は「ガイド」と名乗る",
  );

  // The wait must be visible: between the click and the answer there is
  // nothing but model time, and a bubble that sits silent reads as a bubble
  // that didn't hear (pointing.md §5).
  check(await page.locator("text=読んでいます…").isVisible(), "答えを待つ間「読んでいます…」が出る");

  // The answer arrives beside the point, not in a corner panel: close enough
  // to belong to it, far enough not to cover it (pointing.md §9).
  {
    const clicked = { x: live.x + live.width / 2, y: live.y + live.height / 2 };
    const at = await page.locator("[data-bubble]").boundingBox();
    const dx = Math.max(at.x - clicked.x, 0, clicked.x - (at.x + at.width));
    const dy = Math.max(at.y - clicked.y, 0, clicked.y - (at.y + at.height));
    const away = Math.hypot(dx, dy);
    check(away >= 8 && away <= 120, "バブルは指した点の隣に出る（覆わず・離れすぎず）", `${away.toFixed(0)}px`);
  }

  // Pointing at something is already the question.
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(true, "指しただけで解説が走る（ボタンを押さなくてよい）");
  check(sent.length === 1 && sent[0]?.input?.pointer?.kind === "point", "指した1点が送られている");

  // The mark must land where the click did, not offset by the letterbox that
  // object-contain puts above and below the picture.
  const ring = await page.locator("[data-pin]").boundingBox();
  const shot = await page.locator('img[alt="共有された画面"]').boundingBox();
  const offBy = Math.hypot(
    ring.x + ring.width / 2 - (shot.x + shot.width / 2),
    ring.y + ring.height / 2 - (shot.y + shot.height / 2),
  );
  check(offBy < 12, "印の位置がクリック位置と一致する", `ズレ ${offBy.toFixed(1)}px`);

  // There is still no button that turns live *on* — the picture stops because
  // you touched it, never because you asked it to. What exists now is the way
  // back out of an explanation, which is a different thing and lives in the
  // corner (checked below).
  check(
    (await page.getByRole("button", { name: "ライブにする" }).count()) === 0,
    "ライブを「入れる」ボタンは無い（触れば止まる、それだけ）",
  );

  // The picture must not move when it stops moving. A tap that makes its own
  // target jump is a tap that feels like it missed.
  const stillBox = await page.locator('img[alt="共有された画面"]').boundingBox();
  const gap = Math.max(
    Math.abs(stillBox.x - live.x),
    Math.abs(stillBox.y - live.y),
    Math.abs(stillBox.width - live.width),
    Math.abs(stillBox.height - live.height),
  );
  check(gap < 2, "静止しても画面の位置と大きさが変わらない", `ズレ ${gap.toFixed(1)}px`);
  check((await spotlight.count()) === 0, "ピンが打たれたらカバーは消える");

  // Pressing the button must ask about the picture. It once handed the click
  // event to the ask path in place of the capture, and every question came back
  // as "エラーが発生しました".
  await page.getByRole("button", { name: "いまの画面を取り直す" }).click();
  await page.waitForTimeout(300);
  sent.length = 0;
  // No placeholder any more: the bubble sits beside the thing being asked
  // about, which is the only prompt it needs. The words remain as the field's
  // accessible name, so it is still announced.
  await page.locator("[data-bubble] input").fill("これは何ですか");
  // The button wears a paper plane, not a word: "聞く" survives only as its
  // accessible name, which is what this looks it up by.
  const send = page.getByRole("button", { name: "聞く" });
  check(
    (await send.locator("svg").count()) === 1 && (await send.innerText()).trim() === "",
    "送信ボタンは文字ではなく紙飛行機のアイコン",
  );
  await send.click();
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(true, "送信ボタンで質問が通り、回答が出る");

  // The typed question must not shout over the answer it sits under. On a
  // desktop the field matches the answer's own size; a touch device keeps 16px
  // so that iOS Safari does not zoom the page on focus.
  {
    const field = await page
      .locator("[data-bubble] input")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const answerText = await page
      .locator("[data-bubble] p")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(field === answerText, "入力欄の文字は回答と同じ大きさ", `入力 ${field}px / 回答 ${answerText}px`);
  }
  check(
    sent.length === 1 && typeof sent[0]?.input?.image_base64 === "string" && sent[0].input.image_base64.length > 1000,
    "送っているのは画面の画像そのもの",
    `${sent[0]?.input?.image_base64?.length ?? 0} bytes`,
  );
  check(
    (await page.locator("[data-box]").count()) === 1,
    "返ってきた枠が画面に描かれる",
  );

  /**
   * The corner button goes back one step, and says which step.
   *
   * It used to be a ✕ that ended the share in both states, and the ✕ people
   * meant was "get me out of this explanation" — so pressing it threw the
   * share away instead. Now the ✕ only appears where it does that, and the way
   * out wears a house.
   */
  {
    check(
      (await page.getByRole("button", { name: "ライブに戻る" }).count()) === 1 &&
        (await page.getByRole("button", { name: "ホームに戻る（共有をやめます）" }).count()) === 0,
      "解説が出ている間、右上は「ライブに戻る」",
    );
    await page.getByRole("button", { name: "ライブに戻る" }).click();
    await page.waitForTimeout(300);
    check(
      (await page.locator('img[alt="共有された画面"]').count()) === 0,
      "それを押すとライブに戻る（共有は終わらない）",
    );
    check(
      (await page.getByRole("button", { name: "ホームに戻る（共有をやめます）" }).count()) === 1 &&
        (await page.getByRole("button", { name: "ライブに戻る" }).count()) === 0,
      "ライブに戻ると、右上はホームボタンになる",
    );
  }

  await page.getByRole("button", { name: "いまの画面を取り直す" }).click();
  await page.waitForTimeout(200);

  // The grip carries no label — one that has to say it is a grip is not one —
  // but it has to actually move the bubble, and must not be able to drop it
  // somewhere nothing could reach it again.
  check((await page.locator("text=ドラッグで移動できます").count()) === 0, "「ドラッグで移動」の説明は無い");
  {
    const card = page.locator("[data-bubble]");
    const grip = () => page.locator("[data-bubble] span.cursor-grab").first();
    const before = await card.boundingBox();
    let at = await grip().boundingBox();
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x - 200, at.y - 150, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await card.boundingBox();
    check(
      Math.abs(after.x - (before.x - 200)) < 14 && Math.abs(after.y - (before.y - 150)) < 14,
      "バブルは掴んで動かせる",
      `${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)}`,
    );

    at = await grip().boundingBox();
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(-600, -600, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const clamped = await card.boundingBox();
    check(clamped.x >= 0 && clamped.y >= 0, "画面の外には出せない", `${Math.round(clamped.x)},${Math.round(clamped.y)}`);
  }

  check(
    (await page.getByRole("button", { name: "いまの画面を取り直す" }).count()) === 1 &&
      (await page.getByRole("button", { name: "スマホ・タブレットで見る" }).count()) === 1,
    "操作は右上の小さなアイコン3つだけ（取り直し・QR・戻る）",
  );

  await page.getByRole("button", { name: "いまの画面を取り直す" }).click();
  await page.waitForTimeout(250);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "取り直しで動く画面に戻る");

  // A ring drawn over moving video must mean what it means on a still.
  await page.mouse.move(live.x + live.width * 0.3, live.y + live.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(live.x + live.width * 0.6, live.y + live.height * 0.35, { steps: 6 });
  await page.mouse.move(live.x + live.width * 0.6, live.y + live.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check(
    (await page.locator("svg polyline").count()) === 1 &&
      (await page.locator("[data-pin]").count()) === 0,
    "ライブ上でなぞると丸囲みになる（点ではない）",
  );
  await page.waitForSelector("text=これはテストの回答です。", { timeout: 10000 });
  check(
    sent.some((body) => body?.input?.pointer?.kind === "region"),
    "囲んだ範囲でも解説が走る",
  );

  // ── バブル（pointing.md §9） ──────────────────────────
  const bubble = page.locator("[data-bubble]");
  check((await bubble.count()) === 1, "バブルは1つだけ出ている");

  // The ring's whole rectangle is the target, and the bubble must sit beside
  // it, not on it — covering what was circled is answering over the question.
  const shotBox = await page.locator('img[alt="共有された画面"]').boundingBox();
  {
    const ring = {
      x: shotBox.x + shotBox.width * 0.3,
      y: shotBox.y + shotBox.height * 0.3,
      w: shotBox.width * 0.3,
      h: shotBox.height * 0.3,
    };
    const at = await bubble.boundingBox();
    const covers =
      at.x < ring.x + ring.w && at.x + at.width > ring.x && at.y < ring.y + ring.h && at.y + at.height > ring.y;
    check(!covers, "バブルは囲んだ範囲を覆わない");
  }

  // Pointing somewhere else moves the one bubble; it never multiplies.
  {
    const before = await bubble.boundingBox();
    await page.mouse.click(shotBox.x + shotBox.width * 0.8, shotBox.y + shotBox.height * 0.6);
    await page.waitForTimeout(350);
    check((await bubble.count()) === 1, "別の場所を指してもバブルは1つのまま");
    const after = await bubble.boundingBox();
    check(
      Math.abs(after.x - before.x) > 4 || Math.abs(after.y - before.y) > 4,
      "バブルは新しい場所へ移る",
      `${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)}`,
    );
  }

  // At the edges the bubble flips inward instead of running off screen. The
  // top-right corner is skipped down a step — the stop/QR icons live there,
  // and this is a placement check, not a way to end the share.
  {
    const view = page.viewportSize();
    let inside = true;
    for (const [fx, fy] of [[0.03, 0.03], [0.97, 0.12], [0.03, 0.97], [0.97, 0.97]]) {
      await page.mouse.click(shotBox.x + shotBox.width * fx, shotBox.y + shotBox.height * fy);
      await page.waitForTimeout(300);
      const at = await bubble.boundingBox();
      if (at.x < 0 || at.y < 0 || at.x + at.width > view.width || at.y + at.height > view.height) inside = false;
    }
    check(inside, "四隅を指してもバブルは画面内に収まる");
  }

  // Esc puts the bubble away — and on a watched tab that is also the way back
  // to the moving picture, because the still existed only to be asked about.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "Escで閉じるとライブに戻る");

  // Going to the shared tab and back must show how it looks now.
  await page.evaluate(() => window.__setAway(true));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(400);
  check((await strip(page)) === 0, "離れて戻っても候補は作られない");
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "戻ってくるとライブに復帰している");
  await page.close();
}

await browser.close();
console.log(failures === 0 ? "\nすべて通過" : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
