# Cursor

아직 쓰지 않음 (2026-10-06 지금 Mac mini에 앱 없음, `~/.cursor` 비어 있음).

## 쓰기로 하면

1. `Brewfile.main`에서 `# cask "cursor"` 주석을 푼다.
2. `./bootstrap.sh --only homebrew`
3. 설정을 저장소에 넣을지 정한다. 사용자 설정 파일 위치: `~/Library/Application Support/Cursor/User/settings.json`, `keybindings.json`.
   넣는다면 `home/cursor/Library/Application Support/Cursor/User/`에 두고 `profiles/main.sh`의 `DOTFILES`에 `cursor`를 추가하면 같은 방식으로 링크된다.
