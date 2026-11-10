#!/usr/bin/env bash
# Build and deploy the WS-8 cards contract (contracts/cards, NEP-245) and init
# new(owner_id, core_contract) in the same transaction. DRY RUN by default; --execute
# signs and sends. Keys come from the near CLI legacy keychain (~/.near-credentials).
#
#   ops/scripts/deploy-cards.sh [--execute]
# The cards account is a sub-account of the core contract account (only that account can
# create it); --parent then funds it for code + card state. The core contract is not touched.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

NETWORK=testnet
PARENT=baldingsucks7993.testnet
CORE=osd.baldingsucks7993.testnet
CARDS=""            # default: cards.$CORE
OWNER=""            # default: PARENT (the keeper; only it can mint)
CREATE_BALANCE="0.05 NEAR"
STATE_KB=50         # card state headroom (~1 KB per card + badge balance)
CARDS_WASM=""
SKIP_BUILD=0
REDEPLOY=0

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

options:
  --parent ID         funds the cards account and is the default owner ($PARENT)
  --core ID           core dilemma contract; creates the cards sub-account ($CORE)
  --cards ID          cards contract account (default cards.<core>)
  --owner ID          minter / owner (default --parent)
  --state-kb N        storage headroom for card state in KB ($STATE_KB)
  --cards-wasm PATH   use this .wasm instead of building
  --skip-build        reuse contracts/cards/target/near/cards_contract.wasm
  --redeploy          deploy over existing code without init (state kept)
  --execute           sign and send
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --parent) PARENT=$2; shift 2 ;;
    --core) CORE=$2; shift 2 ;;
    --cards) CARDS=$2; shift 2 ;;
    --owner) OWNER=$2; shift 2 ;;
    --state-kb) STATE_KB=$2; shift 2 ;;
    --cards-wasm) CARDS_WASM=$2; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --redeploy) REDEPLOY=1; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

CARDS=${CARDS:-cards.$CORE}
OWNER=${OWNER:-$PARENT}
for a in "$PARENT" "$CORE" "$CARDS" "$OWNER"; do is_account "$a" || die "bad account id: $a"; done
[[ "$STATE_KB" =~ ^[0-9]+$ ]] || die "--state-kb must be an integer"

banner
need near "near CLI (near-cli-rs)"
need curl
need node

# 1. wasm
if [ -z "$CARDS_WASM" ]; then
  CARDS_WASM="$REPO_DIR/contracts/cards/target/near/cards_contract.wasm"
  if [ "$SKIP_BUILD" = 0 ]; then
    need cargo-near "cargo install cargo-near"
    log "# 1. build cards contract (near-sdk 5.9, rustc from contracts/cards/rust-toolchain.toml)"
    run bash -c "cd $(printf '%q' "$REPO_DIR/contracts/cards") && cargo near build non-reproducible-wasm --locked"
  fi
fi
if [ -f "$CARDS_WASM" ]; then
  CODE_BYTES=$(wc -c <"$CARDS_WASM" | tr -d ' ')
  log "cards wasm: $CARDS_WASM ($CODE_BYTES bytes) sha256 $(shasum -a 256 "$CARDS_WASM" | cut -d' ' -f1)"
elif [ "$EXECUTE" = 1 ]; then
  die "cards wasm not found: $CARDS_WASM"
else
  CODE_BYTES=260000
  log "cards wasm: $CARDS_WASM (built on --execute; assuming ~$CODE_BYTES bytes)"
fi
# 1 NEAR per 100 KB of storage, plus 0.2 NEAR for gas-free headroom.
BUDGET=$(node -e 'const [b,s]=process.argv.slice(1).map(Number);process.stdout.write(((b/1000+s)/100+0.2).toFixed(2))' "$CODE_BYTES" "$STATE_KB")

# 2. account
log "# 2. cards account $CARDS (storage budget $BUDGET NEAR)"
if account_exists "$NETWORK" "$CARDS"; then
  log "$CARDS exists"
  if [ "$REDEPLOY" = 0 ] && view_json "$NETWORK" "$CARDS" get_config '{}' >/dev/null 2>&1; then
    die "$CARDS already has an initialised contract; pass --redeploy to replace the code (state kept)"
  fi
else
  case "$CARDS" in *".$CORE") ;; *) die "$CARDS must be a sub-account of $CORE" ;; esac
  run near account create-account fund-myself "$CARDS" "$CREATE_BALANCE" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$CORE" network-config "$NETWORK" sign-with-legacy-keychain send
fi
# The budget is the total balance the account should hold (code + state + headroom).
if [ "$EXECUTE" = 1 ]; then
  read -r AMOUNT _USAGE <<<"$(account_state "$NETWORK" "$CARDS")"
else
  AMOUNT=50000000000000000000000
fi
TOPUP=$(node -e 'const [a,b]=process.argv.slice(1);process.stdout.write(Math.max(0,Number(b)-Number(BigInt(a))/1e24).toFixed(2))' "$AMOUNT" "$BUDGET")
if [ "$TOPUP" != "0.00" ]; then
  log "funding $CARDS with $TOPUP NEAR from $PARENT"
  run near tokens "$PARENT" send-near "$CARDS" "$TOPUP NEAR" network-config "$NETWORK" sign-with-legacy-keychain send
fi

# 3. deploy (+ init in the same tx, so nobody can front-run new())
INIT_ARGS=$(printf '{"owner_id":"%s","core_contract":"%s"}' "$OWNER" "$CORE")
if [ "$REDEPLOY" = 1 ] && account_exists "$NETWORK" "$CARDS" && view_json "$NETWORK" "$CARDS" get_config '{}' >/dev/null 2>&1; then
  log "# 3. redeploy code (state kept, no init)"
  run near contract deploy "$CARDS" use-file "$CARDS_WASM" without-init-call \
    network-config "$NETWORK" sign-with-legacy-keychain send
else
  log "# 3. deploy + new($INIT_ARGS)"
  run near contract deploy "$CARDS" use-file "$CARDS_WASM" with-init-call new json-args "$INIT_ARGS" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi

# 4. verify
log "# 4. verify get_config / mt_metadata_contract"
if [ "$EXECUTE" = 1 ]; then
  CFG=$(view_json "$NETWORK" "$CARDS" get_config '{}')
  printf '%s\n' "$CFG"
  CFG="$CFG" OWNER="$OWNER" CORE="$CORE" node -e '
    const c = JSON.parse(process.env.CFG);
    if (c.owner !== process.env.OWNER || c.core_contract !== process.env.CORE) { console.error("MISMATCH"); process.exit(1); }
    console.error("get_config matches (owner, core_contract)");'
  view_json "$NETWORK" "$CARDS" mt_metadata_contract '{}'
  printf '\n'
else
  log "would view $CARDS.get_config and require owner=$OWNER core_contract=$CORE"
fi
log "next: pnpm --filter @osd/ops mint-cards --season <n> --execute"
