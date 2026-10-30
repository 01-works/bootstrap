#!/bin/bash
# Shared machine FIFO for heavy work (agreed with supervisor 433220c0, 2026-10-28).
# usage:
#   cc-yw-heavy.sh enqueue <TASK_ID> <worker-desc> <supervisorAgentId>
#   cc-yw-heavy.sh acquire <TASK_ID> <worker-desc> <supervisorAgentId>   # blocks until first line is ours and exec lock is free
#   cc-yw-heavy.sh release <TASK_ID>                                       # removes exec lock (if ours) and our queue line
# Inside the acquired section, normal repo commands still take the official scripts/heavy-machine-lock.mjs lock.
set -u
Q=/tmp/yw-heavy-queue
EL=/tmp/yw-heavy-queue.edit.lock
XL=/tmp/yw-heavy-check.lock
cmd=$1; id=$2

edit_lock() {
  until mkdir "$EL" 2>/dev/null; do sleep 2; done
  printf '{"pid":%s,"task":"%s"}\n' "$$" "$id" > "$EL/owner.txt"
}
edit_unlock() {
  if grep -q "\"task\":\"$id\"" "$EL/owner.txt" 2>/dev/null; then rm -f "$EL/owner.txt"; rmdir "$EL"; fi
}
first_line() { grep -v '^[[:space:]]*$' "$Q" 2>/dev/null | head -1; }

case "$cmd" in
  enqueue)
    worker=$3; sup=$4
    # per-supervisor cap: at most 2 queue lines (rule 2026-10-30)
    while [ "$(grep -v '^[[:space:]]*$' "$Q" 2>/dev/null | grep -v "^$id " | grep -c "supervisor=$sup")" -ge 2 ]; do sleep 30; done
    edit_lock
    touch "$Q"
    if ! grep -q "^$id " "$Q"; then
      tmp=$(mktemp /tmp/yw-heavy-queue.tmp.XXXXXX)
      grep -v '^[[:space:]]*$' "$Q" > "$tmp"
      printf '%s worker=%s supervisor=%s\n' "$id" "$worker" "$sup" >> "$tmp"
      chmod 600 "$tmp"; mv "$tmp" "$Q"
    fi
    edit_unlock
    echo "enqueued $id"
    ;;
  acquire)
    worker=$3; sup=$4
    "$0" enqueue "$id" "$worker" "$sup" >/dev/null
    while true; do
      if [ "$(first_line | cut -d' ' -f1)" = "$id" ] && mkdir "$XL" 2>/dev/null; then
        printf '{"pid":%s,"startedAt":"%s","supervisor":"%s","task":"%s","worker":"%s","cwd":"%s"}\n' \
          "$PPID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sup" "$id" "$worker" "$PWD" > "$XL/owner.txt"
        if [ "$(first_line | cut -d' ' -f1)" = "$id" ]; then echo "ACQUIRED $id"; exit 0; fi
        rm -f "$XL/owner.txt"; rmdir "$XL"
      fi
      sleep 30
    done
    ;;
  release)
    if grep -q "\"task\":\"$id\"" "$XL/owner.txt" 2>/dev/null; then rm -f "$XL/owner.txt"; rmdir "$XL"; fi
    edit_lock
    tmp=$(mktemp /tmp/yw-heavy-queue.tmp.XXXXXX)
    grep -v '^[[:space:]]*$' "$Q" | grep -v "^$id " > "$tmp"
    chmod 600 "$tmp"; mv "$tmp" "$Q"
    edit_unlock
    echo "released $id"
    ;;
  *) echo "unknown command"; exit 2 ;;
esac
