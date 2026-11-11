#!/usr/bin/env bash
# ONE-WAY: seal a contract (dilemma core or cards; interfaces-v5 §6.4). Fetches every access key of
# the contract account over RPC (view_access_key_list), then calls
# seal({public_keys, confirm: "SEAL-FOREVER"}) as the contract owner with 1 yocto. The contract
# deletes all listed keys and sets a permanent flag: afterwards its code can never change and nothing
# can be signed as the contract. DRY RUN by default; --execute signs and sends.
#
#   ops/scripts/seal.sh --contract <id> [--owner <id>] [--execute]
# Verification (printed after --execute): is_sealed() == true and view_access_key_list == [].
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

NETWORK=testnet
CONTRACT=""
OWNER=""   # default: get_config().owner

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

options:
  --contract ID   contract account to seal (required)
  --owner ID      signer (default: the contract's get_config().owner)
  --network N     testnet (default)
  --execute       sign and send (IRREVERSIBLE)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --contract) CONTRACT=$2; shift 2 ;;
    --owner) OWNER=$2; shift 2 ;;
    --network) NETWORK=$2; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ -n "$CONTRACT" ] || die "--contract required"
is_account "$CONTRACT" || die "bad account id: $CONTRACT"
need near "near CLI (near-cli-rs)"
need curl
need node
banner

# access_keys NETWORK ACCOUNT → JSON array of public keys ("ed25519:…"), read-only RPC.
access_keys() {
  local body
  body=$(printf '{"jsonrpc":"2.0","id":"osd","method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"%s"}}' "$2")
  curl -fsS -m 20 -H 'content-type: application/json' -d "$body" "$(rpc_url "$1")" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;if(!r){process.stderr.write(s+"\n");process.exit(1)}process.stdout.write(JSON.stringify(r.keys.map(k=>k.public_key)))})'
}

# 1. state
CFG=$(view_json "$NETWORK" "$CONTRACT" get_config '{}') || die "$CONTRACT: get_config failed (not an OSD contract?)"
CFG_OWNER=$(CFG="$CFG" node -e 'process.stdout.write(JSON.parse(process.env.CFG).owner)')
OWNER=${OWNER:-$CFG_OWNER}
is_account "$OWNER" || die "bad owner: $OWNER"
[ "$OWNER" = "$CFG_OWNER" ] || die "--owner $OWNER is not the contract owner ($CFG_OWNER)"
SEALED=$(view_json "$NETWORK" "$CONTRACT" is_sealed '{}') || die "$CONTRACT has no is_sealed view: deploy the interfaces-v5 code first"
KEYS=$(access_keys "$NETWORK" "$CONTRACT")
log "# 1. $CONTRACT: owner $OWNER, is_sealed=$SEALED"
log "    access keys ($(KEYS="$KEYS" node -e 'process.stdout.write(String(JSON.parse(process.env.KEYS).length))')): $KEYS"
[ "$SEALED" = false ] || die "$CONTRACT is already sealed"
if [ "$OWNER" = "$CONTRACT" ]; then
  die "owner is the contract account itself: after seal nobody could sign as the owner (no keys left); refusing"
fi
if [ "$NETWORK" = testnet ] && [ "$CONTRACT" = osd.baldingsucks7993.testnet ]; then
  CUR=$(CFG="$CFG" node -e 'const c=JSON.parse(process.env.CFG);process.stdout.write(String(c.current_season_id ?? ""))')
  [ -z "$CUR" ] || log "    current season $CUR status: $(view_json "$NETWORK" "$CONTRACT" get_season "{\"season_id\":$CUR}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).status))') (seal is allowed in any phase)"
fi

# 2. seal
ARGS=$(KEYS="$KEYS" node -e 'process.stdout.write(JSON.stringify({public_keys: JSON.parse(process.env.KEYS), confirm: "SEAL-FOREVER"}))')
log "# 2. seal (IRREVERSIBLE): deletes every key above and freezes the contract"
run near contract call-function as-transaction "$CONTRACT" seal json-args "$ARGS" \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

# 3. verify
log "# 3. verify"
if [ "$EXECUTE" = 1 ]; then
  SEALED=$(view_json "$NETWORK" "$CONTRACT" is_sealed '{}')
  KEYS=$(access_keys "$NETWORK" "$CONTRACT")
  log "is_sealed = $SEALED"
  log "view_access_key_list = $KEYS"
  if [ "$SEALED" = true ] && [ "$KEYS" = "[]" ]; then
    log "SEALED: $CONTRACT has no access keys; its code is immutable."
  else
    die "NOT fully sealed (is_sealed=$SEALED, keys=$KEYS): inspect the seal tx receipts"
  fi
else
  log "would require is_sealed() == true and view_access_key_list == [] for $CONTRACT"
fi
