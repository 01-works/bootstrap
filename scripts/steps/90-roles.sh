#!/usr/bin/env bash
# 기기 역할: 이 기기에 켠 역할만 저장된 값으로 다시 맞춘다. 켠 역할이 없으면 아무것도 하지 않는다.
# 역할을 켜고 끄는 것은 사람이 한다 (./bootstrap.sh role add|remove verifier, README "기기 역할").
# scripts/role.sh·verifier-logs.sh가 바뀌면 자동 갱신이 이 단계를 실행해 모든 verifier 기기에 전한다.
set -euo pipefail
source "$BOOTSTRAP_ROOT/scripts/lib.sh"

exec bash "$BOOTSTRAP_ROOT/scripts/role.sh" apply-active
