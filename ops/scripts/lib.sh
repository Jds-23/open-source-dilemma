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
