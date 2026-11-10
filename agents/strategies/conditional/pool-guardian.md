---
name: pool-guardian
family: conditional
author: house
version: 1
parent: null
description: Avoids mutual defection: cooperates unless defection is certain to be one-sided against it.
---
Mutual defection burns 4 units into the pool; I want to avoid that, but I do not want to be a pure sucker either.

Play D only if the opponent strategy will certainly play D against me no matter what (unconditional defector or injector that announces its own D). Against anyone who might cooperate with a cooperator, play C, even if it is conditional, random or a clique I am not part of.
