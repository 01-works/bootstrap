#!/usr/bin/env python3
"""Paseo에 로컬 Claude 키 또는 Infisical API 프로필을 설정한다."""
import argparse
import fcntl
import getpass
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
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
CLAUDE_PROFILES = {
    provider: (provider.removeprefix('claude-api-') + ' api', secret)
    for provider, _, backend, secret in INFISICAL_PROFILES if backend == 'claude'
}
ZEROSUB_SELECTION = 'bootstrap-zerosub-claude.json'
OPENROUTER_SECRET = 'OPENROUTER_API_KEY'
ANSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.')


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


def infisical_profile(cli):
    login = subprocess.run([cli, 'profile', 'current', '--plain', '--silent'],
                           cwd='/', stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
    profile = login.stdout.strip()
    return profile if not login.returncode and profile and '\n' not in profile else None


def infisical_secret(cli, profile, secret, env):
    result = subprocess.run([cli, 'secrets', 'get', secret, '--profile', profile,
                             '--domain', INFISICAL_DOMAIN, '--projectId', INFISICAL_PROJECT_ID,
                             '--env', 'prod', '--path', '/ai', '--plain', '--silent', '--expand=false'],
                            cwd='/', env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, timeout=15)
    return '' if result.returncode else result.stdout.strip()


def zerosub_enabled(config):
    plugin = config.get('plugins', {}).get('zerosub')
    return config.get('pluginsEnabled') is True and isinstance(plugin, dict) and plugin.get('enabled') is not False


def covered_by_zerosub(home, config, selection=None):
    if not zerosub_enabled(config):
        return set()
    try:
        if selection is None:
            selection = json.loads((home / ZEROSUB_SELECTION).read_bytes())
        accounts = json.loads((home / 'zerosub' / 'state.json').read_bytes())['accounts']
        active = {a['id'] for a in accounts if a.get('family') == 'claude'
                  and a.get('auth') == 'api' and a.get('signedIn') is True and not a.get('disabled')}
        return {provider for provider in CLAUDE_PROFILES if selection.get(provider) in active}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return set()


def remove_covered_profiles(config, covered):
    profiles = config.get('daemon', {}).get('agentProfiles', [])
    profiles[:] = [p for p in profiles
                   if not (p.get('provider') in covered and p.get('id') == f"local-api-{p['provider']}")]


def import_zerosub_claude(config_path):
    infisical, node = shutil.which('infisical'), shutil.which('node')
    if not infisical or not node:
        raise ValueError('ZeroSub로 가져오려면 Infisical CLI와 Node가 필요합니다.')
    home = config_path.parent
    config = json.loads(config_path.read_bytes())
    if not zerosub_enabled(config):
        raise ValueError('이 기기의 Paseo에서 ZeroSub를 먼저 설치해 켜세요.')
    env = os.environ.copy()
    env.pop('INFISICAL_TOKEN', None)
    env.pop('PASEO_HOST', None)
    try:
        profile = infisical_profile(infisical)
        if not profile:
            raise ValueError('Infisical 로그인 프로필이 없습니다. infisical login을 실행하세요.')
        wanted = []
        for provider, (label, secret) in CLAUDE_PROFILES.items():
            key = infisical_secret(infisical, profile, secret, env)
            if not re.fullmatch(r'sk-[A-Za-z0-9_-]+', key):
                raise ValueError(f'{label} 키를 가져오지 못했습니다. Infisical 로그인과 접근 권한을 확인하세요.')
            wanted.append({'provider': provider, 'label': label, 'key': key})
        if len({account['key'] for account in wanted}) != len(wanted):
            raise ValueError('Infisical에 같은 Claude 키가 두 이름 이상으로 등록되어 있습니다.')
        # 키는 자식 프로세스의 stdin으로만 넘긴다. 오류의 원문에는 키가 들어갈 수 있다.
        helper = Path(__file__).with_name('paseo-zerosub-client.mjs')
        result = subprocess.run([node, str(helper), str(home)], input=json.dumps(wanted),
                                capture_output=True, text=True, env=env, timeout=125)
    except subprocess.TimeoutExpired:
        raise ValueError('Infisical 또는 ZeroSub 요청 시간이 초과됐습니다. 다시 실행하세요.') from None
    if result.returncode:
        raise ValueError('ZeroSub 가져오기 실패. Paseo 앱·ZeroSub 실행 상태와 API 계정 이름 충돌을 확인하세요. 일부 등록됐으면 다시 실행해 이어갈 수 있습니다.')
    try:
        selection = json.loads(result.stdout)
    except ValueError:
        raise ValueError('ZeroSub 등록 응답을 확인할 수 없습니다.') from None
    if (not isinstance(selection, dict) or selection.keys() != CLAUDE_PROFILES.keys() or
            not all(isinstance(account, str) for account in selection.values()) or
            len(set(selection.values())) != len(CLAUDE_PROFILES)):
        raise ValueError('ZeroSub API 계정 네 개를 서로 구분할 수 없습니다.')
    original = config_path.read_bytes()
    config = json.loads(original)
    if covered_by_zerosub(home, config, selection) != set(CLAUDE_PROFILES):
        raise ValueError('ZeroSub API 계정 네 개를 모두 확인할 수 없습니다.')
    receipt = home / ZEROSUB_SELECTION
    previous = receipt.read_bytes() if receipt.exists() else None
    replace_file(receipt, previous, (json.dumps(selection, indent=2) + '\n').encode())
    remove_covered_profiles(config, set(CLAUDE_PROFILES))
    if config != json.loads(original):
        save_config(config_path, original, config)


def opencode_login(opencode, key, timeout=45):
    """OpenCode는 API 키를 터미널 입력으로만 받는다. 키가 명령 인자·환경변수에 남지 않게 가상 터미널로 입력한다."""
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir('/')
            os.execv(opencode, [opencode, 'auth', 'login', 'openrouter'])
        finally:
            os._exit(127)
    screen, sent, exited = b'', False, False
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 200, 0, 0))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.5)[0]:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    chunk = b''
                if not chunk:
                    exited = True
                    break
                screen += chunk
            if not sent and b'API key' in ANSI.sub(b'', screen):
                time.sleep(0.5)
                try:
                    os.write(fd, key.encode())
                    time.sleep(0.3)
                    os.write(fd, b'\r')
                except OSError:
                    break
                sent = True
    finally:
        os.close(fd)
        if not exited:
            os.kill(pid, 15)
        status = os.waitpid(pid, 0)[1]
    return sent and exited and status == 0


