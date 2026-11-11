#!/usr/bin/env bash
# Store the season secret profile in the OutLayer keystore (outlayer-cli):
#   PROTECTED_SEASON_SEED  generated inside the TEE (hex32; nobody sees it)
#   NEARAI_API_KEY         read from the environment at runtime (never echoed)
# bound to SecretAccessor::WasmHash(<hash>) + Predecessor{Whitelist[<contract>]},
# then verified through the public `list_user_secrets` view.
# DRY RUN by default; --execute stores. Re-run after every WASM rebuild: a new
# hash is a new accessor row (and the contract must point at the same profile).
# The secrets OWNER is whoever signs the keystore `store_secrets` tx. Use
# `--owner <contract>` (the default) with the contract's own key so that once
# `seal` deletes the contract's keys nobody can re-store, re-scope or delete
# the profile (attacks/RESULTS.md "secrets-owner"); then point the contract
# at it with `set_secrets({owner, profile})` before sealing.
#
#   NEARAI_API_KEY=... ops/scripts/store-secret.sh --wasm-hash HEX [--profile P] \
#     [--owner ID] [--near-credentials FILE] [--execute]
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

NETWORK=testnet
CONTRACT=osd.baldingsucks7993.testnet
OWNER=""         # default: the contract itself (immutable after seal)
NEAR_CREDS=""    # near-cli key file of OWNER; builds a throwaway OUTLAYER_HOME
KEYSTORE=outlayer.testnet
WASM_HASH=""
PROFILE=""
VERIFY_ONLY=0
OUTLAYER_BIN="${OUTLAYER_BIN:-outlayer}"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

options:
  --wasm-hash HEX   sha256 of the referee WASM (required)
  --profile P       secrets profile (default osd-<first 12 hex of hash>, one per build)
  --contract ID     the only caller allowed ($CONTRACT)
  --owner ID        secrets owner = the signing account (default: --contract)
  --near-credentials FILE
                    near-cli credentials JSON of --owner (e.g. ~/.near-credentials/testnet/<owner>.json);
                    copied into a temporary OUTLAYER_HOME that is deleted on exit.
                    Without it, OUTLAYER_HOME (or ~/.outlayer) must be logged in as --owner.
  --network N       testnet
  --verify-only     only run the read-only verification
  --execute         store the secret

env: NEARAI_API_KEY (required with --execute), OUTLAYER_BIN (default outlayer), OUTLAYER_HOME
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --wasm-hash) WASM_HASH=$2; shift 2 ;;
    --profile) PROFILE=$2; shift 2 ;;
    --contract) CONTRACT=$2; shift 2 ;;
    --owner) OWNER=$2; shift 2 ;;
    --near-credentials) NEAR_CREDS=$2; shift 2 ;;
    --network) NETWORK=$2; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ "$NETWORK" = testnet ] || die "testnet only in this phase"
