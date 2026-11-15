# Wording suggestions from kimi-k2.6

11 patterns: 5 new suggestions passed the checks, 6 unchanged, 0 rejected by the checks.

Checks: placeholders kept, fixed numbers kept, no alarm words, no jargon, not much longer. A person still reviews every suggestion before it goes into site/js.

## game.faster  (passed checks)
*Commander mode 'What happened': player's trucks reached the 5 worst fire areas faster than the computer's coverage plan*

- Now: Your trucks reached the worst fires faster than the computer's plan ({mine} against {plan} on average).
- Suggested: Your trucks got to the worst fires faster than the computer's plan ({mine} against {plan} on average).
- Why: Simpler words

## game.same  (passed checks)
*Commander mode 'What happened': about as fast as the computer's plan*

- Now: Your trucks reached the worst fires about as fast as the computer's plan ({mine} against {plan} on average).
- Suggested: Your trucks got to the worst fires about as fast as the computer's plan ({mine} against {plan} on average).
- Why: Simpler words

## game.slower  (passed checks)
*Commander mode 'What happened': slower than the computer's plan*

- Now: Your trucks took longer to reach the worst fires than the computer's plan ({mine} against {plan} on average).
- Suggested: Your trucks took longer to get to the worst fires than the computer's plan ({mine} against {plan} on average).
- Why: Simpler words

## game.worst.near  (unchanged)
*Commander mode: the worst fire area had a truck within 20 km*

- Now: The worst fire area, with {n} hotspots, was only {km} from a truck.
- Suggested: The worst fire area, with {n} hotspots, was only {km} from a truck.
- Why: Already clear

## game.worst.far  (unchanged)
*Commander mode: the worst fire area had no truck within 20 km*

- Now: The worst fire area, with {n} hotspots, had no truck nearby: the nearest was {km} away.
- Suggested: The worst fire area, with {n} hotspots, had no truck nearby: the nearest was {km} away.
- Why: Already clear

## game.far.one  (unchanged)
*Commander mode: one other fire area had no truck within 20 km, so a truck came from further*

- Now: Fire area {areas} had no truck nearby, so a truck came from {kms} away.
- Suggested: Fire area {areas} had no truck nearby, so a truck came from {kms} away.
- Why: Already clear

## game.far.many  (unchanged)
*Commander mode: several fire areas had no truck within 20 km; {areas} is like '4 and 5', {kms} like '37 km and 24 km'*

- Now: Fire areas {areas} had no truck nearby, so trucks came from {kms} away.
- Suggested: Fire areas {areas} had no truck nearby, so trucks came from {kms} away.
- Why: Already clear

## game.cover  (passed checks)
*Commander mode: share of all hotspots within 20 km of a truck*

- Now: Your trucks were within 20 km of {pct} out of every 100 hotspots (the computer's plan: {planpct}).
- Suggested: Your trucks were within 20 km of {pct} out of 100 hotspots (computer plan: {planpct}).
- Why: Shorter and clearer

## game.tip.far  (passed checks)
*Commander mode tip, when some fire area needed a long trip*

- Now: Tip: place a truck closer to fire area {rank}, the longest trip.
- Suggested: Tip: put a truck closer to fire area {rank}, the longest trip.
- Why: Simpler verb

## game.tip.spread  (unchanged)
*Commander mode tip, when trucks covered clearly fewer hotspots than the computer's plan*

- Now: Tip: spread your trucks out a little to cover more of the smaller fires.
- Suggested: Tip: spread your trucks out a little to cover more of the smaller fires.
- Why: Already clear

## game.well  (unchanged)
*Commander mode, when every worst fire area had a truck within 20 km*

- Now: Well placed: every worst fire area had a truck nearby.
- Suggested: Well placed: every worst fire area had a truck nearby.
- Why: Already clear
