#!/bin/sh
# Demo database traffic: 3 index lookups and 1 sequential scan per round.
set -eu
export PGPASSWORD=demo
until pg_isready -h demo-postgres -U postgres -d expo_demo >/dev/null 2>&1; do sleep 1; done
while true; do
  psql -h demo-postgres -U postgres -d expo_demo -qAt \
    -c "SELECT count(*) FROM survey_answer WHERE expo_id = 7" \
    -c "SELECT count(*) FROM survey_answer WHERE expo_id = 8" \
    -c "SELECT count(*) FROM survey_answer WHERE expo_id = 9" \
    -c "SELECT name FROM expo_code WHERE code = 'C42'" >/dev/null
  sleep 1
done
