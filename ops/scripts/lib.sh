#!/usr/bin/env bash
# Shared helpers for ops/scripts/*.sh. Source it; don't run it.
# shellcheck disable=SC2034  # variables are used by the sourcing scripts

OPS_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$OPS_SCRIPTS_DIR/.." && pwd)"
REPO_DIR="$(cd "$OPS_DIR/.." && pwd)"

EXECUTE=0

log() { printf '%s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing tool: $1${2:+ ($2)}"
}

banner() {
  if [ "$EXECUTE" = 1 ]; then
    log '*** EXECUTE: transactions WILL be signed and sent ***'
  else
    log '--- DRY RUN: nothing is signed or sent (pass --execute to send) ---'
  fi
}

# Print a command, shell-quoted. Arguments wrapped as REDACT:<value> are shown as <redacted>.
show() {
  local out='+' a
  for a in "$@"; do
    case "$a" in
      REDACT:*) out+=" '<redacted>'" ;;
      *) out+=" $(printf '%q' "$a")" ;;
    esac
  done
  log "$out"
}

# run CMD...: print it; run it only with --execute. REDACT:<value> args are unwrapped when run.
run() {
  show "$@"
  [ "$EXECUTE" = 1 ] || return 0
  local args=() a
  for a in "$@"; do
    case "$a" in
      REDACT:*) args+=("${a#REDACT:}") ;;
      *) args+=("$a") ;;
    esac
  done
  "${args[@]}"
}

rpc_url() {
  case "$1" in
    testnet) printf '%s' "${NEAR_RPC_URL:-https://test.rpc.fastnear.com}" ;;
    mainnet) printf '%s' "${NEAR_RPC_URL:-https://free.rpc.fastnear.com}" ;;
    *) die "unknown network $1" ;;
  esac
}

# account_exists NETWORK ACCOUNT → exit 0 if it exists (read-only RPC query).
account_exists() {
  local body
  body=$(printf '{"jsonrpc":"2.0","id":"osd","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"%s"}}' "$2")
  curl -fsS -m 20 -H 'content-type: application/json' -d "$body" "$(rpc_url "$1")" | grep -q '"amount"'
}

# account_state NETWORK ACCOUNT → "<amount yocto> <storage_usage bytes>" (read-only RPC query).
account_state() {
  local body
  body=$(printf '{"jsonrpc":"2.0","id":"osd","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"%s"}}' "$2")
  curl -fsS -m 20 -H 'content-type: application/json' -d "$body" "$(rpc_url "$1")" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;if(!r){process.exit(1)}process.stdout.write(r.amount+" "+r.storage_usage)})'
}

# storage_budget_near MAX_AGENTS SEASONS CODE_KB → NEAR (2 decimals) the contract account should hold for
# its code plus SEASONS seasons of MAX_AGENTS entries (INTERFACE.md §6.1: ~4.3 KB per entry, ~0.7 KB per
# match, N(N-1)/2 matches; 1 NEAR per 100 KB) plus a 1 NEAR margin for gas-free headroom.
storage_budget_near() {
  node -e 'const [n,k,code]=process.argv.slice(1).map(Number);const kb=code+k*(n*4.3+(n*(n-1)/2)*0.7);process.stdout.write((kb/100+1).toFixed(2))' "$1" "$2" "$3"
}

# reserved_yocto NETWORK CONTRACT → yocto the contract holds for OTHER people, which is not free storage balance:
# every agent's budget_yocto (get_agent, agents found via get_entries of every season) plus every season's
# pool_yocto. Conservative: pools already paid out via claim are still counted, so --fund-only may top up a little
# more than strictly needed. Views only; no keys.
reserved_yocto() {
  node -e '
const [rpc, acct] = process.argv.slice(1);
const view = async (m, a) => {
  const r = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "osd", method: "query", params: { request_type: "call_function", finality: "final", account_id: acct, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) })).json();
  if (!r.result || !r.result.result) throw new Error(m + ": " + JSON.stringify(r.error || r.result));
  return JSON.parse(Buffer.from(r.result.result).toString());
};
(async () => {
  let total = 0n; const agents = new Set();
  for (let id = 1; ; id++) {
    const s = await view("get_season", { season_id: id });
    if (!s) break;
    total += BigInt(s.pool_yocto);
    for (let from = 0; ; from += 100) {
      const es = await view("get_entries", { season_id: id, from_index: from, limit: 100 });
      es.forEach((e) => agents.add(e.agent_id));
      if (es.length < 100) break;
    }
  }
  for (const a of agents) { const g = await view("get_agent", { agent_id: a }); if (g) total += BigInt(g.budget_yocto); }
  process.stdout.write(total.toString());
})().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
' "$(rpc_url "$1")" "$2"
}

# view_json NETWORK CONTRACT METHOD ARGS_JSON → decoded JSON result on stdout (read-only).
view_json() {
  local args64 body
  args64=$(printf '%s' "$4" | base64 | tr -d '\n')
  body=$(printf '{"jsonrpc":"2.0","id":"osd","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"%s","method_name":"%s","args_base64":"%s"}}' "$2" "$3" "$args64")
  curl -fsS -m 20 -H 'content-type: application/json' -d "$body" "$(rpc_url "$1")" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.result||!r.result.result){process.stderr.write(JSON.stringify(r.error||r.result)+"\n");process.exit(1)}process.stdout.write(Buffer.from(r.result.result).toString())})'
}

is_hex64() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
is_account() { [[ "$1" =~ ^[a-z0-9_.-]{2,64}$ ]]; }
