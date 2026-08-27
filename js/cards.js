// ══════════════════════════════════════════
//  cards.js — deck, shuffle, card helpers
// ══════════════════════════════════════════

// Single-deck pinochle: TWO copies of A 10 K Q J 9 in each suit = 48 cards
const SUITS  = ['S','H','D','C'];          // Spades Hearts Diamonds Clubs
const RANKS  = ['A','10','K','Q','J','9']; // high→low display order
const SUIT_SYM = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_NAME = { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' };
const RED_SUITS = new Set(['H','D']);

// Rank order for trick-taking (higher index wins within suit)
const RANK_ORDER = { '9':0, 'J':1, 'Q':2, 'K':3, '10':4, 'A':5 };

// Counters: aces, tens and kings taken in tricks are worth 1 point each.
// 24 counters + 1 for the last trick = 25 points in play per hand.
const TRICK_PTS = { A:1, '10':1, K:1, Q:0, J:0, '9':0 };
const LAST_TRICK_BONUS = 1;
const POINTS_PER_HAND  = 25;

function makeDeck() {
  const d = [];
  for (let copy = 0; copy < 2; copy++)
    for (const s of SUITS)
      for (const r of RANKS)
        d.push({ r, s, id: r + s + copy });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Stable identity for a specific physical card (both deck copies have distinct ids) */
function cardKey(c) { return c.id || (c.r + c.s); }

/** Same rank + suit (either copy) */
function sameCard(a, b) { return a.r === b.r && a.s === b.s; }

/** Find index of this exact card (by id when available) in a list */
function indexOfCard(list, card) {
  const key = cardKey(card);
  let idx = list.findIndex(c => cardKey(c) === key);
  if (idx === -1) idx = list.findIndex(c => sameCard(c, card)); // fallback: either copy
  return idx;
}

/** Sort hand: suits grouped, within suit by rank desc.
 *  If trump is set, trump suit moves to the right end. */
function sortHand(hand, trump) {
  hand.sort((a, b) => {
    if (trump) {
      const aT = a.s === trump ? 1 : 0;
      const bT = b.s === trump ? 1 : 0;
      if (aT !== bT) return aT - bT;
    }
    if (a.s !== b.s) return SUITS.indexOf(a.s) - SUITS.indexOf(b.s);
    return RANK_ORDER[b.r] - RANK_ORDER[a.r];
  });
}

/** Return all cards from hand that match suit s */
function ofSuit(hand, s) { return hand.filter(c => c.s === s); }

/** Can card `c` beat current winner `best` given trump?
 *  Identical cards: the first one played wins (strict > comparison). */
function beats(c, best, trump) {
  const cT = c.s === trump, bT = best.s === trump;
  if (cT && !bT) return true;
  if (!cT && bT) return false;
  if (c.s !== best.s) return false; // different non-trump suit can't beat
  return RANK_ORDER[c.r] > RANK_ORDER[best.r];
}

/** Given a trick array [{seat,card}], return seat that wins */
function trickWinner(trick, trump) {
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, trick[best].card, trump)) best = i;
  }
  return trick[best].seat;
}

/** Count points in a set of cards */
function countPoints(cards) {
  return cards.reduce((s, c) => s + TRICK_PTS[c.r], 0);
}
