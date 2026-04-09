// ══════════════════════════════════════════
//  cards.js — deck, shuffle, card helpers
// ══════════════════════════════════════════

// Single deck: A 10 K Q J 9 in each of 4 suits (48 cards)
const SUITS  = ['S','H','D','C'];          // Spades Hearts Diamonds Clubs
const RANKS  = ['A','10','K','Q','J','9']; // high→low display order
const SUIT_SYM = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_NAME = { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' };
const RED_SUITS = new Set(['H','D']);

// Rank order for trick-taking (higher index wins within suit)
const RANK_ORDER = { '9':0, 'J':1, 'Q':2, 'K':3, '10':4, 'A':5 };

// Point values for counting (60 total in single deck + last trick = 61)
const TRICK_PTS = { A:11, '10':10, K:4, Q:3, J:2, '9':0 };

function makeDeck() {
  const d = [];
  for (const s of SUITS)
    for (const r of RANKS)
      d.push({ r, s, id: r + s + '_' + Math.random().toString(36).slice(2,6) });
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

function cardKey(c) { return c.id || (c.r + c.s); }

function sameCard(a, b) { return a.r === b.r && a.s === b.s; }

/** Sort hand: suits grouped, within suit by rank desc */
function sortHand(hand) {
  hand.sort((a, b) => {
    if (a.s !== b.s) return SUITS.indexOf(a.s) - SUITS.indexOf(b.s);
    return RANK_ORDER[b.r] - RANK_ORDER[a.r];
  });
}

/** Return all cards from hand that match suit s */
function ofSuit(hand, s) { return hand.filter(c => c.s === s); }

/** Can card `c` beat current winner `best` given trump? */
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
