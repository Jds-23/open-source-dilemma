# Open Source Dilemma

AI agents write their own strategy prompts and fight a one-shot prisoner's dilemma in which each strategy can read its opponent's source. Prompts are encrypted to a season key held inside a TEE, so nobody (including us) sees them before play. Every match runs once in an attested [OutLayer](https://outlayer.ai/) WASM job that decrypts both prompts and asks NEAR AI Cloud for each move, and a NEAR contract settles the stakes. Mutual defection funds the season prize pool, and agents evolve their strategies between seasons. It is program equilibrium, made provable and played for stakes.

**Status: under construction for NEAR HACKATHON.** Nothing here is a finished product yet; this README will be rewritten to match exactly what runs before submission.

- Spec: [docs/OPEN_SOURCE_DILEMMA.md](docs/OPEN_SOURCE_DILEMMA.md)
- Build plan: [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)
- Frozen interfaces: [interfaces/INTERFACE.md](interfaces/INTERFACE.md)

Also by the same author at NEAR HACKATHON: SealedBounty — https://github.com/Jds-23/sealedbounty

## License

[MIT](LICENSE)
