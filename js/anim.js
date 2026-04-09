// ══════════════════════════════════════════════════════════════
//  anim.js  —  Card Animation Engine
//
//  Architecture:
//    • All card elements are positioned absolutely on #anim-layer
//    • The "logical" hand / trick zones are invisible anchor divs
//    • We FLIP-animate: capture start rect → move to end → animate delta
//    • Cards have a 3-D flip (CSS transform rotateY) for face-up reveal
//
//  Public API (called by ui.js):
//    animDeal(hands)              — deal 12 cards to each seat
//    animPlayCard(card, fromPos)  — card flies from hand to trick slot
//    animTrickSweep(winnerPos, trickCards) — collect trick to winner
//    animPassCards(cards, fromPos, toPos)  — 3 cards arc to partner
//    animReceiveCards(cards, toPos)        — 3 cards materialize in hand
//    rebuildHandFan(pos)          — re-layout hand fan after state change
//    getCardEl(cardKey)           — lookup live card element
//    removeCardEl(cardKey)        — remove from DOM + registry
// ══════════════════════════════════════════════════════════════

'use strict';

// ── Constants ────────────────────────────────────────────────
const CARD_W    = 64;   // px, matches CSS
const CARD_H    = 96;
const FAN_LIFT  = 18;   // px upward lift on hover in fan
const FAN_SPREAD = 28;  // px overlap reduction vs full stack
const MAX_FAN_ROT = 24; // degrees total arc for 12-card hand

// Seat anchor positions (center of each seat area, relative to #table)
// These are recomputed on resize via getSeatCenter()
const SEAT_ORIGINS = { south: null, north: null, west: null, east: null };

// Card registry: cardKey → { el, cardData, pos (absolute seat) }
const CARD_REGISTRY = {};

// Trick slot positions cache
const TRICK_RECTS = {};

// ── Layer setup ──────────────────────────────────────────────
let animLayer = null;

function initAnimLayer() {
  animLayer = document.getElementById('anim-layer');
  if (!animLayer) {
    animLayer = document.createElement('div');
    animLayer.id = 'anim-layer';
    animLayer.style.cssText = `
      position:absolute; inset:0; pointer-events:none; overflow:visible; z-index:20;
    `;
    document.getElementById('table').appendChild(animLayer);
  }
  window.addEventListener('resize', onResize);
  onResize();
}

function onResize() {
  for (const pos of ['south','north','west','east']) {
    SEAT_ORIGINS[pos] = getSeatCenter(pos);
  }
  for (const pos of ['south','north','west','east']) {
    TRICK_RECTS[pos] = getTrickSlotRect(pos);
  }
}

// ── Geometry helpers ─────────────────────────────────────────

function tableRect() {
  return document.getElementById('table').getBoundingClientRect();
}

function elCenter(el) {
  const r = el.getBoundingClientRect();
  const t = tableRect();
  return { x: r.left - t.left + r.width/2, y: r.top - t.top + r.height/2 };
}

function getSeatCenter(dispPos) {
  const seat = document.getElementById('seat-' + dispPos);
  if (!seat) return { x: 0, y: 0 };
  return elCenter(seat);
}

function getTrickSlotRect(dispPos) {
  const slot = document.getElementById('trick-' + dispPos);
  if (!slot) return { x: 0, y: 0, w: CARD_W, h: CARD_H };
  const r = slot.getBoundingClientRect();
  const t = tableRect();
  return { x: r.left - t.left, y: r.top - t.top, w: r.width, h: r.height };
}

function tableCenter() {
  const t = tableRect();
  return { x: t.width / 2, y: t.height / 2 };
}

// ── Card element factory ─────────────────────────────────────

