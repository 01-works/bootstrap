#!/usr/bin/env bash
# 전원 설정. 노트북은 충전 중에만 잠들지 않게 하고(배터리 설정은 그대로), 데스크톱은 늘 켜둔다.
# 데스크톱은 원격으로 붙는 기기이므로 원격 접속도 확인한다. 노트북인지는 배터리 유무로 판단한다 (lib.sh).
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if is_laptop; then
  if power_ok; then
    ok "충전 중에는 잠자기 안 함 (노트북)"
  else
    info "충전 중에는 잠들지 않게 합니다 (sudo 비밀번호 필요). 배터리 설정은 그대로입니다"
    run sudo pmset -c sleep 0
    ok "충전 중에는 잠자기 안 함 (노트북)"
  fi
  exit 0
fi

if power_ok; then
  ok "잠자기·화면 잠자기 꺼짐, 네트워크로 깨우기 켬"
else
  info "전원 설정을 바꿉니다 (sudo 비밀번호 필요)"
  run sudo pmset -a sleep 0 displaysleep 0 womp 1
  ok "잠자기·화면 잠자기 끔, 네트워크로 깨우기 켬"
fi

# 원격 로그인/화면 공유는 최신 macOS에서 명령어로 켜기 까다로워 시스템 설정에서 직접 켠다.
disabled="$(launchctl print-disabled system 2>/dev/null || true)"
for svc in com.openssh.sshd:원격\ 로그인 com.apple.screensharing:화면\ 공유; do
  label="${svc#*:}"
  if grep -q "\"${svc%%:*}\" => enabled" <<<"$disabled"; then
    ok "$label"
  else
    warn "$label 꺼짐 → 시스템 설정 > 일반 > 공유에서 켜기"
  fi
done
