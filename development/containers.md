# 컨테이너

Docker Desktop 대신 **colima**(가벼운 Linux VM)와 docker CLI를 쓴다. 모두 `Brewfile.main`.

```sh
colima start                      # 기본 VM 시작
colima start --cpu 4 --memory 8   # 자원 지정
colima list                       # VM 목록
docker ps
```

- `brew "colima", restart_service: :changed`이므로 Homebrew 서비스로 로그인할 때 자동 시작된다.
- 프로필(`colima start -p <이름>`)로 VM을 여러 개 둘 수 있다. 다 쓴 VM은 `colima delete -p <이름>`으로 지워야 디스크가 돌아온다.

## 메모리 주의

VM에 준 메모리는 macOS에서 그만큼 빠진다. 16GB 기기에서 8GB VM을 돌리면 스왑을 많이 쓴다 ([hardware/buying-guide.md](../hardware/buying-guide.md)).

지금 Mac mini (2026-10-06): VM 3개 중 `issue6016`(4 CPU, 8GB)이 실행 중이고, `epic5820-ui`와 `issue5740`은 멈춰 있다. `~/.colima`가 5GB를 차지한다.