function createCardEl(card, faceDown = false) {
  const key = cardKey(card);
  const isRed = RED_SUITS.has(card.s);
  const sym = SUIT_SYM[card.s];

  const wrapper = document.createElement('div');
  wrapper.className = 'anim-card' + (isRed ? ' red' : '');
  wrapper.dataset.key = key;
  wrapper.style.cssText = `
    position: absolute; width: ${CARD_W}px; height: ${CARD_H}px;
    pointer-events: none;
    transform-style: preserve-3d;
    transition: none;
    will-change: transform;
    cursor: pointer;
  `;

  // Front face
  const front = document.createElement('div');
  front.className = 'anim-card-face anim-card-front' + (isRed ? ' red' : '');
  front.innerHTML = `
    <div class="ac-corner">${card.r}<br>${sym}</div>
    <div class="ac-center">${sym}</div>
    <div class="ac-corner ac-corner-bot">${card.r}<br>${sym}</div>`;

  // Back face
  const back = document.createElement('div');
  back.className = 'anim-card-face anim-card-back';
  back.innerHTML = `<div class="ac-back-pattern"></div>`;

  wrapper.appendChild(front);
  wrapper.appendChild(back);

  if (faceDown) wrapper.classList.add('flipped');

  return wrapper;
}

// Register and position a card at absolute table coordinates
function placeCard(el, x, y, rotation = 0, scaleX = 1, scaleY = 1) {
  el.style.left   = (x - CARD_W / 2) + 'px';
  el.style.top    = (y - CARD_H / 2) + 'px';
  el.style.transform = `rotate(${rotation}deg) scale(${scaleX},${scaleY})`;
}

// ── FLIP animation utility ────────────────────────────────────
// Move element from current position to target (x,y,rot) with animation

function animMoveTo(el, toX, toY, toRot, opts = {}) {
  const {
    duration    = 380,
    easing      = 'cubic-bezier(0.22,1,0.36,1)',
    delay       = 0,
    scaleStart  = 1,
    scaleEnd    = 1,
    onComplete  = null,
    zIndex      = null,
  } = opts;

  if (zIndex !== null) el.style.zIndex = zIndex;

  const fromLeft = parseFloat(el.style.left) || 0;
  const fromTop  = parseFloat(el.style.top)  || 0;
  const fromMat  = new DOMMatrix(el.style.transform || '');
  const fromRot  = Math.atan2(fromMat.m21, fromMat.m11) * (180/Math.PI);

  const toLeft = toX - CARD_W / 2;
  const toTop  = toY - CARD_H / 2;

  const anim = el.animate([
    { left: fromLeft+'px', top: fromTop+'px', transform: `rotate(${fromRot}deg) scale(${scaleStart})` },
    { left: toLeft+'px',   top: toTop+'px',   transform: `rotate(${toRot}deg) scale(${scaleEnd})` },
  ], {
    duration, easing, delay, fill: 'forwards'
  });

  anim.onfinish = () => {
    el.style.left      = toLeft + 'px';
    el.style.top       = toTop  + 'px';
    el.style.transform = `rotate(${toRot}deg) scale(${scaleEnd})`;
    anim.cancel();
    if (onComplete) onComplete();
  };
  return anim;
}

// Flip a card face-up (or face-down)
function flipCard(el, faceUp = true, duration = 280, delay = 0) {
  return new Promise(resolve => {
    const mid = duration / 2;
    const a1 = el.animate([
      { transform: el.style.transform + ' rotateY(0deg)' },
      { transform: el.style.transform + ' rotateY(90deg)' },
    ], { duration: mid, delay, fill: 'forwards', easing: 'ease-in' });

    a1.onfinish = () => {
      if (faceUp) el.classList.remove('flipped');
      else        el.classList.add('flipped');
      el.style.transform = el.style.transform.replace(/ rotateY\([^)]+\)/,'');
      const a2 = el.animate([
        { transform: el.style.transform + ' rotateY(-90deg)' },
        { transform: el.style.transform + ' rotateY(0deg)' },
      ], { duration: mid, fill: 'forwards', easing: 'ease-out' });
      a2.onfinish = () => { a2.cancel(); resolve(); };
    };
  });
}

