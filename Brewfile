# 새 Mac에 설치할 것. 모든 기기가 같다.
# 새로 설치한 도구는 여기 적어야 다음 기기에도 깔린다. 빠진 것 찾기: ./bootstrap.sh snapshot
# 도구별 공식 문서와 설치 방법을 고른 이유: TOOLS.md

# git·GitHub
brew "gh"
brew "gitleaks"  # 이 저장소의 커밋 전 비밀값 검사

# Node: Node 자체는 fnm이 설치한다 (development/node.md)
brew "fnm"

# 컨테이너: colima가 Linux VM과 Docker 엔진을 띄우고, docker 명령어로 다룬다 (development/containers.md)
# 로그인할 때 자동으로 켜지 않는다. 필요할 때 colima start
brew "colima"
brew "docker"

# 앱. Claude Code와 Codex CLI는 자동 업데이트되는 공식 스크립트로 설치한다 (scripts/steps/60-agents.sh)
cask "claude"
cask "chatgpt"        # Codex 앱 포함
cask "paseo"
cask "tailscale-app"  # 기기 간 원격 접속

# 브라우저 (agents/browser.md). 에이전트는 Chrome Beta의 전용 프로필을 Browser Use CLI로 조작한다.
# 앱이 달라야 개인 Chrome과 Dock·링크 열기가 섞이지 않는다.
cask "google-chrome"       # 개인용. 로그인이 필요한 작업에 사용자가 요청할 때만 연결
cask "google-chrome@beta"  # 에이전트 전용
# Intel은 Homebrew 바이너리가 없어 Rust·LLVM까지 소스 빌드된다. homebrew 단계에서 공식 uv 바이너리를 설치한다.
brew "uv" unless OS.mac? && Hardware::CPU.intel?

# Cloudflare Tunnel
brew "cloudflared"
