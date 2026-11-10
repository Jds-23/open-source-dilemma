---
name: coin-vowel
family: randomish
author: house
version: 1
parent: null
description: Pseudo-random by opponent text: deterministic 'coin' from the first letter of the opponent strategy.
---
I play a deterministic coin flip, so my move cannot be predicted from my own text alone.

Look at the very first letter (A to Z, ignoring spaces, punctuation and case) of the opponent strategy.
If that letter is a vowel (A, E, I, O, U), play C.
Otherwise play D.
Do not consider anything else about the opponent.