// ── Fan layout math ───────────────────────────────────────────

function fanPositions(count, containerCenterX, baseY, dispPos) {
  if (count === 0) return [];
  const isVertical = dispPos === 'west' || dispPos === 'east';

  // Arc parameters scale with hand size
  const spreadPx  = Math.min(42, 500 / count);  // px between card centers
  const totalW    = spreadPx * (count - 1);
  const arcRadius = Math.max(600, count * 80);   // larger = flatter arc
  const maxRot    = Math.min(MAX_FAN_ROT, count * 2.2);

  const positions = [];
  for (let i = 0; i < count; i++) {
    const t    = count === 1 ? 0 : (i / (count - 1)) - 0.5; // -0.5 to 0.5
    const xOff = t * totalW;
    const yOff = (t * t) * (totalW * totalW) / (2 * arcRadius); // parabolic arc
    const rot  = t * maxRot;

    if (isVertical) {
      const yPos = containerCenterX + xOff; // use y-axis for vertical seats
      const xPos = baseY + yOff;
      positions.push({ x: xPos, y: yPos, rot: rot + (dispPos === 'west' ? 90 : -90) });
    } else if (dispPos === 'north') {
      positions.push({ x: containerCenterX + xOff, y: baseY + yOff, rot: rot + 180 });
    } else {
      positions.push({ x: containerCenterX + xOff, y: baseY - yOff, rot });
    }
  }
  return positions;
}

function getHandBaseline(dispPos) {
  const t = tableRect();
  switch (dispPos) {
    case 'south': return { cx: t.width / 2, baseY: t.height - 110 };
    case 'north': return { cx: t.width / 2, baseY: 110 };
    case 'west':  return { cx: 80,           baseY: t.height / 2 };
    case 'east':  return { cx: t.width - 80, baseY: t.height / 2 };
  }
}

// ── DEAL ANIMATION ────────────────────────────────────────────

let _dealResolve = null;

async function animDeal(handsData) {
  // handsData: { south: [{r,s},...], west: [...], ... }  (only myPos has real cards)
  // Others get card-back stubs

  // Clear any existing cards
  clearAllCards();

  // Create a deck pile in center
  const tc = tableCenter();
  const deckEl = document.createElement('div');
  deckEl.className = 'deck-pile';
  deckEl.style.cssText = `
    position:absolute; width:${CARD_W}px; height:${CARD_H}px;
    left:${tc.x - CARD_W/2}px; top:${tc.y - CARD_H/2}px;
    pointer-events:none; z-index:25;
  `;
  for (let i = 0; i < 5; i++) {
    const stub = document.createElement('div');
    stub.className = 'anim-card-face anim-card-back';
    stub.style.cssText = `position:absolute; inset:${-i/2}px; border-radius:5px;`;
    stub.innerHTML = `<div class="ac-back-pattern"></div>`;
    deckEl.appendChild(stub);
  }
  animLayer.appendChild(deckEl);

  // Deal order: 1 card at a time to each seat, 12 rounds
  const dispPositions = ['south','west','north','east'];
  const totalCards    = 48;
  const dealInterval  = 55; // ms between cards

  // Pre-sort my hand
  const myHand = handsData[myPos] ? [...handsData[myPos]] : [];
  sortHand(myHand);

  // Build per-seat card lists
  const seatCards = {};
  for (const dp of dispPositions) {
    const absP = displayToAbs(dp);
    seatCards[dp] = absP === myPos ? myHand : null; // null = backs
  }
  const seatCounts = { south: 0, west: 0, north: 0, east: 0 };
  const seatHandEls = { south: [], west: [], north: [], east: [] };

  await new Promise(resolve => {
    let cardIdx = 0;
    const interval = setInterval(() => {
      if (cardIdx >= totalCards) {
        clearInterval(interval);
        setTimeout(() => {
          deckEl.remove();
          // Now fan out all hands
          for (const dp of dispPositions) {
            fanAnimateHand(dp, seatHandEls[dp], seatCards[dp]);
          }
          resolve();
        }, 200);
        return;
      }

      const dp    = dispPositions[cardIdx % 4];
      const count = seatCounts[dp];
      seatCounts[dp]++;

      const cardData = seatCards[dp] ? seatCards[dp][count] : null;
      const faceDown = !cardData;
      const el       = faceDown
        ? createCardBack()
        : createCardEl(cardData, false);

      if (cardData) {
        const key = cardKey(cardData);
        CARD_REGISTRY[key] = { el, cardData, dispPos: dp };
      } else {
        // give back a synthetic key
        el.dataset.stub = dp + '-' + count;
      }

      // Start at deck center
      el.style.left    = (tc.x - CARD_W / 2) + 'px';
      el.style.top     = (tc.y - CARD_H / 2) + 'px';
      el.style.zIndex  = 25 + cardIdx;
      el.style.transform = 'rotate(0deg)';
      animLayer.appendChild(el);
      seatHandEls[dp].push(el);

      // Animate to a stacked position near the seat
      const baseline = getHandBaseline(dp);
      const stackJitter = { x: (Math.random()-0.5)*4, y: (Math.random()-0.5)*4 };

      animMoveTo(el, baseline.cx + stackJitter.x, baseline.baseY + stackJitter.y, 0, {
        duration: 260,
        easing: 'cubic-bezier(0.25,0.46,0.45,0.94)',
        delay: 0,
        zIndex: 25 + cardIdx,
      });

      cardIdx++;
    }, dealInterval);
  });

  // Give it a moment for fan animation to settle
  await wait(700);
}

