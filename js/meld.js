// ══════════════════════════════════════════
//  meld.js — single-deck meld scoring
// ══════════════════════════════════════════
// Single deck means each card appears once,
// so max of 1 of each card per hand.

function calcMeld(hand, trump) {
  const has  = (r, s) => hand.some(c => c.r === r && c.s === s);
  let score  = 0;
  const breakdown = [];

  // ── Pinochle ──────────────────────────────
  if (has('J','D') && has('Q','S')) {
    score += 40; breakdown.push(['Pinochle', 40]);
  }

  // ── Run (A-10-K-Q-J in trump) ─────────────
  const runCards = ['A','10','K','Q','J'];
  const hasRun = runCards.every(r => has(r, trump));
  if (hasRun) {
    score += 150; breakdown.push(['Run (Trump)', 150]);
  }

  // ── Marriages ─────────────────────────────
  for (const s of SUITS) {
    if (has('K', s) && has('Q', s)) {
      if (s === trump) {
        if (!hasRun) { // royal marriage — don't double-count if run
          score += 40; breakdown.push(['Royal Marriage (Trump)', 40]);
        }
      } else {
        score += 20; breakdown.push([`Marriage (${SUIT_SYM[s]})`, 20]);
      }
    }
  }

  // ── Aces Around ───────────────────────────
  if (SUITS.every(s => has('A', s))) {
    score += 100; breakdown.push(['Aces Around', 100]);
  }
  // ── Kings Around ──────────────────────────
  if (SUITS.every(s => has('K', s))) {
    score += 80; breakdown.push(['Kings Around', 80]);
  }
  // ── Queens Around ─────────────────────────
  if (SUITS.every(s => has('Q', s))) {
    score += 60; breakdown.push(['Queens Around', 60]);
  }
  // ── Jacks Around ──────────────────────────
  if (SUITS.every(s => has('J', s))) {
    score += 40; breakdown.push(['Jacks Around', 40]);
  }

  // ── Dix (9 of trump) ─────────────────────
  if (has('9', trump)) {
    score += 10; breakdown.push(['Dix (9 of Trump)', 10]);
  }

  return { score, breakdown };
}
