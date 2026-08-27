# Pinochle Card Room

A 4-player partnership pinochle game with live video chat, built as a static
GitHub Pages app. Play with friends over WebRTC (no server needed), or play
solo against three computer players. Empty multiplayer seats are filled by
the computer, so any number of humans from 1–4 works.

## Features

- **Single-deck modern rules** — 48-card deck, first team to 150
- **Customizable house rules** — goal, minimum bid, stick-the-dealer,
  pass 0/3/4 cards, **peek vs no-peek** passing, must-head / must-trump /
  follow-suit play, last-trick bonus, and whether trickless meld scores.
  The host sets them in the lobby; they're remembered for next time.
- **Computer players** — practice solo, or let CPUs fill empty seats
  (a CPU also takes over if someone disconnects mid-game)
- **Live video chat** — WebRTC peer-to-peer mesh, no server needed
- **Partners** — NS vs EW; the host sits South, the second player joins as
  the host's partner
- **Animated table** — dealt cards, trick sweeps, card passing

## Hosting on GitHub Pages

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch → main → / (root)**
4. Live at `https://YOUR-USERNAME.github.io/pinochle/`

## How to Play

1. One player clicks **Create Game** — share the room code or invite link
2. Others enter the code and **Join**
3. Host clicks **Deal the Cards & Start Game** (CPUs fill empty seats)
4. Allow camera/mic when prompted

Or click **Play vs Computer** for an instant solo game.

## Rules

Defaults shown; ⚙ marks settings the host can change in **House Rules**.

| Rule | Default |
|---|---|
| Deck | 48 cards — two each of A 10 K Q J 9 in every suit |
| Goal ⚙ | First team to 150 points (100 / 150 / 200 / 300) |
| Bidding ⚙ | Min bid 25 (20 / 25 / 30), raise by at least 1, pass = out |
| Stick the dealer ⚙ | If the other three pass, the dealer must bid the minimum — or off: four passes throw the hand in |
| Trump | Bid winner names trump and leads the first trick |
| Passing ⚙ | Bidder's partner passes 3 cards to the bidder; bidder returns 3 (or 4 cards, or no passing) |
| Peek ⚙ | Peek: bidder sees the passed cards before returning · No peek: bidder must choose the return cards first |
| Play rules ⚙ | Must head: follow suit and beat the winner if able, trump when void, over-trump if able · or must-trump only · or follow-suit only |
| Ties | Of two identical cards, the first one played wins |
| Counters ⚙ | Each ace, ten and king taken in tricks = 1 point; last trick +1 or +2 |
| Making the bid | Bid team scores meld + tricks if they total the bid; otherwise they lose the bid amount |
| No tricks ⚙ | A team that wins no tricks scores nothing that hand — or allow meld to count anyway |
| Bidder goes out | If both teams cross the goal in the same hand, the bid team wins |

### Meld

| Meld | Points | Double |
|---|---|---|
| Run in trump (A 10 K Q J) | 15 | 150 |
| Royal marriage (K+Q of trump) | 4 | 8 |
| Marriage (K+Q off suit) | 2 | each |
| Pinochle (J♦ + Q♠) | 4 | 30 |
| Aces around | 10 | 100 |
| Kings around | 8 | 80 |
| Queens around | 6 | 60 |
| Jacks around | 4 | 40 |
| Dix (9 of trump) | 1 | each |

## Development

The app is plain HTML/CSS/JS with no build step. Tests run under Node:

```sh
node tests/sim.test.mjs 1000   # rules engine + 1000 full bot-vs-bot games
node tests/e2e.test.mjs        # browser end-to-end (needs global playwright)
```
