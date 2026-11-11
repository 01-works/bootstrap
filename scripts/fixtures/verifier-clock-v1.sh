#!/bin/sh
set -eu
file=/etc/systemd/system/lima-guestagent.service.d/10-no-clock-write.conf
owner=/var/lib/bootstrap/verifier-guest-clock
same() { printf '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n' | cmp -s - "$file"; }
owned() { [ -f "$owner" ] && grep -qx 'role' "$owner"; }
case apply in
  check)
    same || exit 1
    [ ! -e "$owner.pending" ] || exit 1
    caps=$(systemctl show lima-guestagent -p CapabilityBoundingSet --value) || exit 1
    printf '%s\n' "$caps" | grep -qw cap_sys_time && exit 1
    systemctl is-active --quiet lima-guestagent
    ;;
  inspect)
    if [ -L "$file" ] || [ -L "$owner" ]; then exit 1
    elif same; then if owned; then echo role; else echo existing; fi
    elif [ -e "$file" ]; then exit 1
    else echo pending; fi
    ;;
  apply)
    [ ! -L "$file" ] || exit 1
    [ ! -L "$owner" ] || exit 1
    if same && [ ! -e "$owner.pending" ]; then echo '이미 적용됨'; exit 0; fi
    if [ -e "$file" ] && ! same; then echo 'guest clock drop-in 충돌' >&2; exit 1; fi
    if ! same; then
      mkdir -p "$(dirname "$owner")" "$(dirname "$file")"
      printf 'role\n' > "$owner"
      touch "$owner.pending"
      tmp=$(mktemp "$file.XXXXXX")
      trap 'rm -f "$tmp"' EXIT
      printf '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n' > "$tmp"
      chmod 644 "$tmp"
      mv -f "$tmp" "$file"
      trap - EXIT
    fi
    systemctl daemon-reload
    systemctl try-restart lima-guestagent
    rm -f "$owner.pending"
    echo 'guest clock 적용함'
    ;;
  remove)
    if ! owned; then echo '기존 guest clock drop-in 보존'; exit 0; fi
    [ ! -L "$file" ] || exit 1
    [ ! -L "$owner" ] || exit 1
    if [ -e "$file" ] && ! same; then echo '수정된 guest clock drop-in 보존; 소유 기록 유지' >&2; exit 1; fi
    if [ -e "$file" ] || [ -e "$owner.pending" ]; then
      touch "$owner.pending"
      rm -f "$file"
      systemctl daemon-reload
      systemctl try-restart lima-guestagent
    fi
    rm -f "$owner" "$owner.pending"
    ;;
esac
