#!/usr/bin/env python3
"""기존 Claude API provider의 키를 숨김 입력으로 교체하고 설정을 reload한다."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import warnings


def prepare_provider(config, provider_id, create=False, profile_name=None):
    if not re.fullmatch(r'[a-z][a-z0-9-]*', provider_id):
        raise ValueError('provider ID는 소문자로 시작하는 영문·숫자·하이픈이어야 합니다.')
    providers = config['agents']['providers']
    if not isinstance(providers, dict):
        raise ValueError('providers 설정이 객체가 아닙니다.')
    if create:
        if provider_id in providers:
            raise ValueError('이미 있는 provider입니다. 키 교체는 --create 없이 실행하세요.')
        if provider_id == 'claude':
            raise ValueError('기본 구독 provider 대신 별도 API provider ID를 사용하세요.')
        providers[provider_id] = {'extends': 'claude', 'label': profile_name or provider_id, 'env': {}}
    provider = providers[provider_id]
    if not isinstance(provider, dict) or (provider_id != 'claude' and provider.get('extends') != 'claude'):
        raise ValueError('대상이 Claude provider가 아닙니다.')
    env = provider.setdefault('env', {})
    if not isinstance(env, dict):
        raise ValueError('provider env 설정이 객체가 아닙니다.')
    if create or profile_name is not None:
        add_profile(config, provider_id, profile_name or provider_id)
    return env


def add_profile(config, provider_id, name):
    if not name.strip():
        raise ValueError('프로필 이름은 비어 있을 수 없습니다.')
    profiles = config.setdefault('daemon', {}).setdefault('agentProfiles', [])
    if not isinstance(profiles, list) or any(not isinstance(p, dict) for p in profiles):
        raise ValueError('agentProfiles 설정을 확인하세요.')
    profile_id = f'local-api-{provider_id}'
    matches = [p for p in profiles if p.get('id') == profile_id or p.get('name') == name]
    if matches:
        if len(matches) != 1 or matches[0].get('provider') != provider_id:
            raise ValueError('다른 프로필과 이름 또는 ID가 충돌합니다.')
        return  # 사용자가 지정한 모델·모드 등 기존 프로필 설정은 보존한다.
    profiles.append({'id': profile_id, 'name': name, 'provider': provider_id})


def save_config(config_path, original, config):
    data = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode()
    fd, temporary = tempfile.mkstemp(prefix='.config-api-key-', dir=config_path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if config_path.read_bytes() != original:
            raise ValueError('입력 중 설정이 변경되었습니다. 다시 실행하세요.')
        os.replace(temporary, config_path)  # 임시 파일과 최종 파일 모두 권한 600
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', default='claude-api', help='대상 provider ID (기본: claude-api)')
    parser.add_argument('--create', action='store_true', help='새 Claude API provider와 선택용 프로필 생성')
    parser.add_argument('--profile-name', help='선택용 프로필 이름 (기존 프로필의 모델·모드는 보존)')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('PASEO_HOME') or '~/.paseo').expanduser(), help='로컬 Paseo home')
    parser.add_argument('--no-reload', action='store_true', help='파일만 저장하고 데몬 반영은 생략')
    args = parser.parse_args()
    config_path = (args.home.expanduser() / 'config.json').resolve(strict=True)
    original = config_path.read_bytes()
    try:
        config = json.loads(original)
        env = prepare_provider(config, args.provider, args.create, args.profile_name)
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError):
        print('기존 Claude provider 설정을 확인할 수 없습니다. 파일은 변경하지 않았습니다.', file=sys.stderr)
        return 1

    cli = shutil.which('paseo')
    if not cli:
        bundled = Path('/Applications/Paseo.app/Contents/Resources/bin/paseo')
        if os.access(bundled, os.X_OK):
            cli = str(bundled)
    if not args.no_reload and not cli:
        print('Paseo CLI를 찾지 못했습니다. 파일만 바꾸려면 --no-reload를 사용하세요.', file=sys.stderr)
        return 1

    print(f'대상: {args.provider} ({config_path})')
    # 터미널이 없을 때 getpass가 평문 입력으로 전환하지 않게 한다.
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        key = getpass.getpass('새 API 키 (화면에 표시되지 않음): ')
    if not key or any(char.isspace() for char in key):
        print('빈 키 또는 공백이 포함된 키는 저장하지 않습니다.', file=sys.stderr)
        return 1
    env['ANTHROPIC_API_KEY'] = key
    save_config(config_path, original, config)
    print('API 키 저장 완료 (파일 권한 600).')
    if args.create or args.profile_name is not None:
        print('선택용 API 프로필 저장 완료.')
    if args.no_reload:
        print('데몬에는 아직 반영하지 않았습니다 (--no-reload).')
        return 0
    # 키를 명령 인자나 환경변수로 전달하지 않는다. CLI 오류에도 키가 출력되지 않게 한다.
    child_env = {k: v for k, v in os.environ.items() if k != 'PASEO_HOST'}
    try:
        result = subprocess.run([cli, 'reload', '--home', str(config_path.parent)], env=child_env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is None or result.returncode != 0:
        print('키는 저장됐지만 Paseo reload를 확인하지 못했습니다. 해당 호스트의 설정을 다시 로드하세요.', file=sys.stderr)
        return 1
    print('Paseo reload 완료. 새 키를 쓰려면 해당 API provider로 새 에이전트를 시작하세요.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print('\n입력을 취소했거나 숨김 입력이 가능한 터미널이 없습니다.', file=sys.stderr)
        sys.exit(1)
    except OSError:
        print('설정 파일 접근에 실패했습니다. 경로와 권한을 확인하세요.', file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
