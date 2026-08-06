#!/bin/bash
# Toggle caveman mode on/off via /stopcaveman and /playcaveman commands

CLAUDE_MD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CLAUDE.md"
CMD=$(jq -r '.message.content[0].text // empty' 2>/dev/null | head -1)

if [[ "$CMD" =~ ^/stopcaveman ]]; then
  # Remove caveman block (lines 1-6 + blank line 7)
  sed -i.bak '1,/^---$/d' "$CLAUDE_MD" 2>/dev/null || sed -i '' '1,/^---$/d' "$CLAUDE_MD" 2>/dev/null
  echo '{"systemMessage":"Caveman mode OFF ✓","continue":false}'
  exit 0
elif [[ "$CMD" =~ ^/playcaveman ]]; then
  # Add caveman block if not present
  if ! grep -q '^# CAVEMAN MODE' "$CLAUDE_MD"; then
    {
      echo '# CAVEMAN MODE'
      echo 'Respond like caveman. No articles, no filler words, no pleasantries.'
      echo 'Short. Direct. Code speaks for itself.'
      echo 'If asked for code, give code. No explain unless asked.'
      echo 'No sycophancy. No restating question. No sign-offs.'
      echo 'Delete at 17:30 AR today or when user says "borra caveman".'
      echo ''
      echo '---'
      echo ''
    } | cat - "$CLAUDE_MD" > /tmp/claude_tmp && mv /tmp/claude_tmp "$CLAUDE_MD"
  fi
  echo '{"systemMessage":"Caveman mode ON 🔴","continue":false}'
  exit 0
fi
