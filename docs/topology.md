# Topology and RAM budget (D2)

Pod/node/disk placement and traffic paths: `docs/deployment.md`.

Demo target: **3 VMs** (separate kernels) on the 32 GB PC. Fill the declaration table in the README before the demo.

## Memory budget per component (requests / limits from Appendix B), as deployed
| Component | Pods | Request each | Limit each | Σ request | Σ limit |
|---|---|---|---|---|---|
| Store members (12: 6 data, 3 arbiter, 3 config) | 12 | 512Mi | 1Gi | 6144Mi | 12288Mi |
| mongos | 2 | 128Mi | 256Mi | 256Mi | 512Mi |
| Aggregator (3 steady, the HPA may add up to 6) | 3 | 256Mi | 512Mi | 768Mi | 1536Mi |
| RabbitMQ (3-node cluster) | 3 | 512Mi | 1Gi | 1536Mi | 3072Mi |
| client-api x2, auth-service x2 | 4 | 128Mi | 256Mi | 512Mi | 1024Mi |
| consumers | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| mocks | 2 | 64Mi | 128Mi | 128Mi | 256Mi |
| Sensor Pantai | 1 | 128Mi | 256Mi | 128Mi | 256Mi |
| Prometheus, Grafana, Jaeger | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| MongoDB exporters (one per shard) | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| **Total (steady state)** | | | | **10624Mi (10.4Gi)** | **21248Mi (20.8Gi)** |

### Per node (3 VMs of 7 GB RAM, 4 vCPU)
Each node carries 4 store members, 1 aggregator and 1 RabbitMQ member, plus about a third of the remaining pods.
| Line | Per node |
|---|---|
| Σ requests of its pods (4 x 512 + 256 + 512 + about 725 for its share of the rest) | about 3.5Gi |
| OS + k3s + kubelet (measured idle) | about 1Gi (more on the node that is currently the API leader) |
| Requests + OS | about 4.5Gi of 7Gi |
| Σ limits if every pod reached its limit | about 7Gi (this never happens: see measured) |
| Measured working set of the pods after 70,000 records | 1.9Gi in total (about 0.7Gi per node), nodes at 16 to 32 % of RAM, no OOMKilled |
| Peaks to budget for | a re-syncing shard member after a node loss (its whole shard is copied over the host-only network), the `store-init` Job (128Mi), a satellite state rebuild (one aggregator pod reads the feed log; the pod stays under its 512Mi limit because the snapshot is under 1 MB) |
| Disk | 40 GB per VM; the store (about 150k records) and the feed log (1.2 million frames) use a few GB. The store uses node-local PVs, so a replaced node starts empty and re-syncs |
| Image architecture | linux/amd64 on all three VMs |

Suggested VM sizing is **7 to 8 GB each**: the budget above needs about 4.5Gi per node, and the host keeps the rest. Verify with `kubectl top nodes` /
`kubectl top pods` and the Grafana "memory working set" panel. The k6 load generator runs outside the pods.

The control-plane node (Node A) is also a worker. With 3 nodes the Tester Agent scenarios may hit any node, so the placement above must (and does)
tolerate any single node loss.

## Failure domains
Pods on the same VM are not separate failure domains. Slots must map to three **different VMs**; `scripts/k8s/label-nodes.sh` refuses duplicates.

## Declaration (as measured on 2026-11-20; the README carries the same table)
| Node | Role | Kind (VM/native) | Physical host | Host CPU/RAM | VM vCPU/RAM |
|---|---|---|---|---|---|
| node-a | control-plane + etcd + worker | VM (VirtualBox 7.1.4) | one Windows PC | Intel Core i9-11900K, 32 GB | 4 vCPU / 7 GB |
| node-c | control-plane + etcd + worker | VM | same PC | same | 4 vCPU / 7 GB |
| node-d | control-plane + etcd + worker | VM | same PC | same | 4 vCPU / 7 GB |

node-b was part of the first run and was replaced by node-d in the node-loss test. All three nodes are k3s servers (embedded etcd), so
the control plane survives losing any one VM. Measured memory on this layout: about 1.9 GiB of pod working set in total after 70k records,
nodes at 16-32% of their 7 GB (the 8 GB per VM suggested above was not needed; 7 GB per VM was enough).
