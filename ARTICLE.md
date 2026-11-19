# I asked Claude to invent a protocol for a shared shower. A dumb rule was almost as good.

*Draft. All numbers come from the simulator in this repo (`sim.js`); unless noted, 100 random seeds
per row, water delay L = 5 s, someone arrives or leaves every 45 s, no noise in the felt pressure.*

## The problem

Several showers share one hot-water line. When one person turns their tap, the pressure — and a few
seconds later the temperature — changes for everyone else. Each of them adjusts their own tap, which
changes it for everyone again, and everybody ends up chasing everybody.

The constraints:

- You can't talk.
- Temperature reaches you with a delay of about 5 seconds. Pressure is faster: 0.5 to 5 seconds,
  depending on the plumbing (I call this P).
- People come and go.
- Nobody knows how many others are showering right now, and the right tap setting depends on
  exactly that number (N).

It's a classic delayed-feedback trap; the "shower problem" is a textbook system-dynamics example,
next to Sterman's Beer Game. My question: can the people in the showers agree on some protocol
that makes everyone converge quickly, and also tells everyone N?

## Step 1: Claude invents a protocol

I described the setup to Claude (Opus 5.5, in Claude Code) and asked for a protocol plus a simulator
to test it. The first version, two days before anything else in the repo, already had this shape:

- **Hot tap fixed at a shared mark**; temperature is adjusted with the cold tap only.
- **Signals are sent with pressure**, because it travels faster than temperature. A *blink* means
  closing the hot tap for a short time T.
- **Relay roll call:** a newcomer sends a sync blink, then the people already there answer in turn:
  No. k blinks after hearing No. k−1. Count the blinks and you know N.
- **Jump, then refine:** everyone has a personal table "cold-tap setting for N people", jumps straight
  to it, then applies a Newton-style correction (80 % of the error) every L+1 seconds.
- **Collisions:** a random pause before syncing, and a jam signal (close for 5T) when two syncs merge.

Later I asked which existing protocol it most resembles, and the answer was Ethernet's CSMA/CD: listen before talking, random back-off,
collision detection, jam signal, and eventually binary exponential back-off. The roll call is
essentially the "beeping model" from distributed computing.

There is also an interactive page with sliders and per-stall temperature and pressure graphs:
https://komapc.github.io/shower-protocol/

## Step 2: it was buggy

The first version worked on the happy path. Over the next two days we went through about twenty
commits and nine pull requests, almost all of them fixes. Some of what turned up:

- **The protocol peeked at the simulator.** The jam signal was triggered by reading how many people
  had *actually* sent a sync, information nobody in a shower has. It was rewritten to work from felt
  pressure only.
- **Blinks were too long.** The original blink length was 0.8·P. With slow pressure a blink was
  itself a temperature shock for everyone, and the roll call took forever. Now T = max(0.5 s, 0.2·P).
- **Arriving mid-roll-call spoiled the count.** The roll call now gets discarded and repeated if the
  pressure baseline moved during it.
- **Two people arriving at once.** With slow pressure their sync blinks merged in about 40 % of
  simultaneous arrivals. Originally only the jam signal caught this: wait, jam, repeat, which didn't
  fit before the next arrival. Now people compare the *area* of the pressure dip with a single answer
  (1.5× or more means two syncs) and then draw lots for the duplicate number.
- **Three at once was a hole:** 29–69 % of runs ended with someone holding the wrong N, at every
  pressure speed. Four separate things broke, including the fact that pressure depends non-linearly
  on the number of open taps, so three simultaneous blinks looked like two. After the fixes: 0–7 %.
- **A newcomer could exempt themselves from a check.** Arriving during the answers inflated the area
  ratio into a "double sync", which switched off exactly the check that should have caught them.
- **The metric was lying too.** We checked "does everyone know N" at the moment the next person
  actually left. But leavers wait for silence, so a long roll call also postponed the check.
  Measured at the *planned* time, wrong N for a pair arriving together (P = 3 s, N = 6) was 43 %,
  not 17 %.

After this the relay protocol gives 0 % wrong N for single arrivals (with no perception noise; noise of
a tenth of one blink brings it to 1–2 % with six people), and everyone converges before
the next arrival in every run up to P = 3 s, with a median of 10–28 s. It still fails at slow
pressure with many people: at P = 5 s and N = 6, 32 % of events (arrivals and the departure) don't
converge in time.