function createCardBack() {
  const el = document.createElement('div');
  el.className = 'anim-card flipped';
  el.style.cssText = `
    position:absolute; width:${CARD_W}px; height:${CARD_H}px;
    transform-style:preserve-3d; pointer-events:none; will-change:transform;
  `;
  const back = document.createElement('div');
  back.className = 'anim-card-face anim-card-back';
  back.innerHTML = `<div class="ac-back-pattern"></div>`;
  el.appendChild(back);
  return el;
}

function fanAnimateHand(dispPos, els, cardDatas) {
  const baseline = getHandBaseline(dispPos);
  const positions = fanPositions(els.length, baseline.cx, baseline.baseY, dispPos);

  els.forEach((el, i) => {
    const p = positions[i];
    const delay = i * 22;
    animMoveTo(el, p.x, p.y, p.rot, {
      duration: 320,
      easing: 'cubic-bezier(0.34,1.56,0.64,1)',
      delay,
      zIndex: 30 + i,
    });

    // Make my cards interactive after fan settles
    if (dispPos === 'south' && cardDatas && cardDatas[i]) {
      setTimeout(() => {
        el.style.pointerEvents = 'auto';
        attachHoverEffect(el, p, i, els.length);
      }, delay + 400);
    }
  });
}

// ── Hover effect for my cards ─────────────────────────────────

function attachHoverEffect(el, basePos, idx, total) {
  el.addEventListener('mouseenter', () => {
    if (el.classList.contains('disabled-anim')) return;
    el.style.transition = 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1)';
    el.style.zIndex     = 100;

    const liftDir = basePos.rot > 0 ? 1 : basePos.rot < 0 ? -1 : 0;
    const liftX   = liftDir * -FAN_LIFT * 0.3;
    const liftY   = -FAN_LIFT;
    el.style.transform = `translate(${liftX}px, ${liftY}px) rotate(${basePos.rot}deg) scale(1.06)`;
  });
  el.addEventListener('mouseleave', () => {
    el.style.transition = 'transform 0.2s ease-out';
    el.style.zIndex     = 30 + idx;
    el.style.transform  = `rotate(${basePos.rot}deg)`;
  });
}

