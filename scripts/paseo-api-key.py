#!/usr/bin/env python3
"""Paseo에 로컬 Claude 키 또는 Infisical API 프로필을 설정한다."""
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


INFISICAL_DOMAIN = "https://app.infisical.com/api"
INFISICAL_PROJECT_ID = "7cc30bec-94ce-45b0-b1c7-e1613de839fd"
INFISICAL_PROFILES = (
    ('claude-api-office', 'Claude API (Office)', 'claude', 'ANTHROPIC_API_KEY_OFFICE'),
    ('claude-api-k', 'Claude API (K)', 'claude', 'ANTHROPIC_API_KEY_K'),
    ('claude-api-y', 'Claude API (Y)', 'claude', 'ANTHROPIC_API_KEY_Y'),
    ('claude-api-hi', 'Claude API (HI)', 'claude', 'ANTHROPIC_API_KEY_HI'),
    ('codex-api-office', 'GPT API (Office)', 'codex', 'GPT_API_KEY_OFFICE'),
    ('codex-api-k', 'GPT API (K)', 'codex', 'GPT_API_KEY_K'),
)


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
    if 'PASEO_INFISICAL_API_SECRET' in env:
        raise ValueError('Infisical에 연결된 provider입니다. 키 교체는 Infisical에서 하세요.')
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
    profile = {'id': profile_id, 'name': name, 'provider': provider_id}
    profiles.append(profile)
    return profile


def replace_file(path, original, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.config-api-key-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        current = path.read_bytes() if path.exists() else None
        if current != original:
            raise ValueError('설정 중 파일이 변경되었습니다. 다시 실행하세요.')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_config(config_path, original, config):
    data = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode()
    replace_file(config_path, original, data)


def active_infisical_project(cli, profile_name):
    options = ['--profile', profile_name, '--domain', INFISICAL_DOMAIN, '--silent']
    env = os.environ.copy()
    env.pop('INFISICAL_TOKEN', None)
    for command in (['login', 'status'], ['secrets-manager', 'projects', 'get', INFISICAL_PROJECT_ID]):
        result = subprocess.run([cli, *command, *options], cwd='/', stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, timeout=10)
        if result.returncode:
            return False
    return True


def install_infisical_profiles(config_path, original, config, if_ready=False):
    binaries = {}
    for name in ('infisical', 'claude', 'codex'):
        binary = shutil.which(name)
        if not binary:
            if if_ready:
                return False
            raise ValueError(f'{name} 실행 파일을 PATH에서 찾을 수 없습니다.')
        binaries[name] = str(Path(binary).absolute())
    try:
        login = subprocess.run([binaries['infisical'], 'profile', 'current', '--plain', '--silent'],
                               cwd='/', stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        profile_name = login.stdout.strip()
        has_profile = not login.returncode and bool(profile_name) and '\n' not in profile_name
        if if_ready and (not has_profile or not active_infisical_project(binaries['infisical'], profile_name)):
            return False
    except subprocess.TimeoutExpired:
        if if_ready:
            return False
        raise ValueError('Infisical 로그인 프로필 조회 시간이 초과되었습니다.') from None
    if not has_profile:
        raise ValueError('Infisical 로그인 프로필이 없습니다. infisical login을 실행하세요.')

    runner = config_path.with_name('paseo-infisical-provider')
    legacy_runner = config_path.with_name('infisical-api-provider')
    runner_source = Path(__file__).with_name('paseo-infisical-provider.sh').read_bytes()
    previous_runner = runner.read_bytes() if runner.is_file() and not runner.is_symlink() else None
    if runner.is_symlink() or (runner.exists() and (
            not previous_runner or b'Fetch only the key assigned to the selected Paseo provider.' not in previous_runner)):
        raise ValueError('기존 Infisical 실행 파일이 있어 덮어쓸 수 없습니다.')

    providers = config.setdefault('agents', {}).setdefault('providers', {})
    for provider_id, label, backend, secret in INFISICAL_PROFILES:
        if provider_id in providers:
            provider = providers[provider_id]
            if (provider.get('extends') != backend or provider.get('command') not in
                    ([str(runner)], [str(legacy_runner)]) or
                    provider.get('env', {}).get('PASEO_INFISICAL_API_SECRET') != secret):
                raise ValueError(f'다른 설정과 provider ID가 충돌합니다. ({provider_id})')
        else:
            provider = providers[provider_id] = {'extends': backend, 'label': label, 'env': {}}
        env = provider.get('env', {})
        if env.get('ANTHROPIC_API_KEY') or env.get('OPENAI_API_KEY') or env.get('ANTHROPIC_AUTH_TOKEN'):
            raise ValueError(f'기존 API 키가 설정 파일에 있습니다. ({provider_id})')
        provider['command'] = [str(runner)]
        env.update(PASEO_INFISICAL_API_SECRET=secret, PASEO_INFISICAL_PROFILE=profile_name,
                   PASEO_INFISICAL_CLI=binaries['infisical'], PASEO_API_BACKEND=binaries[backend])
        provider['env'] = env
        model = 'claude-sonnet-5-5' if backend == 'claude' else 'gpt-6.2-sol'
        if backend == 'codex':
            provider.setdefault('models', [{'id': model, 'label': 'GPT-6.2 Sol', 'isDefault': True}])
        profile = add_profile(config, provider_id, label)
        if profile is not None:
            profile['model'] = model

    if previous_runner != runner_source or runner.stat().st_mode & 0o777 != 0o700:
        replace_file(runner, previous_runner, runner_source, mode=0o700)
    if config != json.loads(original):
        save_config(config_path, original, config)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--infisical', action='store_true', help='Infisical의 Claude·GPT API 프로필 6개 설치')
    parser.add_argument('--if-ready', action='store_true', help='Infisical 인증·프로젝트 접근이 준비된 경우에만 설치')
    parser.add_argument('--provider', help='대상 provider ID (기본: claude-api)')
    parser.add_argument('--create', action='store_true', help='새 Claude API provider와 선택용 프로필 생성')
    parser.add_argument('--profile-name', help='선택용 프로필 이름 (기존 프로필의 모델·모드는 보존)')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('PASEO_HOME') or '~/.paseo').expanduser(), help='로컬 Paseo home')
    parser.add_argument('--no-reload', action='store_true', help='파일만 저장하고 데몬 반영은 생략')
    args = parser.parse_args()
    if args.if_ready and not args.infisical:
        parser.error('--if-ready는 --infisical과 함께 사용하세요.')
    if args.infisical and (args.create or args.provider is not None or args.profile_name is not None):
        parser.error('--infisical과 개별 provider 옵션은 함께 사용할 수 없습니다.')
    provider_id = 'claude-api' if args.provider is None else args.provider
    config_path = (args.home.expanduser() / 'config.json').resolve(strict=True)
    original = config_path.read_bytes()
    try:
        config = json.loads(original)
        if not args.infisical:
            env = prepare_provider(config, provider_id, args.create, args.profile_name)
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

    if args.infisical:
        if not install_infisical_profiles(config_path, original, config, args.if_ready):
            print('Infisical API 프로필 건너뜀 (CLI·로그인·프로젝트 접근 상태 확인).')
            return 0
        print('Infisical API 프로필 6개 저장 완료.')
    else:
        print(f'대상: {provider_id} ({config_path})')
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
        print('파일은 저장됐지만 Paseo reload를 확인하지 못했습니다. 해당 호스트의 설정을 다시 로드하세요.', file=sys.stderr)
        return 1
    print('Paseo reload 완료. 해당 API provider로 새 에이전트를 시작하세요.')
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
