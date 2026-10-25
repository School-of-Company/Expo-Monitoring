#!/bin/sh
# Demo cache traffic: 9 lookups of an existing key and 1 of a missing key per round (90% hits).
set -eu
until redis-cli -h demo-redis ping >/dev/null 2>&1; do sleep 1; done
redis-cli -h demo-redis set demo:expo:1 cached >/dev/null
while true; do
  for _ in 1 2 3 4 5 6 7 8 9; do redis-cli -h demo-redis get demo:expo:1 >/dev/null; done
  redis-cli -h demo-redis get demo:missing >/dev/null
  sleep 1
done
