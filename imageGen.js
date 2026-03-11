/**
 * src/imageGen.js
 * Rank cards + leaderboard images using @napi-rs/canvas
 * Works on Windows/Mac/Linux with zero system dependencies
 */

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const https = require("https");
const http  = require("http");

// ── Color palette ─────────────────────────────────────────────────────────
const C = {
  bg:      "#0B0B18",
  card:    "#14142A",
  card2:   "#1A1A35",
  strip:   "#0D0D22",
  blurple: "#5865F2",
  cyan:    "#00D4FF",
  pink:    "#EB459E",
  white:   "#FFFFFF",
  grey:    "#8892A4",
  dim:     "#3D4556",
  gold:    "#FFD700",
  silver:  "#C0C0C8",
  bronze:  "#CD7F32",
  green:   "#57F287",
};

const rankColor = r => r === 1 ? C.gold : r === 2 ? C.silver : r === 3 ? C.bronze : C.blurple;

// ── Fetch buffer from URL ─────────────────────────────────────────────────
function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error("no url"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "DiscordBot/3.0" } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ── Rounded rectangle path ────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h,     x, y + h - r,     r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y,         x + r, y,         r);
  ctx.closePath();
}

// ── Draw circle-clipped avatar with glow ring ─────────────────────────────
async function drawAvatar(ctx, url, x, y, size, ring = C.blurple) {
  const cx = x + size / 2, cy = y + size / 2, rad = size / 2;

  // outer glow
  for (let t = 5; t > 0; t--) {
    ctx.save();
    ctx.globalAlpha   = 0.06 * t;
    ctx.strokeStyle   = ring;
    ctx.lineWidth     = 4;
    ctx.shadowColor   = ring;
    ctx.shadowBlur    = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, rad + t * 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // clip circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.clip();

  try {
    const buf = await fetchBuf(url);
    const img = await loadImage(buf);
    ctx.drawImage(img, x, y, size, size);
  } catch {
    // fallback gradient circle
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, ring);
    grad.addColorStop(1, C.card);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle   = C.white;
    ctx.font        = `bold ${Math.floor(size * 0.4)}px sans-serif`;
    ctx.textAlign   = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", cx, cy);
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();

  // crisp ring
  ctx.save();
  ctx.strokeStyle   = ring;
  ctx.lineWidth     = 3;
  ctx.shadowColor   = ring;
  ctx.shadowBlur    = 8;
  ctx.beginPath();
  ctx.arc(cx, cy, rad - 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ── XP progress bar ───────────────────────────────────────────────────────
function drawBar(ctx, x, y, w, h, pct, color = C.blurple) {
  const r = h / 2;
  // track
  ctx.fillStyle = C.strip;
  rr(ctx, x, y, w, h, r); ctx.fill();

  if (pct > 0.005) {
    const fw = Math.max(h, w * Math.min(pct, 1));
    // gradient fill
    const g = ctx.createLinearGradient(x, y, x + fw, y);
    g.addColorStop(0, color);
    g.addColorStop(1, C.cyan);
    ctx.fillStyle = g;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
    rr(ctx, x, y, fw, h, r); ctx.fill();
    ctx.shadowBlur = 0;
    // shine
    ctx.fillStyle   = "rgba(255,255,255,0.18)";
    rr(ctx, x + 3, y + 2, Math.max(4, fw - 6), h * 0.38, r * 0.4);
    ctx.fill();
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  RANK CARD  (940 × 290)
// ══════════════════════════════════════════════════════════════════════════
async function makeRankCard({ username, discriminator, level, xp, xpNeeded, rank, avatarURL }) {
  const W = 940, H = 290;
  const cv  = createCanvas(W, H);
  const ctx = cv.getContext("2d");

  // ── BG ──────────────────────────────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#08081A");
  bg.addColorStop(1, "#150F30");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // dot grid texture
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  for (let gx = 12; gx < W; gx += 30)
    for (let gy = 12; gy < H; gy += 30)
      ctx.fillRect(gx, gy, 2, 2);

  // ── Main card ──────────────────────────────────────────────────────
  ctx.fillStyle = "rgba(20,20,42,0.93)";
  rr(ctx, 14, 14, W - 28, H - 28, 22); ctx.fill();

  // rainbow top strip
  const strip = ctx.createLinearGradient(14, 0, W - 14, 0);
  strip.addColorStop(0,    C.blurple);
  strip.addColorStop(0.4,  C.cyan);
  strip.addColorStop(0.75, C.pink);
  strip.addColorStop(1,    C.blurple);
  ctx.fillStyle   = strip;
  ctx.shadowColor = C.blurple;
  ctx.shadowBlur  = 8;
  rr(ctx, 14, 14, W - 28, 6, 3); ctx.fill();
  ctx.shadowBlur = 0;

  // left neon stripe
  ctx.fillStyle   = C.blurple;
  ctx.shadowColor = C.blurple;
  ctx.shadowBlur  = 10;
  rr(ctx, 14, 14, 5, H - 28, 2); ctx.fill();
  ctx.shadowBlur  = 0;

  // ── Avatar ─────────────────────────────────────────────────────────
  const AV = 136, ax = 38, ay = (H - AV) / 2;
  const rc = rankColor(rank);
  await drawAvatar(ctx, avatarURL, ax, ay, AV, rc);

  // level badge
  const bx = ax + AV - 8, by = ay + AV - 8;
  ctx.fillStyle   = "#08081A";
  ctx.shadowColor = C.blurple;
  ctx.shadowBlur  = 6;
  ctx.beginPath(); ctx.arc(bx, by, 23, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.blurple;
  ctx.beginPath(); ctx.arc(bx, by, 20, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.fillStyle   = C.white;
  ctx.font        = "bold 14px sans-serif";
  ctx.textAlign   = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(level), bx, by);
  ctx.textBaseline = "alphabetic";

  // ── Name & tag ─────────────────────────────────────────────────────
  const tx = ax + AV + 32;
  ctx.textAlign = "left";
  ctx.fillStyle = C.white;
  ctx.font      = "bold 36px sans-serif";
  ctx.fillText(username, tx, 78);
  ctx.fillStyle = C.grey;
  ctx.font      = "16px sans-serif";
  ctx.fillText(`#${discriminator}`, tx, 104);

  // ── Rank badge ─────────────────────────────────────────────────────
  const rx = W - 180;
  ctx.fillStyle = C.grey;
  ctx.font      = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("SERVER RANK", rx + 100, 56);
  ctx.fillStyle   = rc;
  ctx.font        = "bold 58px sans-serif";
  ctx.shadowColor = rc;
  ctx.shadowBlur  = 14;
  ctx.fillText(`#${rank}`, rx + 110, 122);
  ctx.shadowBlur  = 0;

  // ── XP Bar ─────────────────────────────────────────────────────────
  const bX = tx, bY = 152, bW = W - tx - 200, bH = 24;
  const pct = xpNeeded > 0 ? xp / xpNeeded : 0;
  drawBar(ctx, bX, bY, bW, bH, pct, rc);

  ctx.textAlign   = "left";
  ctx.fillStyle   = C.blurple;
  ctx.font        = "bold 13px sans-serif";
  ctx.fillText(`LEVEL ${level}`, bX, bY - 9);

  ctx.textAlign   = "right";
  ctx.fillStyle   = C.grey;
  ctx.font        = "13px sans-serif";
  ctx.fillText(`${xp.toLocaleString()} / ${xpNeeded.toLocaleString()} XP`, bX + bW, bY - 9);

  ctx.textAlign   = "left";
  ctx.fillStyle   = C.dim;
  ctx.font        = "12px sans-serif";
  ctx.fillText(`${(pct * 100).toFixed(1)}%  to Level ${level + 1}`, bX, bY + bH + 16);

  return cv.toBuffer("image/png");
}

// ══════════════════════════════════════════════════════════════════════════
//  LEADERBOARD  (880 × dynamic)
// ══════════════════════════════════════════════════════════════════════════
async function makeLeaderboard({ guildName, guildIconURL, entries }) {
  const ROW    = 86;
  const HEADER = 122;
  const PAD    = 18;
  const W      = 880;
  const H      = HEADER + ROW * entries.length + PAD + 10;

  const cv  = createCanvas(W, H);
  const ctx = cv.getContext("2d");

  // BG
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#08081A");
  bg.addColorStop(1, "#110D28");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // dot grid
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  for (let gx = 12; gx < W; gx += 30)
    for (let gy = 12; gy < H; gy += 30)
      ctx.fillRect(gx, gy, 2, 2);

  // header card
  ctx.fillStyle = "rgba(20,20,42,0.95)";
  rr(ctx, PAD, PAD, W - PAD * 2, HEADER - 10, 18); ctx.fill();

  // header top strip
  const hs = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  hs.addColorStop(0, C.blurple); hs.addColorStop(0.5, C.cyan); hs.addColorStop(1, C.pink);
  ctx.fillStyle   = hs;
  ctx.shadowColor = C.blurple;
  ctx.shadowBlur  = 8;
  rr(ctx, PAD, PAD, W - PAD * 2, 5, 2); ctx.fill();
  ctx.shadowBlur = 0;

  // guild icon
  let iconEndX = PAD + 20;
  if (guildIconURL) {
    await drawAvatar(ctx, guildIconURL, iconEndX, PAD + 12, 72, C.blurple);
    iconEndX += 88;
  }
  ctx.fillStyle   = C.white;
  ctx.font        = "bold 30px sans-serif";
  ctx.textAlign   = "left";
  ctx.fillText(guildName, iconEndX, PAD + 48);
  ctx.fillStyle   = C.grey;
  ctx.font        = "15px sans-serif";
  ctx.fillText("🏆  XP LEADERBOARD", iconEndX, PAD + 76);

  // divider
  ctx.strokeStyle = "rgba(88,101,242,0.25)";
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER - 6);
  ctx.lineTo(W - PAD, HEADER - 6);
  ctx.stroke();

  // ── Rows ──────────────────────────────────────────────────────────
  for (let i = 0; i < entries.length; i++) {
    const e   = entries[i];
    const ry  = HEADER + i * ROW;
    const rc  = rankColor(e.rank);

    ctx.fillStyle = i % 2 === 0 ? "rgba(22,22,44,0.88)" : "rgba(16,16,36,0.88)";
    rr(ctx, PAD, ry + 4, W - PAD * 2, ROW - 8, 14); ctx.fill();

    // rank
    ctx.fillStyle   = rc;
    ctx.font        = "bold 20px sans-serif";
    ctx.textAlign   = "center";
    ctx.shadowColor = rc;
    ctx.shadowBlur  = 8;
    ctx.fillText(`#${e.rank}`, PAD + 30, ry + ROW / 2 + 8);
    ctx.shadowBlur  = 0;

    // avatar
    const AV2 = 56, avx = PAD + 56, avy = ry + (ROW - AV2) / 2;
    await drawAvatar(ctx, e.avatarURL, avx, avy, AV2, rc);

    // name
    const nx = avx + AV2 + 16;
    ctx.fillStyle   = C.white;
    ctx.font        = "bold 19px sans-serif";
    ctx.textAlign   = "left";
    ctx.fillText(e.name, nx, ry + 34);
    ctx.fillStyle   = C.grey;
    ctx.font        = "12px sans-serif";
    ctx.fillText(`#${e.discriminator}`, nx, ry + 54);

    // mini bar
    const bx = nx + 215, by = ry + ROW / 2 - 8;
    const bw = W - bx - PAD - 120;
    const pct = e.xpNeeded > 0 ? e.xp / e.xpNeeded : 0;
    drawBar(ctx, bx, by, bw, 14, pct, rc);

    // level
    const lx = W - PAD - 95;
    ctx.fillStyle   = C.grey;
    ctx.font        = "11px sans-serif";
    ctx.textAlign   = "center";
    ctx.fillText("LVL", lx, ry + 22);
    ctx.fillStyle   = rc;
    ctx.font        = "bold 28px sans-serif";
    ctx.shadowColor = rc;
    ctx.shadowBlur  = 8;
    ctx.fillText(String(e.level), lx, ry + 52);
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = C.grey;
    ctx.font        = "11px sans-serif";
    ctx.fillText(`${e.xp.toLocaleString()} XP`, lx, ry + 70);
  }

  return cv.toBuffer("image/png");
}

module.exports = { makeRankCard, makeLeaderboard };
