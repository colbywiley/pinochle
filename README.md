# Pinochle Card Room

A 4-player partnership pinochle game with live video chat, built as a static
GitHub Pages app. Play with friends over WebRTC (no server needed), or play
solo against three computer players. Empty multiplayer seats are filled by
the computer, so any number of humans from 1–4 works.

## Features

- **Single-deck modern rules** — 48-card deck, first team to 150
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

| Rule | Detail |
|---|---|
| Deck | 48 cards — two each of A 10 K Q J 9 in every suit |
| Goal | First team to 150 points |
| Bidding | Min bid 25, raise by at least 1, pass = out |
| Stick the dealer | If the other three pass, the dealer must bid 25 |
| Trump | Bid winner names trump and leads the first trick |
| Passing | Bidder's partner passes 3 cards to the bidder; bidder returns 3 |
| Must head | Follow suit and beat the current winning card if able; trump if void; over-trump if able |
| Ties | Of two identical cards, the first one played wins |
| Counters | Each ace, ten and king taken in tricks = 1 point; last trick +1 (25 in play) |
| Making the bid | Bid team scores meld + tricks if they total the bid; otherwise they lose the bid amount |
| No tricks | A team that wins no tricks scores nothing that hand (meld included) |
| Bidder goes out | If both teams cross 150 in the same hand, the bid team wins |

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
