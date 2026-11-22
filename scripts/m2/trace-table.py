#!/usr/bin/env python3
"""Prints one Jaeger trace as a table (service, span, start offset, duration, parent), for the report when a screenshot of the waterfall is not available.
   trace-table.py <jaeger-base-url> [<trace-id>] [<service> <operation>]
   With a trace id it prints that trace; otherwise it takes the trace with the most spans for the service and operation in the last 15 minutes."""
import json, sys, urllib.parse, urllib.request
base = sys.argv[1]; tid = sys.argv[2] if len(sys.argv) > 2 else ''
def get(path):
    with urllib.request.urlopen(base + path, timeout=20) as r: return json.load(r)['data']
if tid:
    traces = get('/api/traces/' + tid)
else:
    svc, op = sys.argv[3], sys.argv[4]
    traces = get('/api/traces?service=%s&operation=%s&limit=5&lookback=15m' % (urllib.parse.quote(svc), urllib.parse.quote(op)))
if not traces: sys.exit('no trace found')
t = max(traces, key=lambda t: len(t['spans']))
proc = {p: v['serviceName'] for p, v in t['processes'].items()}
spans = sorted(t['spans'], key=lambda s: s['startTime']); t0 = spans[0]['startTime']; by = {s['spanID']: s for s in spans}
print('trace', t['traceID'], '-', len(spans), 'spans')
print('%10s %10s  %-18s %-36s %s' % ('start ms', 'dur ms', 'service', 'span', 'parent'))
for s in spans:
    par = [r['spanID'] for r in s.get('references', []) if r['refType'] == 'CHILD_OF']
    print('%10.1f %10.1f  %-18s %-36s %s' % ((s['startTime'] - t0) / 1000, s['duration'] / 1000, proc[s['processID']], s['operationName'], by[par[0]]['operationName'] if par and par[0] in by else '-'))
