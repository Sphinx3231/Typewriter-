#!/usr/bin/env bash
# Rust coverage of the desktop app: the native crate's tests plus the real app driven by the
# Linux desktop end-to-end test (Xvfb, real X11 key events), merged into one report.
#
#   scripts/native-coverage.sh            # needs cargo-llvm-cov, llvm-tools-preview, and the
#                                         # desktop E2E tools (see e2e-desktop/run.mjs)
#
# The app is built with coverage instrumentation in continuous mode, so counters reach disk
# even when tauri-driver ends the app with a signal. Windows- and macOS-only code isn't
# compiled on Linux and so isn't in this report.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

cargo llvm-cov clean --workspace
eval "$(cargo llvm-cov show-env --sh 2>/dev/null)"
# %c: continuous mode; on Linux it needs runtime counter relocation.
export LLVM_PROFILE_FILE="$CARGO_LLVM_COV_TARGET_DIR/typewriter-%p-%c%4m.profraw"
export __CARGO_LLVM_COV_RUSTC_WRAPPER_RUSTFLAGS="${__CARGO_LLVM_COV_RUSTC_WRAPPER_RUSTFLAGS}"$'\x1f-C\x1fllvm-args=-runtime-counter-relocation'

cargo test --release -p typewriter-native
(cd .. && npx tauri build --no-bundle)
(cd .. && node e2e-desktop/run.mjs "$PWD/src-tauri/target/release/typewriter") || echo "warning: some desktop checks failed (see above)"

cargo llvm-cov report --release --summary-only "$@"
