#!/usr/bin/env node
// Back-compat shim for the spike: osd-encrypt <pubkey_hex> <agent_id> <prompt...>
import { run } from "../dist/cli.js";

run(["encrypt", ...process.argv.slice(2)]);
