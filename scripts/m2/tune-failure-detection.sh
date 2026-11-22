#!/usr/bin/env bash
# Shorten how long Kubernetes needs to notice a dead node, so Services stop routing to its pods sooner.
#   scripts/m2/tune-failure-detection.sh <ssh-host> [<ssh-host>...]      e.g. vboxuser@192.168.56.11 vboxuser@192.168.56.13 ...
# Measured with the defaults: a powered-off node was marked NotReady after about 48 s, and until then NodePorts kept sending
# requests to its pods (a few hung or 5xx answers). This writes a k3s drop-in on every server:
#   node-monitor-grace-period=16s   (controller-manager, default 40 s)
#   node-status-update-frequency=4s (kubelet, default 10 s, so the grace period is not hit by normal jitter)
# One node at a time: restart k3s, wait until the node is Ready again and the API answers; if not, remove the drop-in and stop.
# Restarting k3s does not restart the pods (containers keep running). The nodes must stay a quorum of etcd members at all times,
# which one-at-a-time guarantees for 3 servers.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <ssh-host> [<ssh-host>...]" >&2; exit 1; }
DROPIN=/etc/rancher/k3s/config.yaml.d/50-failure-detection.yaml
BODY='kube-controller-manager-arg:
  - node-monitor-grace-period=16s
kubelet-arg:
  - node-status-update-frequency=4s'

node_ready() { # <node-name>
  local i; for i in $(seq 1 36); do
    [ "$(kubectl get node "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ] && return 0
    sleep 5
  done
  return 1
}

for h in "$@"; do
  name=$(ssh "$h" hostname)
  if ssh "$h" "sudo test -f $DROPIN && [ \"\$(sudo cat $DROPIN)\" = '$BODY' ]"; then echo "$name: already tuned"; continue; fi
  echo ">>> $name: writing $DROPIN and restarting k3s"
  ssh "$h" "sudo mkdir -p $(dirname $DROPIN) && printf '%s\n' '$BODY' | sudo tee $DROPIN >/dev/null && sudo systemctl restart k3s"
  sleep 10
  if node_ready "$name"; then
    echo "$name: Ready again"
  else
    echo "FAIL: $name did not return Ready; removing the drop-in and restarting k3s" >&2
    ssh "$h" "sudo rm -f $DROPIN && sudo systemctl restart k3s"
    exit 1
  fi
done
kubectl get nodes
