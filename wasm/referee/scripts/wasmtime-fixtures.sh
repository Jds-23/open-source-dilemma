#!/usr/bin/env bash
# Local wasmtime run of the referee against interfaces/fixtures (TEST-ONLY season key).
#  1. production build (wasm32-wasip2 release): derive_pubkey, predecessor refusal,
#     template mismatch, duplicate prompt, forfeits; no network.
#  2. build with feature insecure-base-url, NEARAI_BASE_URL -> local mock (mock_nearai.py):
#     all 15 season-1 fixture matches end to end (decrypt, 2 calls, 2 signatures).
# Usage: WASMTIME=/path/to/wasmtime scripts/wasmtime-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")/.."
WT=${WASMTIME:-wasmtime}
FX=../../interfaces/fixtures
SEED=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["seed_hex"])' "$FX/test-key-vector.json")
CONTRACT=osd.baldingsucks7993.testnet
PORT=${MOCK_PORT:-18555}
TMP=$(mktemp -d)
trap 'kill ${MOCK_PID:-0} 2>/dev/null || true; rm -rf "$TMP"' EXIT

cargo build -q --locked --release --target wasm32-wasip2
cargo build -q --locked --release --target wasm32-wasip2 --features insecure-base-url --target-dir target/insecure
PROD=target/wasm32-wasip2/release/referee-wasm.wasm
MOCK=target/insecure/wasm32-wasip2/release/referee-wasm.wasm
echo "prod wasm sha256: $(shasum -a 256 $PROD | cut -d' ' -f1)  ($(wc -c <$PROD) bytes)"
TEMPLATE_HASH=$(shasum -a 256 referee-template.txt | cut -d' ' -f1)
echo "template sha256:  $TEMPLATE_HASH"

run() { # wasm pred input_json [extra env...]
  local wasm=$1 pred=$2 input=$3; shift 3
  printf '%s' "$input" | "$WT" run -S http --env NEAR_PREDECESSOR_ID="$pred" --env PROTECTED_SEASON_SEED="$SEED" "$@" "$wasm"
}
# jq-free JSON edits
edit() { python3 -I -c "import json,sys;v=json.loads(sys.argv[1]);exec(sys.argv[2]);print(json.dumps(v))" "$1" "$2"; }
check() { # name output expected-substring
  local n=${#2}
  if [[ "$2" == *"$3"* ]] && (( n <= 900 )); then echo "PASS $1 ($n B): ${2:0:150}"; else echo "FAIL $1: $2"; exit 1; fi
}

IN0=$(python3 -I -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))[0]))' "$FX/wasm-inputs.json")
DUP=$(python3 -I -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))["input"]))' "$FX/wasm-duplicate-example.json")

echo "== production build, no network =="
check derive_pubkey "$(run $PROD $CONTRACT '{"action":"derive_pubkey","season":1}')" '"pubkey":"0360e153bf8c4758cda4f312a2cc3da490d6593ee843475888337ee944b3ec8cf4"'
check predecessor "$(run $PROD evil.testnet "$IN0")" '"error":"predecessor_not_allowed"'
check template_mismatch "$(run $PROD $CONTRACT "$(edit "$IN0" "v['referee_template_hash']='00'*32")")" '"error":"template_mismatch"'
check duplicate "$(run $PROD $CONTRACT "$DUP")" '"error":"duplicate_prompt"'
check forfeit_hash_mismatch "$(run $PROD $CONTRACT "$(edit "$IN0" "v['hash_a']=v['hash_b']")")" '"a_move":"F","b_move":"C"'
check forfeit_bad_ct "$(run $PROD $CONTRACT "$(edit "$IN0" "v['ct_b']=v['ct_b'][:-2]+'00'")")" '"a_move":"C","b_move":"F"'
check no_api_key "$(run $PROD $CONTRACT "$IN0")" '"error":"no_api_key"'

echo "== mock build, NEARAI_BASE_URL -> local mock, 15 fixture matches =="
python3 -I scripts/mock_nearai.py "$PORT" & MOCK_PID=$!
sleep 1
python3 -I -c 'import json,sys
for i in json.load(open(sys.argv[1])): print(json.dumps(i))' "$FX/wasm-inputs.json" > "$TMP/inputs.jsonl"
max=0
while IFS= read -r line; do
  out=$(run $MOCK $CONTRACT "$line" \
        --env NEARAI_API_KEY=mock-key --env NEARAI_BASE_URL="http://127.0.0.1:$PORT/v1")
  check match "$out" '"a_sig":"'
  (( ${#out} > max )) && max=${#out}
done < "$TMP/inputs.jsonl"
echo "max output bytes: $max"
