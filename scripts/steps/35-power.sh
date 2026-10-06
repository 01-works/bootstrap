#!/usr/bin/env bash
# 늘 켜두는 기기 설정: 잠자기 끄기, 네트워크로 깨우기. 원격 접속은 확인만 한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

if [[ "$(pmset -g custom | awk '$1 == "sleep" {print $2; exit}')" == 0 ]]; then
  ok "잠자기 꺼짐"
else
  info "잠자기를 끕니다 (sudo 비밀번호 필요)"
  run sudo pmset -a sleep 0 displaysleep 0 womp 1
  ok "잠자기 꺼짐, 네트워크로 깨우기 켬"
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
