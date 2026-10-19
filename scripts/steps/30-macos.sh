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
set_default com.apple.dock show-recents -bool false "Dock 최근 사용한 앱 숨기기"

# 내장·외장 트랙패드 모두 세 손가락 드래그 사용. 다른 드래그 방식은 끈다.
for domain in com.apple.AppleMultitouchTrackpad com.apple.driver.AppleBluetoothMultitouch.trackpad; do
  set_default "$domain" Dragging -bool false "탭 드래그 끄기 ($domain)"
  set_default "$domain" DragLock -bool false "드래그 잠금 끄기 ($domain)"
  set_default "$domain" TrackpadThreeFingerDrag -bool true "세 손가락 드래그 ($domain, 재로그인 후 확인)"
done

# Dock 고정 항목: 처음 한 번만 저장소 구성으로 맞춘다. 이후 직접 바꾼 Dock은 그대로 두고, 없는 앱은 건너뛴다.
# 노트북은 에이전트 앱까지, 늘 켜두는 데스크톱은 기본 앱만 둔다. Chrome Beta는 고정하지 않는다
# (Dock에서 새로 띄우면 에이전트 전용 프로필이 아닌 창이 열린다).
dock_apps=(/System/Applications/Apps.app "/Applications/Google Chrome.app")
if is_laptop; then
  dock_apps+=(/Applications/Claude.app /Applications/ChatGPT.app /Applications/Paseo.app)
fi
dock_apps+=(/System/Applications/Utilities/Terminal.app "/System/Applications/System Settings.app")
dock_tile() {  # dock_tile <경로> [directory]
  local url="file://${1// /%20}/"
  if [[ "${2:-}" == directory ]]; then
    printf '<dict><key>tile-data</key><dict><key>arrangement</key><integer>2</integer><key>displayas</key><integer>0</integer><key>file-data</key><dict><key>_CFURLString</key><string>%s</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-type</key><integer>2</integer><key>showas</key><integer>1</integer></dict><key>tile-type</key><string>directory-tile</string></dict>' "$url"
  else
    printf '<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>%s</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>' "$url"
  fi
}
dock_marker="$BOOTSTRAP_STATE/dock-applied"
if [[ -e "$dock_marker" ]]; then
  ok "Dock 고정 항목 (처음 한 번 적용, 이후 변경은 유지)"
else
  tiles=()
  names=''
  for app in "${dock_apps[@]}"; do
    if [[ -d "$app" ]]; then
      tiles+=("$(dock_tile "$app")")
      names="$names $(basename "$app" .app)"
    else
      info "Dock: 없는 앱은 건너뜀 ($app)"
    fi
  done
  if [[ "$DRY_RUN" == 1 ]]; then
    info "[dry-run] Dock 고정 항목:$names | 다운로드"
  else
    defaults write com.apple.dock persistent-apps -array "${tiles[@]}"
    defaults write com.apple.dock persistent-others -array "$(dock_tile "$HOME/Downloads" directory)"
    mkdir -p "$BOOTSTRAP_STATE" && touch "$dock_marker"
    restart_dock=1
    ok "Dock 고정 항목:$names | 다운로드"
  fi
fi

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
# 바꿀 때 macOS가 이 터미널의 System Events 제어 허용을 한 번 묻는다 (직접 허용). 자동 갱신에서는 묻는 창을 띄우지 않게 미룬다.
# 배경화면은 전체(AllSpacesAndDisplays)나 모니터·스페이스별(Displays, Spaces)로 저장되므로 모든 Desktop 항목을 본다.
# SystemDefault는 새 모니터에 쓰는 기본값이라 보지 않는다.
wallpaper_is_black() {
  /usr/bin/python3 -I - "$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist" <<'PY' 2>/dev/null
import plistlib, sys
store = plistlib.load(open(sys.argv[1], 'rb'))
def desktops(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == 'Desktop' and isinstance(value, dict) and 'Content' in value:
                yield value
            elif key != 'SystemDefault':
                yield from desktops(value)
def is_black(desktop):
    choice = desktop['Content']['Choices'][0]
    config = plistlib.loads(choice['Configuration']) if choice.get('Configuration') else {}
    return 'black' in config.get('systemColor', {}) or 'Black.png' in repr(config) + repr(choice.get('Files'))
found = list(desktops(store))
sys.exit(0 if found and all(map(is_black, found)) else 1)
PY
}
manual=0
if wallpaper_is_black; then
  ok "배경화면 검정"
elif needs_person '배경화면 검정 (System Events 제어 허용 창)'; then
  manual=2
elif run osascript -e 'tell application "System Events" to tell every desktop to set picture to "/System/Library/Desktop Pictures/Solid Colors/Black.png"'; then
  ok "배경화면 검정 (변경)"
else
  # 제어 허용을 거부했거나 macOS가 바뀐 경우. 다른 설정은 계속한다.
  warn "배경화면을 바꾸지 못했습니다 → 시스템 설정 > 배경화면에서 색상 '검정' 선택"
fi
exit "$manual"
