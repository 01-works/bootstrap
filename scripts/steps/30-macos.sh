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

# 화면 보호기를 쓰지 않는다. 가만히 있으면 전원 설정에 따라 화면이 꺼진다 (power 단계).
if [[ "$(defaults -currentHost read com.apple.screensaver idleTime 2>/dev/null || true)" == 0 ]]; then
  ok "화면 보호기 사용 안 함"
else
  run defaults -currentHost write com.apple.screensaver idleTime -int 0
  ok "화면 보호기 사용 안 함 (변경)"
fi

# 배경화면: 검정 단색. 시스템 기본 "검정"이나 Solid Colors/Black.png면 그대로 둔다.
# 바꿀 때 macOS가 이 터미널의 System Events 제어 허용을 한 번 묻는다 (직접 허용).
wallpaper_is_black() {
  /usr/bin/python3 - "$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist" <<'PY' 2>/dev/null
import plistlib, sys
choice = plistlib.load(open(sys.argv[1], 'rb'))['AllSpacesAndDisplays']['Desktop']['Content']['Choices'][0]
config = plistlib.loads(choice['Configuration']) if choice.get('Configuration') else {}
black = 'black' in config.get('systemColor', {}) or 'Black.png' in repr(config) + repr(choice.get('Files'))
sys.exit(0 if black else 1)
PY
}
if wallpaper_is_black; then
  ok "배경화면 검정"
elif run osascript -e 'tell application "System Events" to tell every desktop to set picture to "/System/Library/Desktop Pictures/Solid Colors/Black.png"'; then
  ok "배경화면 검정 (변경)"
else
  # 제어 허용을 거부했거나 macOS가 바뀐 경우. 다른 설정은 계속한다.
  warn "배경화면을 바꾸지 못했습니다 → 시스템 설정 > 배경화면에서 색상 '검정' 선택"
fi
