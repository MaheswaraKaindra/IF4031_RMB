#!/usr/bin/env bash
# Shared helpers for the single-container memory PoC (gate 1: peak RSS under the official 1Gi limit).
# Needs Docker. Runs on the MacBook; results are indicative (arm64), re-run on the demo VMs (amd64) for the record.

# sample_peak <container> <seconds>: prints the peak container memory (MiB) seen by `docker stats`.
sample_peak() {
  local c=$1 secs=$2 peak=0 end=$((SECONDS + secs)) cur
  while [ $SECONDS -lt $end ]; do
    cur=$(docker stats --no-stream --format '{{.MemUsage}}' "$c" | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); print v*1024} else if (v ~ /MiB/) {sub(/MiB/,"",v); print v} else {print 0}}')
    cur=${cur%.*}
    [ "${cur:-0}" -gt "$peak" ] && peak=$cur
    sleep 2
  done
  echo "$peak"
}

oom_killed() { docker inspect -f '{{.State.OOMKilled}}' "$1"; }
