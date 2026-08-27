// ══════════════════════════════════════════
//  meld.js — single-deck meld scoring
// ══════════════════════════════════════════
// A 48-card pinochle deck has TWO copies of every card,
// so a hand can hold doubles of any combination.
//
// Values (25-points-in-play scale, game to 150):
//   Run (A 10 K Q J of trump) ... 15    Double run ........ 150
//   Royal marriage (K+Q trump) ..  4    (extra K+Q beyond a run counts)
//   Marriage (K+Q off suit) .....  2    (each)
//   Pinochle (J♦ + Q♠) ..........  4    Double pinochle ...  30
//   Dix (9 of trump) ............  1    (each)
//   Aces around ................. 10    Double aces ....... 100
//   Kings around ................  8    Double kings ......  80
//   Queens around ...............  6    Double queens .....  60
//   Jacks around ................  4    Double jacks ......  40

const MELD_VALUES = {
  run: 15,        doubleRun: 150,
  royalMarriage: 4,
  marriage: 2,
  pinochle: 4,    doublePinochle: 30,
  dix: 1,
  acesAround: 10,   doubleAces: 100,
  kingsAround: 8,   doubleKings: 80,
  queensAround: 6,  doubleQueens: 60,
  jacksAround: 4,   doubleJacks: 40,
};

function calcMeld(hand, trump) {
  const count = (r, s) => hand.reduce((n, c) => n + (c.r === r && c.s === s ? 1 : 0), 0);
  let score = 0;
  const breakdown = [];
  const add = (label, pts) => { score += pts; breakdown.push([label, pts]); };

  // ── Run in trump (A 10 K Q J) ─────────────
  // runCount = how many complete runs the hand holds (0, 1 or 2)
  const runCount = trump
    ? Math.min(...['A','10','K','Q','J'].map(r => count(r, trump)))
    : 0;
  if (runCount === 2)      add('Double Run', MELD_VALUES.doubleRun);
  else if (runCount === 1) add('Run in Trump', MELD_VALUES.run);

  // ── Marriages ─────────────────────────────
  for (const s of SUITS) {
    let pairs = Math.min(count('K', s), count('Q', s));
    if (s === trump) {
      // K+Q pairs consumed by run(s) don't count again as royal marriages
      pairs -= runCount;
      for (let i = 0; i < pairs; i++) add('Royal Marriage', MELD_VALUES.royalMarriage);
    } else {
      for (let i = 0; i < pairs; i++) add(`Marriage ${SUIT_SYM[s]}`, MELD_VALUES.marriage);
    }
  }

  // ── Pinochle (J♦ + Q♠) ────────────────────
  const pin = Math.min(count('J','D'), count('Q','S'));
  if (pin === 2)      add('Double Pinochle', MELD_VALUES.doublePinochle);
  else if (pin === 1) add('Pinochle', MELD_VALUES.pinochle);

  // ── Arounds (one of each suit) ────────────
  const around = (rank, single, double, label) => {
    const n = Math.min(...SUITS.map(s => count(rank, s)));
    if (n === 2)      add(`Double ${label}`, double);
    else if (n === 1) add(`${label} Around`, single);
  };
  around('A', MELD_VALUES.acesAround,   MELD_VALUES.doubleAces,   'Aces');
  around('K', MELD_VALUES.kingsAround,  MELD_VALUES.doubleKings,  'Kings');
  around('Q', MELD_VALUES.queensAround, MELD_VALUES.doubleQueens, 'Queens');
  around('J', MELD_VALUES.jacksAround,  MELD_VALUES.doubleJacks,  'Jacks');

  // ── Dix (9 of trump, each) ────────────────
  const dix = trump ? count('9', trump) : 0;
  for (let i = 0; i < dix; i++) add('Dix (9 of Trump)', MELD_VALUES.dix);

  return { score, breakdown };
}
