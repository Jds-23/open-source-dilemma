#!/usr/bin/env bash
# Reproducible build of wasm/referee (wasm32-wasip2) in a digest-pinned
# container. Same script locally and in .github/workflows/wasm-release.yml, so
# the CI hash can be re-derived on any machine with Docker. The CI-built hash
# is the one pinned at the P2 freeze (contract WasmUrl hash + secret WasmHash).
#
#   ops/scripts/build-wasm.sh [OUT_DIR]      (default ops/dist)
#
# Writes OUT_DIR/referee-wasm.wasm, .sha256 and build-info.json.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
. "$(dirname "$0")/lib.sh"

# rustc 1.96.0 to match wasm/referee/rust-toolchain.toml. Bump both together.
IMAGE="${OSD_WASM_IMAGE:-docker.io/library/rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950}"
PLATFORM="${OSD_WASM_PLATFORM:-linux/amd64}"
OUT="${1:-$OPS_DIR/dist}"
SRC="$REPO_DIR/wasm/referee"

need docker
[ -f "$SRC/Cargo.lock" ] || die "no $SRC/Cargo.lock (needed for --locked)"
grep -q 'channel = "1.96.0"' "$SRC/rust-toolchain.toml" || die "wasm/referee/rust-toolchain.toml is not 1.96.0; update IMAGE in $0 to match"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

log "image:    $IMAGE ($PLATFORM)"
log "source:   $SRC"
log "out:      $OUT"

# Fixed in-container paths (/build, /cargo) keep embedded paths identical
# across machines; sources are copied from a read-only mount so the host tree
# (and any host target/ dir) never leaks in.
docker run --rm --platform "$PLATFORM" \
  -v "$SRC:/src:ro" -v "$OUT:/out" \
  -e CARGO_HOME=/cargo -e CARGO_TERM_COLOR=never -e SOURCE_DATE_EPOCH=0 \
  -e CARGO_INCREMENTAL=0 \
  -w /build "$IMAGE" bash -euo pipefail -c '
    tar -C /src --exclude=./target -cf - . | tar -xf -
    rustup target add wasm32-wasip2 >/dev/null
    rustc --version > /out/rustc.txt
    cargo --version >> /out/rustc.txt
    cargo build --locked --release --target wasm32-wasip2
    cp target/wasm32-wasip2/release/referee-wasm.wasm /out/referee-wasm.wasm
    chown "$(stat -c %u:%g /out)" /out/referee-wasm.wasm /out/rustc.txt
  '

if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$OUT/referee-wasm.wasm" | cut -d' ' -f1)
else
  HASH=$(shasum -a 256 "$OUT/referee-wasm.wasm" | cut -d' ' -f1)
fi
SIZE=$(wc -c <"$OUT/referee-wasm.wasm" | tr -d ' ')
COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
DIRTY=$(git -C "$REPO_DIR" status --porcelain -- wasm/referee 2>/dev/null | head -c1 | wc -c | tr -d ' ')
printf '%s  referee-wasm.wasm\n' "$HASH" >"$OUT/referee-wasm.wasm.sha256"
cat >"$OUT/build-info.json" <<EOF
{
  "artifact": "referee-wasm.wasm",
  "sha256": "$HASH",
  "size": $SIZE,
  "image": "$IMAGE",
  "platform": "$PLATFORM",
  "toolchain": "$(tr '\n' ';' <"$OUT/rustc.txt")",
  "git_commit": "$COMMIT",
  "wasm_referee_dirty": $([ "$DIRTY" = 0 ] && echo false || echo true)
}
EOF
log "sha256:   $HASH ($SIZE bytes)"
printf '%s\n' "$HASH"
