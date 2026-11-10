#!/usr/bin/env bash
# Build the dilemma contract, create its account, deploy, init `new(...)`, and
# check get_config. DRY RUN by default (prints every command, reads chain state
# only); --execute signs and sends. Keys come from the near CLI legacy keychain
# (~/.near-credentials); nothing secret is read from or written to the repo.
#
#   ops/scripts/deploy.sh --wasm-url URL --wasm-hash HEX --secrets-profile P --nearai-signer HEX [--execute]
# The contract account pays for all storage: it is funded for the code plus --seasons seasons of
# --max-agents entries (40 agents ≈ 7.2 NEAR per season), and topped up on an existing account.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

NETWORK=testnet
PARENT=baldingsucks7993.testnet
CONTRACT=osd.baldingsucks7993.testnet
OWNER=""            # default: PARENT (owner opens seasons; the keeper signs as it)
INITIAL_BALANCE=""  # default: storage budget (code + SEASONS × MAX_AGENTS season), see storage_budget_near
MAX_AGENTS=40
SEASONS=1
CODE_KB=350         # cargo near build output is ~343 KB
WASM_URL=""
WASM_HASH=""
SECRETS_OWNER=""    # default: PARENT (the account that ran store-secret.sh)
SECRETS_PROFILE=""
NEARAI_SIGNER="${NEARAI_SIGNER_PUBKEY:-}"
OUTLAYER_ACCOUNT=outlayer.testnet
CONTRACT_WASM=""    # default: build contracts/dilemma
SKIP_BUILD=0
REDEPLOY=0
FUND_ONLY=0

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

