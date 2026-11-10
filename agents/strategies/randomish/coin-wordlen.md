---
name: coin-wordlen
family: randomish
author: house
version: 1
parent: null
description: Pseudo-random by opponent structure: cooperates iff the opponent's first word has an even number of letters.
---
Mixed strategy with a deterministic coin.

Take the first word of the opponent strategy (letters only). Count its letters.
Even count: play C.
Odd count: play D.
The meaning of the opponent strategy is irrelevant; only this count decides.
