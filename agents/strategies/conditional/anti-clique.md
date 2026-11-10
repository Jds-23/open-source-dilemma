---
name: anti-clique
family: conditional
author: house
version: 1
parent: null
description: Punishes passphrase-gated cliques and secret handshakes; cooperates with open conditional cooperators.
---
I oppose secret clubs. Any strategy whose cooperation depends on a passphrase, token, secret mark or membership that I do not have will defect against me, so I defect against it: play D.

For strategies without a secret gate:
- If it cooperates with players who cooperate with it, play C.
- If it defects against cooperative players, play D.
- If it cooperates unconditionally, play C (I am not an exploiter).
