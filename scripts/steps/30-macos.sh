#!/usr/bin/env bash
# macOS 시스템 설정. 기본값과 다르게 쓰는 것만 적용한다.
# 각 항목의 이유는 macos/system-settings.md.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

restart_dock=0

# set_default <domain> <key> <-int|-string|-bool> <value> <설명>
set_default() {
  local domain="$1" key="$2" type="$3" value="$4" label="$5" current expected="$4"
  current="$(defaults read "$domain" "$key" 2>/dev/null || true)"
  if [[ "$type" == -bool ]]; then
    [[ "$value" == true ]] && expected=1 || expected=0
  fi
  if [[ "$current" == "$expected" ]]; then
    ok "$label"
    return
  fi
  run defaults write "$domain" "$key" "$type" "$value"
  ok "$label (변경)"
  [[ "$domain" == com.apple.dock ]] && restart_dock=1
  return 0
}

set_default NSGlobalDomain KeyRepeat -int 2 "키 반복 속도 빠르게"
set_default NSGlobalDomain InitialKeyRepeat -int 15 "키 반복 시작 빠르게"
set_default NSGlobalDomain AppleInterfaceStyle -string Dark "다크 모드 (로그아웃 후 완전히 반영)"
set_default com.apple.dock tilesize -int 42 "Dock 아이콘 크기 42"

# 내장·외장 트랙패드 모두 세 손가락 드래그 사용. 다른 드래그 방식은 끈다.
for domain in com.apple.AppleMultitouchTrackpad com.apple.driver.AppleBluetoothMultitouch.trackpad; do
  set_default "$domain" Dragging -bool false "탭 드래그 끄기 ($domain)"
  set_default "$domain" DragLock -bool false "드래그 잠금 끄기 ($domain)"
  set_default "$domain" TrackpadThreeFingerDrag -bool true "세 손가락 드래그 ($domain, 재로그인 후 확인)"
done

if [[ "$restart_dock" == 1 ]]; then
  run killall Dock
fi
