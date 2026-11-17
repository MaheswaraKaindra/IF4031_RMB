# Topology and RAM budget (D2)

Demo target: **3 VMs** (separate kernels) on the 32 GB PC. Fill the declaration table in the README before the demo.

## Memory budget per component (requests / limits from Appendix B)
| Component | Pods | Request each | Limit each | Σ request | Σ limit |
|---|---|---|---|---|---|
| Store members (12: 6 data, 3 arbiter, 3 config) | 12 | 512Mi | 1Gi | 6144Mi | 12288Mi |
| mongos | 2 | 128Mi | 256Mi | 256Mi | 512Mi |
| Aggregator (>= 3 once Owner B scales) | 3 | 256Mi | 512Mi | 768Mi | 1536Mi |
| RabbitMQ | 1 | 512Mi | 1Gi | 512Mi | 1024Mi |
| client-api, auth-service | 2 | 128Mi | 256Mi | 256Mi | 512Mi |
| consumers | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| mocks | 2 | 64Mi | 128Mi | 128Mi | 256Mi |
| Sensor Pantai | 1 | 128Mi | 256Mi | 128Mi | 256Mi |
| Prometheus, Grafana, Jaeger | 3 | 128Mi | 256Mi | 384Mi | 768Mi |
| **Total (steady state)** | | | | **8960Mi (8.75Gi)** | **17920Mi (17.5Gi)** |

Per node (3 nodes) the average is about 3Gi of requests and 6Gi if every pod hit its limit. Add OS + k3s (about 1Gi per VM; more on the
control-plane node), the Tester Agent (no limits declared by the official manifest), and recovery peaks (initial sync, `store-init`
Job 128Mi). Suggested VM sizing: **8 GB each (24 GB total)** leaves 8 GB for the host. Verify with `kubectl top nodes` / `kubectl top pods`
and the Grafana "memory working set" panel. The k6 load generator runs outside the pods.

The control-plane node (Node A) is also a worker; the Tester Agent only kills non-control-plane nodes in a 2-node cluster. With 3 nodes
the scenarios may hit any node, so the placement above must (and does) tolerate any single node loss.

## Failure domains
Pods on the same VM are not separate failure domains. Slots must map to three **different VMs**; `scripts/k8s/label-nodes.sh` refuses duplicates.

## Declaration template (copy into the README at demo time)
| Node | Role | Kind (VM/native) | Physical host | Host CPU/RAM | VM vCPU/RAM |
|---|---|---|---|---|---|
| node-a | control-plane + worker | VM | _TBD_ | _TBD_ | _TBD_ |
| node-b | worker | VM | _TBD_ | _TBD_ | _TBD_ |
| node-c | worker | VM | _TBD_ | _TBD_ | _TBD_ |
