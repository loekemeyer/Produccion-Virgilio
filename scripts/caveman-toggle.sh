#!/bin/bash
# Toggle caveman mode: actualiza config-claude.json y caveman-state.json

CMD="$1"
CONFIG="./config-claude.json"
STATE="./caveman-state.json"

if [[ "$CMD" == "activa" ]]; then
  jq '.caveman = true' "$CONFIG" > /tmp/cfg && mv /tmp/cfg "$CONFIG"
  echo '{"caveman": true, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > "$STATE"
  echo "Caveman ON"
  exit 0
elif [[ "$CMD" == "desactiva" ]]; then
  jq '.caveman = false' "$CONFIG" > /tmp/cfg && mv /tmp/cfg "$CONFIG"
  echo '{"caveman": false, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > "$STATE"
  echo "Caveman OFF"
  exit 0
fi
