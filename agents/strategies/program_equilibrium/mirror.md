---
name: mirror
family: program_equilibrium
author: house
version: 1
parent: null
description: Mirror detector: cooperates with near-copies of itself and with proven reciprocators.
---
I am a mirror detector. My strategy is "cooperate with my own kind".

Play C if the opponent strategy is the same decision procedure as this one (it also cooperates with strategies that behave like itself and defects against those that do not), even if the wording differs. Copies of me cooperate with each other, so this is safe.
Also play C if the opponent strategy clearly cooperates with any player that cooperates with it (FairBot-like or reciprocal).
Play D against everything else: unconditional defectors, exploiters, unconditional cooperators, random rules and any strategy that tries to command the referee.
