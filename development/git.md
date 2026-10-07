# git · GitHub

## 계정과 인증

- GitHub 계정: `01-office` (조직 `01-works` 멤버)
- 커밋 작성자: [`home/git/.gitconfig`](../home/git/.gitconfig). 이메일은 GitHub noreply 주소를 쓴다.
- git은 **https + gh 자격 증명**으로 GitHub에 접속한다. `gh auth login` 한 번이면 push/pull이 된다. 토큰은 gh가 관리하고 저장소에는 들어가지 않는다.

## SSH 키

- 기기마다 새로 만든다. 다른 기기의 개인키를 복사해 오지 않는다.
- 다른 기기·서버에 SSH로 접속할 때 쓴다. `auth` 단계에서 키가 없으면 만들지 물어본다.
- git은 https로 쓰므로 GitHub에는 등록하지 않는다. 나중에 GitHub에 SSH로 붙거나 SSH 커밋 서명이 필요해지면 `gh auth refresh -s admin:public_key` 후 `gh ssh-key add`.
- 지금 Mac mini의 `~/.ssh/config`에는 github.com용 키(`id_ed25519_github_01software`)가 지정되어 있다. 다만 gh의 git 프로토콜이 https로 설정되어 있어서, gh로 clone한 저장소에는 이 키가 쓰이지 않는다 (2026-10-06). `~/.ssh/config`는 colima·conductor 설정을 포함하고 있어서 저장소에 넣지 않았다.

## 기기별 설정

이 기기에서만 필요한 git 설정은 `~/.gitconfig.local`에 둔다. `.gitconfig`가 마지막에 include한다.

## 이 저장소의 커밋 전 검사

`.githooks/pre-commit`이 gitleaks로 staged 변경에서 비밀값을 찾는다. gitleaks가 없으면 커밋을 막는다. `xcode` 단계가 git 설치 뒤에 `core.hooksPath`를 설정하고, `doctor`가 켜져 있는지 확인한다.
