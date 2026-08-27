// ══════════════════════════════════════════════════════════════
//  e2e.test.mjs — browser end-to-end test (practice vs computer)
//  Run: node tests/e2e.test.mjs
//  Requires a globally installed `playwright` (uses createRequire
//  against the global node_modules) and its chromium browser.
//
//  Drives a real human seat through complete rounds:
//  bid/pass, name trump, pass/return 3 cards, play all 12 tricks,
//  check the score modal, start the next round — asserting no
//  console errors and no stalls along the way.
// ══════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function requirePlaywright() {
  for (const base of [
    join(root, 'node_modules'),
    '/opt/node22/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ]) {
    try { return createRequire(join(base, 'x.js'))('playwright'); } catch {}
  }
  throw new Error('playwright not found (npm i -g playwright)');
}
const { chromium } = requirePlaywright();

// ── Tiny static server ────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const data = await readFile(join(root, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

// ── Test driver ───────────────────────────────────────────────
const ROUNDS_TO_PLAY = 2;
const errors = [];
let failures = 0;
const fail = msg => { failures++; console.error('✗ FAIL:', msg); };
const ok   = msg => console.log('✓', msg);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
// Hermetic: block external requests (fonts, CDN); PeerJS is unused in practice mode
await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());

await page.goto(`http://localhost:${PORT}/`);
await page.click('.btn-solo');
await page.waitForSelector('#solo-start-panel', { state: 'visible' });
await page.click('#solo-start-panel .btn-start-game');
await page.waitForSelector('#game.active');
ok('practice game started');

const snapshot = () => page.evaluate(() => ({
  phase: typeof V !== 'undefined' && V ? V.phase : null,
  roundNum: V?.roundNum ?? 0,
  myTurn: typeof isMyTurn === 'function' ? isMyTurn() : false,
  trickLen: V?.currentTrick?.length ?? 0,
  handLen: Array.isArray(V?.hands?.south) ? V.hands.south.length : -1,
  scores: V ? { ...V.scores } : null,
  winner: V?.winner ?? null,
  trumpModal:  document.getElementById('trump-modal').classList.contains('visible'),
  meldModal:   document.getElementById('meld-modal').classList.contains('visible'),
  roundModal:  document.getElementById('round-modal').classList.contains('visible'),
  overModal:   document.getElementById('gameover-modal').classList.contains('visible'),
  passPanel:   document.getElementById('pass-panel').style.display !== 'none',
  returnPanel: document.getElementById('return-panel').style.display !== 'none',
  bidPanel:    !!document.getElementById('bid-input'),
  legalCards:  document.querySelectorAll('.anim-card.legal-anim').length,
  selCount:    document.querySelectorAll('.anim-card.selected-anim').length,
}));

const clickCards = async n => {
  for (let i = 0; i < n; i++) {
    const done = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.anim-card.legal-anim:not(.selected-anim)')];
      if (!els.length) return false;
      els[0].click();
      return true;
    });
    if (!done) break;
    await page.waitForTimeout(150);
  }
};

let roundsSeen = 0, gameEnded = false;
let stall = 0, lastSig = '';
const played = { bid: 0, pass: 0, ret: 0, trump: 0, cards: 0 };

const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  const s = await snapshot();
  const sig = JSON.stringify(s);
  stall = sig === lastSig ? stall + 1 : 0;
  lastSig = sig;
  if (stall > 100) { fail(`stalled 30s in state: ${sig}`); break; }

  if (s.overModal) {
    gameEnded = true;
    ok(`game over reached (winner: ${s.winner})`);
    break;
  }

  if (s.roundModal) {
    roundsSeen++;
    if (s.handLen !== 0) fail('hand not empty at round end');
    ok(`round ${roundsSeen} complete — scores NS ${s.scores.ns} / EW ${s.scores.ew}`);
    if (roundsSeen >= ROUNDS_TO_PLAY) break;
    await page.click('#next-round-btn');
    await page.waitForTimeout(400);
    continue;
  }

  if (s.trumpModal) {
    await page.click('.trump-opts .trump-btn');   // spades
    played.trump++;
    await page.waitForTimeout(200);
    continue;
  }

  if (s.meldModal) {
    await page.click('#meld-modal .btn');
    await page.waitForTimeout(300);
    continue;
  }

  if (s.bidPanel) {
    // Pass when allowed; when stuck dealer, only Bid exists
    const passed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#action-panel .btn')];
      const pass = btns.find(b => b.textContent.trim() === 'Pass');
      (pass || btns.find(b => b.textContent.trim() === 'Bid'))?.click();
      return !!pass;
    });
    played.bid++;
    await page.waitForTimeout(250);
    continue;
  }

  if (s.passPanel) {
    await clickCards(3 - s.selCount);
    const btnOk = await page.evaluate(() => {
      const b = document.getElementById('pass-confirm-btn');
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (btnOk) { played.pass++; await page.waitForTimeout(900); }
    else await page.waitForTimeout(200);
    continue;
  }

  if (s.returnPanel) {
    await clickCards(3 - s.selCount);
    const btnOk = await page.evaluate(() => {
      const b = document.getElementById('return-confirm-btn');
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (btnOk) { played.ret++; await page.waitForTimeout(900); }
    else await page.waitForTimeout(200);
    continue;
  }

  if (s.phase === 'playing' && s.myTurn && s.legalCards > 0) {
    await page.evaluate(() => {
      document.querySelector('.anim-card.legal-anim')?.click();
    });
    played.cards++;
    await page.waitForTimeout(350);
    continue;
  }

  await page.waitForTimeout(300);
}

if (roundsSeen < ROUNDS_TO_PLAY && !gameEnded) fail(`only completed ${roundsSeen}/${ROUNDS_TO_PLAY} rounds`);
if (played.cards < 12) fail(`played only ${played.cards} cards`);
if (played.bid === 0) fail('never saw a bid panel');
ok(`actions — bids: ${played.bid}, trump named: ${played.trump}, passes: ${played.pass}, returns: ${played.ret}, cards played: ${played.cards}`);

const benign = /favicon|net::ERR_FAILED|Failed to load resource/;
const realErrors = errors.filter(e => !benign.test(e));
if (realErrors.length) {
  fail(`page errors:\n  ${realErrors.join('\n  ')}`);
} else ok('no console/page errors');

await page.screenshot({ path: join(root, 'tests', 'e2e-final.png'), fullPage: false });
await browser.close();
server.close();

console.log(failures ? `\n${failures} FAILURES` : '\nE2E PASSED');
process.exit(failures ? 1 : 0);
