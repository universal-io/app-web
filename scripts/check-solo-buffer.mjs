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

async function open(surface, holdsFocus = false) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("PAGE ERROR:", error.message));
  await page.addInitScript(stub, { surface, holdsFocus });
  await page.goto(`${BASE}/solo?debug`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "画面を選ぶ" }).click();
  return page;
}

const panel = (page) => page.locator("div.font-mono").first().innerText();
const strip = (page) => page.locator("img.h-12").count();

// ── 画面全体を共有した場合 ────────────────────────────────
console.log("\n[画面全体を共有]");
{
  const page = await open("monitor");
  await page.waitForSelector("text=分からない画面に戻ってください");
  check(true, "共有直後は「戻ってください」の一文だけ");

  // Turning away briefly must record nothing: the first frame after a switch
  // would still be of this page, which is the one screen never worth keeping.
  await page.evaluate(() => window.__setAway(true));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(300);
  check(await page.locator("text=分からない画面に戻ってください").isVisible(), "一瞬離れただけでは何も残らない");

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
    "戻ると画面が大写しになっている",
  );

  const shown = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(shown === (await page.locator("img.h-12").first().getAttribute("src")), "大写しは最新の候補");

  const box = await page.locator('img[alt="共有された画面"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  check((await page.locator("div.rounded-full.border-cyan-400").count()) === 1, "タップで印がつく");

  await page.locator("img.h-12").nth(1).click();
  await page.waitForTimeout(250);
  const swapped = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(swapped !== shown, "候補を選ぶと大写しが切り替わる");
  check((await page.locator("div.rounded-full.border-cyan-400").count()) === 0, "画面を変えると前の印は消える");

  // Returning must jump back to the newest screen without being asked.
  await page.evaluate(() => window.__setAway(true));
  await page.evaluate(() => window.__paint("sidebar", 40));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(500);
  const afterReturn = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(
    afterReturn === (await page.locator("img.h-12").first().getAttribute("src")),
    "また戻ると最新の画面が出ている",
  );

  await page.getByRole("button", { name: "共有をやめる" }).click();
  await page.waitForTimeout(250);
  check((await page.getByRole("button", { name: "画面を選ぶ" }).count()) === 1, "やめると初期状態に戻る");
  check((await strip(page)) === 0, "やめると候補も消える");
  await page.close();
}

// ── ウィンドウを共有した場合 ──────────────────────────────
console.log("\n[ウィンドウを共有]");
{
  const page = await open("window");
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check(true, "指示を出さずに、すぐ画面が出る");
  check((await strip(page)) === 0, "候補の切り替えは出ない");
  check(
    !(await page.locator("text=分からない画面に戻ってください").isVisible()),
    "「戻ってください」は出さない",
  );

  const before = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  await page.evaluate(() => window.__setAway(true));
  await page.evaluate(() => window.__paint("rows"));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(900);
  const after = await page.locator('img[alt="共有された画面"]').getAttribute("src");
  check(after !== before, "戻ってくると撮り直されている");
  await page.close();
}

// ── タブを共有し、フォーカスをこのページに留めた場合（主経路） ──────
console.log("\n[タブを共有・フォーカス保持]");
{
  const page = await open("browser", true);
  await page.waitForSelector("text=このタブから見ています");
  check(true, "「このタブから見ています」と表示される");
  check(
    (await page.locator("video").first().isVisible()) &&
      (await page.locator('img[alt="共有された画面"]').count()) === 0,
    "既定はライブ映像で、静止画は出ていない",
  );
  check((await strip(page)) === 0, "候補バッファは動かない");

  // Nothing is asked about live video; freezing is what makes a question
  // answerable at all.
  await page.getByRole("button", { name: "この画面について聞く" }).click();
  await page.waitForSelector('img[alt="共有された画面"]', { timeout: 8000 });
  check(true, "「この画面について聞く」で静止する");

  const box = await page.locator('img[alt="共有された画面"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  check((await page.locator("div.rounded-full.border-cyan-400").count()) === 1, "静止画にタップで印がつく");

  await page.getByRole("button", { name: "ライブに戻る" }).click();
  await page.waitForTimeout(250);
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "「ライブに戻る」で静止画が消える");

  // Leaving and returning must not disturb a watched tab: it never went stale.
  await page.evaluate(() => window.__setAway(true));
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.__setAway(false));
  await page.waitForTimeout(400);
  check((await strip(page)) === 0, "離れて戻っても候補は作られない");
  check((await page.locator('img[alt="共有された画面"]').count()) === 0, "離れて戻ってもライブのまま");
  await page.close();
}

await browser.close();
console.log(failures === 0 ? "\nすべて通過" : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
