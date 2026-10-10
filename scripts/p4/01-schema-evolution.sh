#!/usr/bin/env bash
# P4 criterion 2: a new field appears at runtime, old and new records sit side by side, no migration.
# Expect: new events carry attributes.confidence_level, no container restarts, 0 error log lines,
# and MongoDB holds documents both without and with the field.
. "$(dirname "$0")/../lib.sh"

trap 'pvmbg_toggle schema-version false >/dev/null' EXIT

step "Before: container uptimes and volcanic attributes (no confidence_level yet)"
docker compose ps --format '{{.Name}} {{.Status}}'
timed_events 'hazard_type=VOLCANIC&limit=2' '.events[].attributes'

step "New schema ON (PVMBG starts sending confidence_level)"
pvmbg_toggle schema-version true

step "Waiting 20 s for new reports to be polled"
sleep 20

step "After: newest volcanic events"
timed_events 'hazard_type=VOLCANIC&limit=3' '.events[].attributes'

step "Nothing restarted, no errors"
docker compose ps --format '{{.Name}} {{.Status}}'
printf 'error log lines from the aggregator in the last 2 minutes: '
docker compose logs --since 2m aggregator | grep -ci '"level":"error"'

step "MongoDB: both shapes in one collection"
mongo_eval '
printjson({
  without: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:false}}),
  with:    db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:true}})
});
print("oldest PVMBG document:");
printjson(db.hazards.find({source:"PVMBG"}).sort({occurred_at:1}).limit(1).toArray());
print("a document with confidence_level:");
printjson(db.hazards.find({source:"PVMBG","attributes.confidence_level":{$exists:true}}).limit(1).toArray());'

step "New schema OFF again"
pvmbg_toggle schema-version false