def openrouter_stored(opencode):
    listed = subprocess.run([opencode, 'auth', 'list'], cwd='/', stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=30)
    if listed.returncode:
        raise ValueError('opencode auth list를 실행하지 못했습니다.')
    return b'OpenRouter' in ANSI.sub(b'', listed.stdout)


def import_openrouter():
    """새로 등록하면 True, 이미 있으면 False. 다시 로그인하면 OpenCode가 계정을 하나 더 만들므로 건너뛴다."""
    infisical = shutil.which('infisical')
    opencode = shutil.which('opencode') or str(Path.home() / '.opencode/bin/opencode')
    if not infisical or not os.access(opencode, os.X_OK):
        raise ValueError('OpenRouter를 가져오려면 Infisical CLI와 OpenCode(agents 단계)가 필요합니다.')
    env = os.environ.copy()
    env.pop('INFISICAL_TOKEN', None)
    try:
        if openrouter_stored(opencode):
            return False
        profile = infisical_profile(infisical)
        if not profile:
            raise ValueError('Infisical 로그인 프로필이 없습니다. infisical login을 실행하세요.')
        key = infisical_secret(infisical, profile, OPENROUTER_SECRET, env)
        if not re.fullmatch(r'sk-or-[A-Za-z0-9_-]+', key):
            raise ValueError('OpenRouter 키를 가져오지 못했습니다. Infisical 로그인과 접근 권한을 확인하세요.')
        if not opencode_login(opencode, key) or not openrouter_stored(opencode):
            raise ValueError('OpenCode 로그인을 확인하지 못했습니다. 터미널에서 opencode auth login으로 OpenRouter를 직접 등록하세요.')
    except subprocess.TimeoutExpired:
        raise ValueError('Infisical 또는 OpenCode 요청 시간이 초과됐습니다. 다시 실행하세요.') from None
    return True


def enable_opencode_provider(config):
    providers = config.setdefault('agents', {}).setdefault('providers', {})
    provider = providers.setdefault('opencode', {}) if isinstance(providers, dict) else None
    if not isinstance(provider, dict):
        raise ValueError('opencode provider 설정이 객체가 아닙니다.')
    provider['enabled'] = True


