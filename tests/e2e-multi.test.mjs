// ══════════════════════════════════════════════════════════════
//  e2e-multi.test.mjs — two-human multiplayer end-to-end test
//  Run: node tests/e2e-multi.test.mjs
//
//  Serves the app with the PeerJS CDN script replaced by a
//  BroadcastChannel-based stub, opens a host page (Alice) and a
//  client page (Bob) in one browser context, and plays a full
//  round with 2 humans + 2 CPUs. Asserts state sync, hand
//  redaction on the client, and CPU takeover when Bob leaves.
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

const errors = { alice: [], bob: [] };
let failures = 0;
const fail = msg => { failures++; console.error('✗ FAIL:', msg); };
const ok   = msg => console.log('✓', msg);
const stubSource = await readFile(join(root, 'tests', 'peer-stub.js'), 'utf8');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Serve the Peer stub in place of the CDN script; block other external hosts
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => {
  if (/peerjs.*\.js/.test(r.request().url())) {
    r.fulfill({ contentType: 'text/javascript', body: stubSource });
  } else r.abort();
});

async function newPlayer(tag) {
  const page = await context.newPage();
  page.on('pageerror', e => errors[tag].push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors[tag].push('console: ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const alice = await newPlayer('alice');
const bob   = await newPlayer('bob');

// ── Lobby: create + join ──────────────────────────────────────
await alice.fill('#host-name', 'Alice');
await alice.click('#panel-create .btn');
await alice.waitForFunction(() => document.getElementById('room-code-display').textContent.trim().startsWith('PINE'));
const code = (await alice.textContent('#room-code-display')).trim();
ok(`room created: ${code}`);

await bob.fill('#join-name', 'Bob');
await bob.fill('#room-input', code);
await bob.click('#panel-join .btn-outline');
await bob.waitForFunction(() => document.getElementById('join-status').textContent.includes('Joined'));
await alice.waitForFunction(() =>
  document.getElementById('lobby-players-list').textContent.includes('Bob'));
ok('Bob joined the lobby (visible to host)');

await bob.waitForFunction(() => typeof myPos !== 'undefined' && myPos !== null, null, { timeout: 10000 });
const bobPos = await bob.evaluate(() => myPos);
if (bobPos !== 'north') fail(`second player should sit north (partner), got ${bobPos}`);

// ── Start the game ────────────────────────────────────────────
await alice.click('#start-btn');
await alice.waitForSelector('#game.active');
await bob.waitForSelector('#game.active');
ok('both players entered the game (CPUs at west/east)');

// ── Generic per-player driver ─────────────────────────────────
const snapshot = page => page.evaluate(() => ({
  phase: typeof V !== 'undefined' && V ? V.phase : null,
  roundNum: V?.roundNum ?? 0,
  myTurn: typeof isMyTurn === 'function' ? isMyTurn() : false,
  scores: V ? { ...V.scores } : null,
  winner: V?.winner ?? null,
  trumpModal:  document.getElementById('trump-modal').classList.contains('visible'),
  meldModal:   document.getElementById('meld-modal').classList.contains('visible'),
  roundModal:  document.getElementById('round-modal').classList.contains('visible'),
  overModal:   document.getElementById('gameover-modal').classList.contains('visible'),
  passPanel:   document.getElementById('pass-panel').style.display !== 'none',
  returnPanel: document.getElementById('return-panel').style.display !== 'none',
  bidPanel:    !!document.getElementById('bid-input'),
  selCount:    document.querySelectorAll('.anim-card.selected-anim').length,
  legalCards:  document.querySelectorAll('.anim-card.legal-anim').length,
}));

async function act(page, s) {
  if (s.trumpModal) { await page.click('.trump-opts .trump-btn'); return 'trump'; }
  if (s.meldModal)  { await page.click('#meld-modal .btn'); return 'meld'; }
  if (s.bidPanel) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#action-panel .btn')];
      const pass = btns.find(b => b.textContent.trim() === 'Pass');
      (pass || btns.find(b => b.textContent.trim() === 'Bid'))?.click();
    });
    return 'bid';
  }
  if (s.passPanel || s.returnPanel) {
    const btnId = s.passPanel ? 'pass-confirm-btn' : 'return-confirm-btn';
    await page.evaluate(id => {
      for (const el of [...document.querySelectorAll('.anim-card.legal-anim:not(.selected-anim)')].slice(0, 3))
        el.click();
      const b = document.getElementById(id);
      if (b && !b.disabled) b.click();
    }, btnId);
    return s.passPanel ? 'pass' : 'return';
  }
  if (s.phase === 'playing' && s.myTurn && s.legalCards > 0) {
    await page.evaluate(() => document.querySelector('.anim-card.legal-anim')?.click());
    return 'play';
  }
  return null;
}

