#!/usr/bin/env bash
# Runs a test command and keeps its output as a proof: shown live in the terminal (for a screenshot) AND saved to docs/m2/proofs/<id>/<timestamp>.txt
# with a header (date, commit, command, artificial case). Usage:
#   scripts/m2/proof-run.sh <proof-id> <command> [args...]        e.g.  scripts/m2/proof-run.sh 1.1 scripts/m2/p1-report.sh
#   ARTIFICIAL="CPU limit 250m per aggregator pod" scripts/m2/proof-run.sh 2.7 scripts/m2/p2-load.sh
# The exit code of the command is the exit code of this script. Secrets are never printed by the test scripts; do not pass secrets as arguments.
set -uo pipefail
# The tests reach the VMs over SSH and the cluster through a node: give them the same defaults as scripts/m2/proof.sh so this wrapper also works when called directly.
export SSH_USER=${SSH_USER:-vboxuser} NODE_IP=${NODE_IP:-192.168.56.11}
VB='/mnt/c/Program Files/Oracle/VirtualBox/VBoxManage.exe'
export VM_STOP_CMD=${VM_STOP_CMD:-"'$VB' controlvm {node} poweroff"} VM_START_CMD=${VM_START_CMD:-"'$VB' startvm {node} --type headless"} VM_PAUSE_CMD=${VM_PAUSE_CMD:-"'$VB' controlvm {node} pause"} VM_RESUME_CMD=${VM_RESUME_CMD:-"'$VB' controlvm {node} resume"}
ID=${1:?proof id, e.g. 1.1}; shift; [ $# -ge 1 ] || { echo "usage: $0 <proof-id> <command> [args...]" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
dir=docs/m2/proofs/$ID; mkdir -p "$dir"; f=$dir/$(date +%Y%m%d-%H%M%S).txt
dirty=""; [ -n "$(git status --porcelain --untracked-files=no)" ] && dirty=" (uncommitted changes)"
{ echo "# proof: $ID"; echo "# date: $(date -Is)"; echo "# commit: $(git rev-parse --short HEAD)$dirty"; echo "# command: $*"; echo "# artificial case: ${ARTIFICIAL:-none}"; echo; } | tee "$f"
"$@" 2>&1 | tee -a "$f"; rc=${PIPESTATUS[0]}
echo "# exit code: $rc" | tee -a "$f"; echo "# saved: $f"
exit "$rc"
