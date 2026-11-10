#!/usr/bin/env bash
# Store the season secret profile in the OutLayer keystore (outlayer-cli):
#   PROTECTED_SEASON_SEED  generated inside the TEE (hex32; nobody sees it)
#   NEARAI_API_KEY         read from the environment at runtime (never echoed)
# bound to SecretAccessor::WasmHash(<hash>) + Predecessor{Whitelist[<contract>]},
# then verified through the public `list_user_secrets` view.
# DRY RUN by default; --execute stores. Re-run after every WASM rebuild: a new
# hash is a new accessor row (and the contract must point at the same profile).
#
#   NEARAI_API_KEY=... ops/scripts/store-secret.sh --wasm-hash HEX [--profile P] [--execute]
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

NETWORK=testnet
CONTRACT=osd.baldingsucks7993.testnet
OWNER=baldingsucks7993.testnet   # the account `outlayer login testnet` was done with
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
  --owner ID        secrets owner = outlayer-cli login account ($OWNER)
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

if [ "$EXECUTE" = 1 ]; then
  need "$OUTLAYER_BIN" "install outlayer-cli: cargo install outlayer-cli (or set OUTLAYER_BIN)"
  [ -f "${OUTLAYER_HOME:-$HOME/.outlayer}/$NETWORK/credentials.json" ] || die "outlayer-cli not logged in: run '$OUTLAYER_BIN login $NETWORK' as $OWNER"
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
  verify
else
  show pnpm --filter @osd/ops verify-secret --owner "$OWNER" --profile "$PROFILE" --wasm-hash "$WASM_HASH" --contract "$CONTRACT"
fi
log "deploy.sh needs: --secrets-owner $OWNER --secrets-profile $PROFILE --wasm-hash $WASM_HASH"