// ── Redaction spot-checks on the client once cards are dealt ──
await bob.waitForFunction(() => typeof V !== 'undefined' && V && Array.isArray(V.hands?.north), null, { timeout: 30000 });
const redaction = await bob.evaluate(() => ({
  myHandLen: V.hands.north.length,
  southIsCount: !Array.isArray(V.hands.south) && typeof V.hands.south?.count === 'number',
  dealtHidden: !Array.isArray(V.dealtHands.south),
}));
if (redaction.myHandLen !== 12) fail(`client hand should be 12 cards, got ${redaction.myHandLen}`);
if (!redaction.southIsCount) fail('client can see host hand (redaction hole)');
if (!redaction.dealtHidden) fail('client can see dealt hands before round end');
if (redaction.myHandLen === 12 && redaction.southIsCount && redaction.dealtHidden)
  ok('client view properly redacted (own hand full, others count-only)');

// ── Play one full round from both seats ───────────────────────
let roundDone = false;
const deadline = Date.now() + 6 * 60 * 1000;
let stall = 0, lastSig = '';
while (Date.now() < deadline) {
  const [sa, sb] = await Promise.all([snapshot(alice), snapshot(bob)]);
  const sig = JSON.stringify([sa, sb]);
  stall = sig === lastSig ? stall + 1 : 0;
  lastSig = sig;
  if (stall > 120) { fail(`multiplayer stalled 36s: ${sig}`); break; }

  if ((sa.roundModal || sa.overModal) && (sb.roundModal || sb.overModal)) {
    roundDone = true;
    if (JSON.stringify(sa.scores) !== JSON.stringify(sb.scores))
      fail(`score mismatch: host ${JSON.stringify(sa.scores)} vs client ${JSON.stringify(sb.scores)}`);
    else ok(`round complete on both screens — scores in sync: NS ${sa.scores.ns} / EW ${sa.scores.ew}`);
    break;
  }
  await act(alice, sa);
  await act(bob, sb);
  await alice.waitForTimeout(300);
}
if (!roundDone) fail('round never completed in multiplayer');

// After round_over, dealt hands must be revealed to the client for review
const reviewOk = await bob.evaluate(() =>
  Array.isArray(V.dealtHands.south) && V.dealtHands.south.length === 12);
if (roundDone && !(await bob.evaluate(() => V.winner)) && !reviewOk) fail('deal review not revealed at round end');

// ── Bob leaves: a CPU must take over ──────────────────────────
const gameOver = await alice.evaluate(() => !!V.winner);
await bob.close({ runBeforeUnload: true });
await alice.waitForTimeout(1500);
const takeover = await alice.evaluate(() => ({
  bot: !!playerMap.north?.bot,
  name: playerMap.north?.name,
}));
if (!gameOver) {
  if (!takeover.bot) fail(`CPU takeover failed after disconnect: ${JSON.stringify(takeover)}`);
  else ok(`Bob left — CPU took over north as "${takeover.name}"`);

  // The game must continue: start the next round and reach the next bidding phase
  const cont = await alice.evaluate(() => {
    if (V.phase === 'round_over' && !V.winner) {
      document.getElementById('round-modal').classList.contains('visible');
      document.getElementById('next-round-btn')?.click();
      return true;
    }
    return false;
  });
  if (cont) {
    await alice.waitForFunction(() => V && V.phase === 'bidding' && V.roundNum >= 2, null, { timeout: 20000 });
    ok('next round started with the CPU in Bob\'s seat');
  }
} else {
  ok('game ended within one round (skip takeover continuation check)');
}

const benign = /favicon|net::ERR_FAILED|Failed to load resource/;
for (const [tag, list] of Object.entries(errors)) {
  const real = list.filter(e => !benign.test(e));
  if (real.length) fail(`${tag} page errors:\n  ${real.join('\n  ')}`);
}
if (!failures) ok('no console/page errors on either page');

await alice.screenshot({ path: join(root, 'tests', 'e2e-multi-final.png') });
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nMULTIPLAYER E2E PASSED');
process.exit(failures ? 1 : 0);