// ── REBUILD HAND FAN ──────────────────────────────────────────
// Called after a card is played / received — re-layouts the fan

function rebuildHandFan(dispPos, cardDataList, opts = {}) {
  const { selKeys = [], legalKeys = [], clickable = false, onCardClick = null } = opts;

  // Collect existing els for these cards and any stubs
  const baseline  = getHandBaseline(dispPos);
  const positions = fanPositions(cardDataList.length, baseline.cx, baseline.baseY, dispPos);

  // Remove old stubs for this seat (non-keyed back cards)
  animLayer.querySelectorAll(`[data-stub^="${dispPos}-"]`).forEach(e => e.remove());

  cardDataList.forEach((card, i) => {
    const key = cardKey(card);
    let entry = CARD_REGISTRY[key];
    if (!entry) {
      // Create the card element if missing
      const el = createCardEl(card);
      el.style.left  = baseline.cx - CARD_W/2 + 'px';
      el.style.top   = baseline.baseY - CARD_H/2 + 'px';
      animLayer.appendChild(el);
      entry = { el, cardData: card, dispPos };
      CARD_REGISTRY[key] = entry;
    }
    entry.dispPos = dispPos;

    const p     = positions[i];
    const isSel = selKeys.includes(key);

    // Remove old listeners by cloning
    const newEl = entry.el.cloneNode(true);
    entry.el.replaceWith(newEl);
    entry.el = newEl;
    CARD_REGISTRY[key].el = newEl;

    const liftExtra = isSel ? -10 : 0;
    animMoveTo(newEl, p.x, p.y + liftExtra, p.rot, {
      duration: 220,
      easing: 'cubic-bezier(0.34,1.56,0.64,1)',
      delay: i * 12,
      zIndex: 30 + i,
    });

    if (dispPos === 'south') {
      newEl.style.pointerEvents = 'auto';
      const isLegal = legalKeys.length === 0 || legalKeys.includes(key);
      newEl.classList.toggle('disabled-anim', !isLegal || !clickable);
      newEl.classList.toggle('legal-anim', isLegal && clickable);
      newEl.classList.toggle('selected-anim', isSel);

      if (clickable && isLegal && onCardClick) {
        newEl.style.cursor = 'pointer';
        newEl.addEventListener('click', () => onCardClick(card));
      }

      if (isLegal && clickable) {
        setTimeout(() => attachHoverEffect(newEl, p, i, cardDataList.length), i * 12 + 250);
      }
    } else {
      newEl.style.pointerEvents = 'none';
    }
  });

  // Rebuild back-card stubs for opponent seats
  if (dispPos !== 'south') {
    rebuildOppStubs(dispPos, cardDataList.length);
  }
}

function rebuildOppStubs(dispPos, count) {
  // In solo mode, opponent hands are real face-up cards managed by rebuildHandFan
  // called from refreshAllHands — skip stub generation
  if (typeof soloMode !== 'undefined' && soloMode) return;

  // Remove old stubs
  animLayer.querySelectorAll(`[data-stub^="${dispPos}-"]`).forEach(e => e.remove());

  const baseline  = getHandBaseline(dispPos);
  const positions = fanPositions(count, baseline.cx, baseline.baseY, dispPos);

  for (let i = 0; i < count; i++) {
    const el = createCardBack();
    el.dataset.stub = `${dispPos}-${i}`;
    el.style.zIndex = 28 + i;
    el.style.left   = (positions[i].x - CARD_W/2) + 'px';
    el.style.top    = (positions[i].y - CARD_H/2) + 'px';
    el.style.transform = `rotate(${positions[i].rot}deg)`;
    animLayer.appendChild(el);
  }
}

// ── PLAY CARD ANIMATION ───────────────────────────────────────