options:
  --network N            testnet (default)
  --parent ID            account that creates + funds the contract account ($PARENT)
  --contract ID          contract account ($CONTRACT)
  --owner ID             init caller = contract owner (default: --parent)
  --initial-balance AMT  NEAR moved to a new contract account (default: the storage budget below)
  --max-agents N         storage budget: entries per season ($MAX_AGENTS; ~4.3 KB/entry + ~0.7 KB/match)
  --seasons K            storage budget: seasons to cover ($SEASONS; state of past seasons is kept)
  --wasm-url URL         FastFS URL of the referee WASM (fastfs-upload output)
  --wasm-hash HEX        sha256 of the referee WASM (CI wasm-release artifact)
  --secrets-owner ID     OutLayer secrets owner (default: --parent)
  --secrets-profile P    OutLayer secrets profile (store-secret.sh output)
  --nearai-signer HEX    NEAR AI ed25519 signer pubkey, 64 hex (or env NEARAI_SIGNER_PUBKEY)
  --outlayer-account ID  ($OUTLAYER_ACCOUNT)
  --contract-wasm PATH   use this contract .wasm instead of building
  --skip-build           reuse contracts/dilemma/target/near/*.wasm
  --redeploy             allow deploying over existing code (state is kept; init is skipped if already initialised)
  --execute              sign and send
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK=$2; shift 2 ;;
    --parent) PARENT=$2; shift 2 ;;
    --contract) CONTRACT=$2; shift 2 ;;
    --owner) OWNER=$2; shift 2 ;;
    --initial-balance) INITIAL_BALANCE=$2; shift 2 ;;
    --max-agents) MAX_AGENTS=$2; shift 2 ;;
    --seasons) SEASONS=$2; shift 2 ;;
    --wasm-url) WASM_URL=$2; shift 2 ;;
    --wasm-hash) WASM_HASH=$2; shift 2 ;;
    --secrets-owner) SECRETS_OWNER=$2; shift 2 ;;
    --secrets-profile) SECRETS_PROFILE=$2; shift 2 ;;
    --nearai-signer) NEARAI_SIGNER=$2; shift 2 ;;
    --outlayer-account) OUTLAYER_ACCOUNT=$2; shift 2 ;;
    --contract-wasm) CONTRACT_WASM=$2; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --redeploy) REDEPLOY=1; shift ;;
    --fund-only) FUND_ONLY=1; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

OWNER=${OWNER:-$PARENT}
SECRETS_OWNER=${SECRETS_OWNER:-$PARENT}
[ "$NETWORK" = testnet ] || die "testnet only in this phase"
for a in "$PARENT" "$CONTRACT" "$OWNER" "$SECRETS_OWNER" "$OUTLAYER_ACCOUNT"; do is_account "$a" || die "bad account id: $a"; done
case "$CONTRACT" in *".$PARENT") ;; *) die "$CONTRACT must be a sub-account of $PARENT" ;; esac
if [ "$FUND_ONLY" = 0 ]; then
  is_hex64 "$WASM_HASH" || die "--wasm-hash must be 64 lowercase hex (CI wasm-release sha256)"
  [[ "$WASM_URL" =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "--wasm-url must be an https URL without quotes/spaces"
  case "$WASM_URL" in *"$WASM_HASH"*) ;; *) log "warn: --wasm-url does not contain --wasm-hash; double-check the pair" ;; esac
  [[ "$SECRETS_PROFILE" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "--secrets-profile required ([A-Za-z0-9_-])"
  is_hex64 "$NEARAI_SIGNER" || die "--nearai-signer (or NEARAI_SIGNER_PUBKEY) must be 64 lowercase hex"
fi

if ! [[ "$MAX_AGENTS" =~ ^[0-9]+$ ]] || [ "$MAX_AGENTS" -lt 2 ] || [ "$MAX_AGENTS" -gt 40 ]; then die "--max-agents must be 2..40"; fi
[[ "$SEASONS" =~ ^[1-9][0-9]*$ ]] || die "--seasons must be a positive integer"

banner
need near "near CLI (near-cli-rs)"
need curl
need node

# 1. contract wasm
if [ "$FUND_ONLY" = 1 ]; then
  log "# 1. --fund-only: no build"
elif [ -z "$CONTRACT_WASM" ]; then
  CONTRACT_WASM="$REPO_DIR/contracts/dilemma/target/near/dilemma_contract.wasm"
  if [ "$SKIP_BUILD" = 0 ]; then
    need cargo-near "cargo install cargo-near"
    log "# 1. build contract (near-sdk 5.9, rustc from contracts/dilemma/rust-toolchain.toml)"
    run bash -c "cd $(printf '%q' "$REPO_DIR/contracts/dilemma") && cargo near build non-reproducible-wasm --locked"
  fi
fi
if [ "$FUND_ONLY" = 1 ]; then
  :
elif [ -f "$CONTRACT_WASM" ]; then
  log "contract wasm: $CONTRACT_WASM sha256 $(shasum -a 256 "$CONTRACT_WASM" | cut -d' ' -f1)"
elif [ "$EXECUTE" = 1 ]; then
  die "contract wasm not found: $CONTRACT_WASM"
else
  log "contract wasm: $CONTRACT_WASM (built on --execute)"
fi

# 2. account (+ storage budget: the contract pays for every entry and match it stores)
BUDGET=$(storage_budget_near "$MAX_AGENTS" "$SEASONS" "$CODE_KB")
INITIAL_BALANCE=${INITIAL_BALANCE:-"$BUDGET NEAR"}
log "# 2. contract account (storage budget for code + $SEASONS season(s) x $MAX_AGENTS agents: $BUDGET NEAR)"
if account_exists "$NETWORK" "$CONTRACT"; then
  log "$CONTRACT exists"
  if [ "$FUND_ONLY" = 0 ] && [ "$REDEPLOY" = 0 ] && view_json "$NETWORK" "$CONTRACT" get_config '{}' >/dev/null 2>&1; then
    die "$CONTRACT already has an initialised contract; pass --redeploy to replace the code (state kept, init skipped), or --fund-only to top up storage"
  fi
  read -r AMOUNT USAGE <<<"$(account_state "$NETWORK" "$CONTRACT")"
  # NEAR still free for new state = balance - current usage x 1e19 yocto/byte; top up to the season budget.
  TOPUP=$(node -e 'const [a,u,n,k]=process.argv.slice(1);const free=Number(BigInt(a)-BigInt(u)*10n**19n)/1e24;const need=Number(k)*(Number(n)*4.3+(Number(n)*(Number(n)-1)/2)*0.7)/100+1;process.stdout.write(Math.max(0,need-free).toFixed(2))' "$AMOUNT" "$USAGE" "$MAX_AGENTS" "$SEASONS")
  if [ "$TOPUP" != "0.00" ]; then
    log "storage: $CONTRACT is short by $TOPUP NEAR for $SEASONS more season(s) of $MAX_AGENTS agents; topping up"
    run near tokens "$PARENT" send-near "$CONTRACT" "$TOPUP NEAR" network-config "$NETWORK" sign-with-legacy-keychain send
  else
    log "storage: $CONTRACT has enough free balance for $SEASONS season(s) of $MAX_AGENTS agents"
  fi
  if [ "$FUND_ONLY" = 1 ]; then
    log "--fund-only: storage checked/topped up; not touching code"
    exit 0
  fi
else
  run near account create-account fund-myself "$CONTRACT" "$INITIAL_BALANCE" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$PARENT" network-config "$NETWORK" sign-with-legacy-keychain send
fi

# 3. deploy (no init here: init is signed by OWNER so OWNER becomes `owner`)
log "# 3. deploy"
run near contract deploy "$CONTRACT" use-file "$CONTRACT_WASM" without-init-call \
  network-config "$NETWORK" sign-with-legacy-keychain send

# 4. init
INIT_ARGS=$(printf '{"wasm_url":"%s","wasm_hash":"%s","secrets_owner":"%s","secrets_profile":"%s","nearai_signer":"%s","outlayer_account":"%s"}' \
  "$WASM_URL" "$WASM_HASH" "$SECRETS_OWNER" "$SECRETS_PROFILE" "$NEARAI_SIGNER" "$OUTLAYER_ACCOUNT")
log "# 4. init new(...) as $OWNER"
if [ "$EXECUTE" = 1 ] && view_json "$NETWORK" "$CONTRACT" get_config '{}' >/dev/null 2>&1; then
  log "already initialised (redeploy): skipping new()"
else
  run near contract call-function as-transaction "$CONTRACT" new json-args "$INIT_ARGS" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
fi

# 5. verify
log "# 5. verify get_config"
if [ "$EXECUTE" = 1 ]; then
  CFG=$(view_json "$NETWORK" "$CONTRACT" get_config '{}')
  printf '%s\n' "$CFG"
  CFG="$CFG" EXP="$INIT_ARGS" OWNER="$OWNER" node -e '
    const c = JSON.parse(process.env.CFG), e = JSON.parse(process.env.EXP);
    const bad = Object.keys(e).filter((k) => c[k] !== e[k]);
    if (c.owner !== process.env.OWNER) bad.push("owner");
    if (bad.length) { console.error("MISMATCH: " + bad.join(", ")); process.exit(1); }
    console.error("get_config matches (owner, wasm_url, wasm_hash, secrets, signer, outlayer)");'
else
  log "would view $CONTRACT.get_config and require owner=$OWNER plus the init args above"
fi
log "next: pnpm --filter @osd/ops keeper --open <params.json> --execute"