## Step 3: compare it with a dumb rule

At some point I asked: is this really such a hard problem? Compare it with a naive approach: everyone
moves toward their correction, by no more than 2–3 % per second, with some randomness to avoid
cycles. The simulator already had two baselines, and both were easy to beat. "Naive" (everyone tweaks their hot tap every second) never converges once
two or more people are showering. "Patient" (hot tap on the mark, small cold-tap moves, waiting out
the water delay between them) takes ~35 s. So I added a third baseline with no signals and no
counting, which is my suggestion turned into code:

> Hot tap on the mark. About once a second (±30 % random jitter), move the cold tap by a small
> fraction of how wrong the temperature feels, at most 3 % of the tap's range. Ignore errors
> under 0.3 °C.

Median convergence (over the events that converged) / share of events, arrivals and the departure,
that didn't converge before the next one:

| | simple nudging | relay protocol |
|---|---|---|
| 2 / 4 / 6 people, fast pressure (P = 0.5 s) | 33 / 32 / 32 s; 0 / 0 / **27 %** | 10 / 15 / 19 s; 0 % |
| 2 / 4 / 6 people, slow pressure (P = 3 s) | same (doesn't use pressure) | 16 / 24 / 28 s; 0 % |
| 6 people, two arrive together, P = 0.5 s | 33 s; 18 % | 18 s; 0 % |
| 4 people, water delay L = 8 / 12 s | 76 / 100 % don't converge | 0 % |
| discomfort, 6 people, P = 3 s (°C·s per person) | **234** | 282 |

In raw simulator numbers the protocol wins: 2–3× faster when pressure is fast, and it survives
crowds and long pipes where the simple rule falls apart. So this is not a "the dumb way was better"
story. It's more of an "it's not clear the clever way was worth it" story, for three reasons.

**1. Its numbers rely on things a person can't know.** The README has a section titled "where the
agents know more than they could". In the simulation, the people take the blink threshold from the
true number of people present, take the slope for the Newton correction from the true state of all
taps, share one identical perception of pressure, and "hear" someone else's sync from the
simulator's state instead of from the felt pressure. The departure roll call is only for show: its
count is thrown away, everyone just subtracts one, and the numbers shift by the leaver's true number.
Counted honestly, it would miss the last blink at every departure once P ≥ 2 s. The parts that work
from honest perception are
the blink counting itself, the double-sync detection, the jam signal and collision detection by
temperature. The rest are assumptions, not results.

**2. Nobody could do it in a shower.** Comparing the areas of pressure dips, telling a merged double
sync from a single one, drawing lots by blinking: this is a protocol for microcontrollers, not for
people with shampoo in their eyes.

**3. When pressure is slow, the speed doesn't buy comfort.** The blinks themselves shake everyone's
temperature, and with six people the simple rule ends up with *less* total discomfort (234 vs 282),
even though it converges more slowly.

Almost all the protocol's complexity goes into one thing, counting N, and the simple rule doesn't
need N at all. Its weak spots are real, though: the safe step size depends on both N and the pipe
delay, which it doesn't know. Nudging more slowly avoids the oscillation with six people, but then
convergence takes ~42 s and only fits if people arrive no more than every 90 s.

I also asked for a middle ground a human could actually follow, simple enough to hang on the wall of
a shared shower room. The result is five lines on the wall plus a clock
("blink your stall number × S seconds after the pressure jumps"). It counts N exactly (0 % wrong N,
still 0 % with perception noise of a tenth of a blink),
but with slow pressure the roll call over all six stalls takes long; at P = 2 s it only keeps up if
people arrive no more often than every 90 seconds.

## What I took from it

- Claude produced a **plausible, well-structured design** fast, and it independently landed on the
  same ideas as Ethernet.
- It was much worse at noticing **what the design silently assumed**. Several bugs were the protocol
  or the measurement quietly using information nobody has, and one of the worst was in the metric,
  not the protocol.
- What kept this honest was **a simulator, a dumb baseline, and a list of the assumptions** the
  simulator makes. Without the baseline I'd have a beautiful protocol and no idea whether it was
  worth the trouble.

Code, simulator and an English summary: https://github.com/komapc/shower-protocol (the full write-up is in Russian).

