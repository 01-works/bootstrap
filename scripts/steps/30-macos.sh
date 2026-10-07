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

# 아직 쓰지 않는 설정. 원하면 주석을 풀고 system-settings.md 표에도 추가할 것.
# set_default NSGlobalDomain AppleShowAllExtensions -bool true "파일 확장자 항상 보기"
# set_default com.apple.finder ShowPathbar -bool true "Finder 경로 막대"
# set_default com.apple.desktopservices DSDontWriteNetworkStores -bool true "네트워크 드라이브에 .DS_Store 안 만들기"
# set_default NSGlobalDomain NSAutomaticSpellingCorrectionEnabled -bool false "자동 맞춤법 수정 끄기"
# set_default com.apple.dock show-recents -bool false "Dock 최근 앱 숨기기"

if [[ "$restart_dock" == 1 ]]; then
  run killall Dock
fi
