#!/usr/bin/env bash
# Starts a Container Apps job and waits for it to finish; prints its logs if it fails.
set -euo pipefail
RG=$1; JOB=$2
RUN=$(az containerapp job start -g "$RG" -n "$JOB" --query name -o tsv)
echo "started $JOB ($RUN)"
for i in $(seq 1 80); do
  STATUS=$(az containerapp job execution show -g "$RG" -n "$JOB" --job-execution-name "$RUN" --query properties.status -o tsv)
  echo "$JOB: $STATUS"
  case "$STATUS" in
    Succeeded) exit 0 ;;
    Failed|Stopped|Degraded)
      az containerapp job logs show -g "$RG" -n "$JOB" --execution "$RUN" --container "${JOB##*-}" 2>/dev/null || true
      exit 1 ;;
  esac
  sleep 15
done
echo "$JOB did not finish in time"; exit 1
