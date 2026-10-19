#!/usr/bin/env bash
# 전원 설정. 노트북은 충전 중에만 잠들지 않게 하고(배터리 설정은 그대로), 데스크톱은 늘 켜두되 화면은 가만히 있으면 끈다.
# 데스크톱은 정전 뒤 스스로 켜지게 하고 원격 접속을 확인한다. 자동 로그인은 비밀번호를 물으므로 마지막 auth 단계에서 한다.
# 노트북인지는 배터리 유무로 판단한다 (lib.sh, macos/system-settings.md#원격-접속).
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
  ok "잠자기 꺼짐, 화면 ${DISPLAY_SLEEP_MINUTES}분 뒤 끔, 네트워크로 깨우기·정전 후 자동 켜기"
else
  info "전원 설정을 바꿉니다 (sudo 비밀번호 필요)"
  run sudo pmset -a sleep 0 displaysleep "$DISPLAY_SLEEP_MINUTES" womp 1 autorestart 1
  ok "잠자기 끔, 화면 ${DISPLAY_SLEEP_MINUTES}분 뒤 끔, 네트워크로 깨우기·정전 후 자동 켜기"
fi

# 원격 로그인/화면 공유는 최신 macOS에서 명령어로 켜기 까다로워 시스템 설정에서 직접 켠다.
for svc in com.openssh.sshd:원격\ 로그인 com.apple.screensharing:화면\ 공유; do
  label="${svc#*:}"
  if sharing_enabled "${svc%%:*}"; then
    ok "$label"
  else
    warn "$label 꺼짐 → 시스템 설정 > 일반 > 공유에서 켜기"
  fi
done
