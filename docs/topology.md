# Topology and RAM budget (D2)

Pod/node/disk placement and traffic paths: `docs/deployment.md`.

Demo target: **3 VMs** (separate kernels) on the 32 GB PC. Fill the declaration table in the README before the demo.

## Memory budget per component (requests / limits from Appendix B)
| Component | Pods | Request each | Limit each | Σ request | Σ limit |
|---|---|---|---|---|---|
| Store members (12: 6 data, 3 arbiter, 3 config) | 12 | 512Mi | 1Gi | 6144Mi | 12288Mi |
| mongos | 2 | 128Mi | 256Mi | 256Mi | 512Mi |
| Aggregator (>= 3 once Owner B scales) | 3 | 256Mi | 512Mi | 768Mi | 1536Mi |
| RabbitMQ | 1 | 512Mi | 1Gi | 512Mi | 1024Mi |
| client-api ×2, auth-service ×2 | 4 | 128Mi | 256Mi | 512Mi | 1024Mi |
| consumers | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| mocks | 2 | 64Mi | 128Mi | 128Mi | 256Mi |
| Sensor Pantai | 1 | 128Mi | 256Mi | 128Mi | 256Mi |
| Prometheus, Grafana, Jaeger | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| **Total (steady state)** | | | | **9216Mi (9Gi)** | **18432Mi (18Gi)** |

Per node (3 nodes) the average is about 3Gi of requests and 6Gi if every pod hit its limit. Add OS + k3s (about 1Gi per VM; more on the
control-plane node), the Tester Agent (no limits declared by the official manifest), and recovery peaks (initial sync, `store-init`
Job 128Mi). Suggested VM sizing: **8 GB each (24 GB total)** leaves 8 GB for the host. Verify with `kubectl top nodes` / `kubectl top pods`
and the Grafana "memory working set" panel. The k6 load generator runs outside the pods.

The control-plane node (Node A) is also a worker; the Tester Agent only kills non-control-plane nodes in a 2-node cluster. With 3 nodes
the scenarios may hit any node, so the placement above must (and does) tolerate any single node loss.

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