is_hex64 "$WASM_HASH" || die "--wasm-hash must be 64 lowercase hex"
is_account "$CONTRACT" || die "bad --contract"
OWNER=${OWNER:-$CONTRACT}
is_account "$OWNER" || die "bad --owner"
PROFILE=${PROFILE:-osd-${WASM_HASH:0:12}}
[[ "$PROFILE" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "bad --profile"

verify() {
  log "# verify (read-only view $KEYSTORE::list_user_secrets)"
  (cd "$OPS_DIR" && node --experimental-strip-types --disable-warning=ExperimentalWarning src/cli/verify-secret.ts \
    --network "$NETWORK" --owner "$OWNER" --profile "$PROFILE" --wasm-hash "$WASM_HASH" --contract "$CONTRACT" --keystore "$KEYSTORE")
}

if [ "$VERIFY_ONLY" = 1 ]; then
  verify
  exit $?
fi

banner
log "profile=$PROFILE owner=$OWNER accessor=WasmHash($WASM_HASH) caller=Predecessor[$CONTRACT]"
if [ "$OWNER" = "$CONTRACT" ]; then
  log "owner = contract: after seal() the profile can no longer be changed by anyone (only the OutLayer operator caveat remains)"
else
  log "WARNING: owner $OWNER != contract $CONTRACT: $OWNER can re-store/replace/delete this profile even after seal"
fi

if [ -n "$NEAR_CREDS" ]; then
  [ -f "$NEAR_CREDS" ] || die "no such file: $NEAR_CREDS"
  if [ "$EXECUTE" = 1 ]; then
    OUTLAYER_HOME=$(mktemp -d "${TMPDIR:-/tmp}/osd-outlayer.XXXXXX")
    export OUTLAYER_HOME
    trap 'rm -rf "$OUTLAYER_HOME"' EXIT
    mkdir -p "$OUTLAYER_HOME/$NETWORK"
    (umask 077 && OWNER="$OWNER" KEYSTORE="$KEYSTORE" node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (!j.private_key || !j.public_key) { console.error("credentials file has no key pair"); process.exit(1); }
      process.stdout.write(JSON.stringify({ account_id: process.env.OWNER, public_key: j.public_key,
        private_key: j.private_key, contract_id: process.env.KEYSTORE, auth_type: "near_key" }));
    ' "$NEAR_CREDS" >"$OUTLAYER_HOME/$NETWORK/credentials.json") || die "could not read $NEAR_CREDS"
    log "temporary OUTLAYER_HOME (deleted on exit) signs as $OWNER"
  else
    log "would build a temporary OUTLAYER_HOME from $NEAR_CREDS (signer $OWNER)"
  fi
fi

if [ "$EXECUTE" = 1 ]; then
  need "$OUTLAYER_BIN" "install outlayer-cli: cargo install outlayer-cli (or set OUTLAYER_BIN)"
  CREDS_FILE="${OUTLAYER_HOME:-$HOME/.outlayer}/$NETWORK/credentials.json"
  [ -f "$CREDS_FILE" ] || die "outlayer-cli not logged in: run '$OUTLAYER_BIN login $NETWORK' as $OWNER, or pass --near-credentials"
  SIGNER=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).account_id)' "$CREDS_FILE")
  [ "$SIGNER" = "$OWNER" ] || die "outlayer-cli is logged in as $SIGNER, not --owner $OWNER (the signer becomes the owner)"
  [ -n "${NEARAI_API_KEY:-}" ] || die "NEARAI_API_KEY is not set in the environment"
  [[ "$NEARAI_API_KEY" =~ ^[A-Za-z0-9._:-]+$ ]] || die "NEARAI_API_KEY has unexpected characters; refusing to build JSON from it"
fi

# The CLI only accepts the JSON on argv: it is visible in the process list for
# the few seconds the command runs. Run this on a single-user machine.
SECRETS_JSON=$(printf '{"NEARAI_API_KEY":"%s"}' "${NEARAI_API_KEY:-}")
# --via alone on a new WasmHash row = Predecessor{Whitelist[CONTRACT]} and nothing else
# (same as the spike profile `season1`, verified in check B).
run env OUTLAYER_NETWORK="$NETWORK" "$OUTLAYER_BIN" secrets set "REDACT:$SECRETS_JSON" \
  --profile "$PROFILE" \
  --wasm-hash "$WASM_HASH" \
  --generate PROTECTED_SEASON_SEED:hex32 \
  --via "$CONTRACT"
unset SECRETS_JSON

if [ "$EXECUTE" = 1 ]; then
  # the view reads `final`; the store tx may not be final yet
  for i in 1 2 3 4 5; do
    verify && break
    [ "$i" = 5 ] && die "stored, but list_user_secrets does not show the row yet (re-run with --verify-only)"
    log "  not visible yet (finality), retry $i/4 in 3s"
    sleep 3
  done
else
  show pnpm --filter @osd/ops verify-secret --owner "$OWNER" --profile "$PROFILE" --wasm-hash "$WASM_HASH" --contract "$CONTRACT"
fi
log "point the contract at it (before seal): set_secrets {\"owner\":\"$OWNER\",\"profile\":\"$PROFILE\"} (owner only, 1 yocto)"
log "or for a fresh deploy: deploy.sh --secrets-owner $OWNER --secrets-profile $PROFILE --wasm-hash $WASM_HASH"
