// Measures what the frame signature actually reports for changes of the kind
// real screens make, so SAME_SCREEN can be set on numbers rather than a guess.
//
//   npm run dev                       # in another terminal
//   npm i --no-save playwright && node scripts/measure-signature-drift.mjs
//
// The first guess at the threshold was 0.045, which this showed to sit below
// an ordinary 50px scroll — so scrolling a long page started a new candidate
// every second. Re-run it after touching signatureOf() in lib/screen-share.ts;
// the numbers move when the signature does.
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://localhost:7380/", { waitUntil: "domcontentloaded" });

const results = await page.evaluate(async () => {
  const EDGE = 16;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d");

  function paint(kind, scroll = 0, extra = null) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 1280, 800);
    if (kind === "sidebar") {
      context.fillStyle = "#f1f3f4";
      context.fillRect(0, 0, 260, 800);
      context.fillStyle = "#3c4043";
      for (let row = 0; row < 12; row += 1) context.fillRect(30, 60 + row * 55 - scroll, 190, 18);
      context.fillStyle = "#1a73e8";
      context.fillRect(340, 90 - scroll, 700, 360);
    } else if (kind === "rows") {
      context.fillStyle = "#202124";
      context.fillRect(0, 0, 1280, 64);
      context.fillStyle = "#5f6368";
      for (let row = 0; row < 14; row += 1) context.fillRect(80, 110 + row * 48 - scroll, 1080, 16);
    }
    if (extra === "menu") {
      context.fillStyle = "#ffffff";
      context.fillRect(900, 120, 300, 260);
      context.fillStyle = "#dadce0";
      context.strokeRect(900, 120, 300, 260);
      context.fillStyle = "#3c4043";
      for (let row = 0; row < 5; row += 1) context.fillRect(920, 145 + row * 48, 250, 14);
    }
    if (extra === "dark") {
      context.fillStyle = "rgba(0,0,0,0.45)";
      context.fillRect(0, 0, 1280, 800);
    }
  }

  function signature() {
    const small = document.createElement("canvas");
    small.width = EDGE;
    small.height = EDGE;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, EDGE, EDGE);
    const { data } = ctx.getImageData(0, 0, EDGE, EDGE);
    const out = new Uint8ClampedArray(EDGE * EDGE * 3);
    for (let i = 0; i < EDGE * EDGE; i += 1) {
      out[i * 3] = data[i * 4];
      out[i * 3 + 1] = data[i * 4 + 1];
      out[i * 3 + 2] = data[i * 4 + 2];
    }
    return out;
  }

  function difference(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
    return total / (a.length * 255);
  }

  paint("sidebar");
  const base = signature();
  const cases = [];
  for (const [label, run] of [
    ["同じ画面（無変化）", () => paint("sidebar")],
    ["少しスクロール 50px", () => paint("sidebar", 50)],
    ["スクロール 200px", () => paint("sidebar", 200)],
    ["スクロール 400px", () => paint("sidebar", 400)],
    ["メニューを開いた", () => paint("sidebar", 0, "menu")],
    ["ダイアログで暗転", () => paint("sidebar", 0, "dark")],
    ["別アプリ（配色は似ている）", () => paint("rows")],
  ]) {
    run();
    cases.push([label, difference(base, signature())]);
  }
  return cases;
});

// Keep in step with SAME_SCREEN in lib/recent-screens.ts.
const THRESHOLD = 0.12;

console.log(`SAME_SCREEN 閾値 = ${THRESHOLD}\n`);
for (const [label, value] of results) {
  console.log(`  ${value.toFixed(4)}  ${value < THRESHOLD ? "同じ画面とみなす" : "別候補になる  "}  ${label}`);
}
await browser.close();