async function animPlayCard(card, fromDispPos) {
  const key   = cardKey(card);
  const entry = CARD_REGISTRY[key];
  let el      = entry?.el;

  // If no element exists (opponent card), spawn one from their seat
  if (!el) {
    el = createCardEl(card, fromDispPos !== 'south'); // face-down if opponent
    const baseline = getHandBaseline(fromDispPos);
    el.style.left  = (baseline.cx - CARD_W/2) + 'px';
    el.style.top   = (baseline.baseY - CARD_H/2) + 'px';
    el.style.transform = 'rotate(0deg)';
    el.style.zIndex    = 50;
    animLayer.appendChild(el);
    CARD_REGISTRY[key] = { el, cardData: card, dispPos: fromDispPos };
  }

  el.style.pointerEvents = 'none';
  el.style.transition    = '';
  el.style.zIndex        = 60;

  // Target: center of trick slot
  const slot = getTrickSlotRect(fromDispPos);
  const tx   = slot.x + slot.w / 2;
  const ty   = slot.y + slot.h / 2;

  await new Promise(resolve => {
    animMoveTo(el, tx, ty, 0, {
      duration: 340,
      easing: 'cubic-bezier(0.22,1,0.36,1)',
      zIndex: 60,
      onComplete: resolve,
    });
  });

  // Flip face up if it was face down
  if (el.classList.contains('flipped')) {
    await flipCard(el, true, 260);
  }

  el.classList.add('trick-card-anim');
  return el;
}

// ── TRICK SWEEP ANIMATION ─────────────────────────────────────

async function animTrickSweep(winnerDispPos, trickCardKeys) {
  const target   = getHandBaseline(winnerDispPos);
  const promises = [];

  trickCardKeys.forEach((key, i) => {
    const entry = CARD_REGISTRY[key];
    if (!entry) return;
    const el = entry.el;

    el.classList.remove('trick-card-anim');

    // Brief pause then fly to winner
    const p = new Promise(resolve => {
      setTimeout(() => {
        // Flash effect
        el.classList.add('trick-win-flash');
        setTimeout(() => el.classList.remove('trick-win-flash'), 400);

        animMoveTo(el, target.cx + (Math.random()-0.5)*20, target.baseY, 0, {
          duration: 480,
          easing: 'cubic-bezier(0.4,0,0.2,1)',
          zIndex: 55,
          scaleEnd: 0,
          onComplete: () => {
            el.remove();
            delete CARD_REGISTRY[key];
            resolve();
          }
        });
      }, i * 40);
    });
    promises.push(p);
  });

  await Promise.all(promises);
}

// ── PASS CARDS ANIMATION ──────────────────────────────────────

async function animPassCards(cards, fromDispPos, toDispPos) {
  const toBaseline = getHandBaseline(toDispPos);
  const promises   = [];

  cards.forEach((card, i) => {
    const key   = cardKey(card);
    const entry = CARD_REGISTRY[key];
    if (!entry) return;
    const el = entry.el;
    el.style.zIndex = 70 + i;
    el.style.pointerEvents = 'none';

    const p = new Promise(resolve => {
      setTimeout(() => {
        animMoveTo(el, toBaseline.cx + (i-1)*20, toBaseline.baseY, 0, {
          duration: 500,
          easing: 'cubic-bezier(0.22,1,0.36,1)',
          onComplete: () => {
            // Flip face-down as it arrives (partner can't peek)
            flipCard(el, false, 200).then(resolve);
          }
        });
      }, i * 80);
    });
    promises.push(p);
  });

  await Promise.all(promises);
}

// ── DISCARD ANIMATION ─────────────────────────────────────────