def install_infisical_profiles(config_path, original, config, if_ready=False):
    binaries = {}
    for name in ('infisical', 'claude', 'codex'):
        binary = shutil.which(name)
        if not binary:
            if if_ready:
                return None
            raise ValueError(f'{name} 실행 파일을 PATH에서 찾을 수 없습니다.')
        binaries[name] = str(Path(binary).absolute())
    try:
        profile_name = infisical_profile(binaries['infisical'])
        if if_ready and (not profile_name or not active_infisical_project(binaries['infisical'], profile_name)):
            return None
    except subprocess.TimeoutExpired:
        if if_ready:
            return None
        raise ValueError('Infisical 로그인 프로필 조회 시간이 초과되었습니다.') from None
    if not profile_name:
        raise ValueError('Infisical 로그인 프로필이 없습니다. infisical login을 실행하세요.')

    runner = config_path.with_name('paseo-infisical-provider')
    legacy_runner = config_path.with_name('infisical-api-provider')
    runner_source = Path(__file__).with_name('paseo-infisical-provider.sh').read_bytes()
    previous_runner = runner.read_bytes() if runner.is_file() and not runner.is_symlink() else None
    if runner.is_symlink() or (runner.exists() and (
            not previous_runner or b'Fetch only the key assigned to the selected Paseo provider.' not in previous_runner)):
        raise ValueError('기존 Infisical 실행 파일이 있어 덮어쓸 수 없습니다.')

    covered = covered_by_zerosub(config_path.parent, config)
    providers = config.setdefault('agents', {}).setdefault('providers', {})
    for provider_id, label, backend, secret in INFISICAL_PROFILES:
        if provider_id in covered:
            continue
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
    return len(INFISICAL_PROFILES) - len(covered)


def daemon_running(cli, home, env):
    try:
        result = subprocess.run([cli, 'daemon', 'status', '--json', '--home', str(home)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        return json.loads(result.stdout).get('localDaemon') == 'running'
    except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError):
        # 상태를 모르면 켜진 것으로 보고 reload 실패를 그대로 알린다.
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--infisical', action='store_true', help='Infisical의 Claude·GPT API 프로필 설치')
    mode.add_argument('--zerosub', action='store_true', help='Infisical의 Claude API 키를 이 기기의 ZeroSub로 가져오기')
    mode.add_argument('--openrouter', action='store_true', help='Infisical의 OpenRouter 키를 이 기기의 OpenCode에 등록하고 Paseo OpenCode provider 켜기')
    parser.add_argument('--if-ready', action='store_true', help='Infisical 인증·프로젝트 접근이 준비된 경우에만 설치')
    parser.add_argument('--provider', help='대상 provider ID (기본: claude-api)')
    parser.add_argument('--create', action='store_true', help='새 Claude API provider와 선택용 프로필 생성')
    parser.add_argument('--profile-name', help='선택용 프로필 이름 (기존 프로필의 모델·모드는 보존)')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('PASEO_HOME') or '~/.paseo').expanduser(), help='로컬 Paseo home')
    parser.add_argument('--no-reload', action='store_true', help='파일만 저장하고 데몬 반영은 생략')
    args = parser.parse_args()
    if args.if_ready and not args.infisical:
        parser.error('--if-ready는 --infisical과 함께 사용하세요.')
    imported = args.infisical or args.zerosub or args.openrouter
    if imported and (args.create or args.provider is not None or args.profile_name is not None):
        parser.error('--infisical·--zerosub·--openrouter와 개별 provider 옵션은 함께 사용할 수 없습니다.')
    if args.zerosub and args.no_reload:
        parser.error('--zerosub는 실행 중인 로컬 Paseo가 필요합니다.')
    provider_id = 'claude-api' if args.provider is None else args.provider
    config_path = (args.home.expanduser() / 'config.json').resolve(strict=True)
    original = config_path.read_bytes()
    try:
        config = json.loads(original)
        if not imported:
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

    if args.zerosub:
        import_zerosub_claude(config_path)
        print('ZeroSub Claude API 계정 4개 확인 완료. 이 기기의 중복 Paseo 프로필을 정리했습니다.')
    elif args.openrouter:
        added = import_openrouter()
        enable_opencode_provider(config)
        if config != json.loads(original):
            save_config(config_path, original, config)
        print('OpenRouter 키를 OpenCode에 등록했습니다.' if added else
              'OpenCode에 OpenRouter가 이미 있어 등록을 건너뜁니다. 키를 바꾸려면 opencode auth logout 후 다시 실행하세요.')
        print('Paseo OpenCode provider 켜짐.')
    elif args.infisical:
        count = install_infisical_profiles(config_path, original, config, args.if_ready)
        if count is None:
            print('Infisical API 프로필 건너뜀 (CLI·로그인·프로젝트 접근 상태 확인).')
            return 0
        print(f'Infisical API 프로필 {count}개 설정 완료.')
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
    # 자동 실행에서 데몬이 꺼져 있으면 reload 실패를 실패로 보지 않는다. 데몬은 시작할 때 설정을 읽는다.
    # 데몬이 꺼진 기기(앱을 닫은 노트북)에서 자동 갱신이 매번 실패하지 않게 한다.
    if (result is None or result.returncode != 0) and args.if_ready and not daemon_running(cli, config_path.parent, child_env):
        print('Paseo 데몬이 꺼져 있어 reload는 건너뜁니다. 다음에 데몬이 시작할 때 반영됩니다.')
        return 0
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