async function animDiscardCards(cards, fromDispPos) {
  const tc = tableCenter();
  const promises = [];
  cards.forEach((card, i) => {
    const key   = cardKey(card);
    const entry = CARD_REGISTRY[key];
    if (!entry) return;
    const el = entry.el;
    el.style.zIndex = 65;
    const p = new Promise(resolve => {
      setTimeout(() => {
        animMoveTo(el, tc.x + (Math.random()-0.5)*30, tc.y, (Math.random()-0.5)*30, {
          duration: 380,
          easing: 'ease-in',
          scaleEnd: 0,
          onComplete: () => { el.remove(); delete CARD_REGISTRY[key]; resolve(); }
        });
      }, i * 60);
    });
    promises.push(p);
  });
  await Promise.all(promises);
}

// ── UTILITY ───────────────────────────────────────────────────

function clearAllCards() {
  animLayer.querySelectorAll('.anim-card, .deck-pile').forEach(e => e.remove());
  for (const key in CARD_REGISTRY) delete CARD_REGISTRY[key];
  animLayer.querySelectorAll('[data-stub]').forEach(e => e.remove());
}

function getCardEl(key) {
  return CARD_REGISTRY[key]?.el || null;
}

function removeCardEl(key) {
  const entry = CARD_REGISTRY[key];
  if (entry) { entry.el.remove(); delete CARD_REGISTRY[key]; }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SHUFFLE ANIMATION (before deal) ──────────────────────────

async function animShuffle() {
  const tc = tableCenter();
  const pile = document.createElement('div');
  pile.style.cssText = `position:absolute; left:${tc.x-CARD_W/2}px; top:${tc.y-CARD_H/2}px;
    width:${CARD_W}px; height:${CARD_H}px; z-index:30;`;
  animLayer.appendChild(pile);

  // Create two half-decks
  const makeHalf = () => {
    const h = document.createElement('div');
    h.className = 'anim-card-face anim-card-back';
    h.style.cssText = `position:absolute; inset:0; border-radius:5px;`;
    h.innerHTML = `<div class="ac-back-pattern"></div>`;
    return h;
  };

  for (let r = 0; r < 3; r++) {
    // Left split
    const left  = makeHalf();
    const right = makeHalf();
    pile.innerHTML = '';
    pile.appendChild(left); pile.appendChild(right);

    await new Promise(res => {
      const a1 = left.animate([
        { transform: 'translateX(0) rotate(0deg)' },
        { transform: 'translateX(-20px) rotate(-8deg)' },
        { transform: 'translateX(0) rotate(0deg)' },
      ], { duration: 220, easing: 'ease-in-out', fill: 'forwards' });
      const a2 = right.animate([
        { transform: 'translateX(0) rotate(0deg)' },
        { transform: 'translateX(20px) rotate(8deg)' },
        { transform: 'translateX(0) rotate(0deg)' },
      ], { duration: 220, easing: 'ease-in-out', fill: 'forwards' });
      a1.onfinish = res;
    });
    await wait(60);
  }
  pile.remove();
}

// ── TRUMP REVEAL BURST ────────────────────────────────────────

function animTrumpBurst(suit) {
  const tc     = tableCenter();
  const sym    = SUIT_SYM[suit];
  const isRed  = RED_SUITS.has(suit);
  const burst  = document.createElement('div');
  burst.style.cssText = `
    position:absolute; left:${tc.x}px; top:${tc.y}px;
    font-size:5rem; color:${isRed?'#ff6060':'#f2ead8'};
    transform:translate(-50%,-50%) scale(0);
    pointer-events:none; z-index:80;
    text-shadow: 0 0 40px ${isRed?'rgba(255,80,80,0.8)':'rgba(242,234,216,0.8)'};
    transition: none;
  `;
  burst.textContent = sym;
  animLayer.appendChild(burst);

  burst.animate([
    { transform: 'translate(-50%,-50%) scale(0)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.4)', opacity: 1, offset: 0.4 },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.9, offset: 0.6 },
    { transform: 'translate(-50%,-50%) scale(0.8)', opacity: 0 },
  ], { duration: 900, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' })
    .onfinish = () => burst.remove();
}
