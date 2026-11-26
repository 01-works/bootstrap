#!/usr/bin/env python3
"""실제 키·홈·데몬 없이 API 설정 변경을 검증한다."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('api_key', Path(__file__).with_name('paseo-api-key.py'))
api_key = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api_key)


class ApiKeyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.path = self.home / 'config.json'
        self.config = {
            'pluginsEnabled': True,
            'daemon': {'agentProfiles': [{'id': 'other', 'name': 'Other', 'provider': 'codex'}]},
            'agents': {'providers': {'claude-api': {
                'extends': 'claude', 'label': 'API',
                'env': {'ANTHROPIC_API_KEY': 'old-fixture-value', 'KEEP': 'unchanged'},
            }}},
        }
        self.path.write_text(json.dumps(self.config))

    def run_script(self, key='new-fixture-value', args=(), reload_code=0, login='fixture-profile', status=0, project=0,
                   selection=None, lookup_code=0, zerosub_code=0, stored=(), secret=None, login_ok=True, daemon='running'):
        output = io.StringIO()
        stored = list(stored)
        def run(command, **kwargs):
            if command[1:3] == ['auth', 'list']:
                listed = b'\x1b[1mOpenRouter\x1b[0m  OpenRouter  stored\n' if stored.pop(0) else b'No authenticated integrations\n'
                return subprocess.CompletedProcess(command, 0, stdout=listed)
            if command[1:3] == ['profile', 'current']:
                return subprocess.CompletedProcess(command, 0, stdout=login)
            if command[1:3] == ['login', 'status']:
                return subprocess.CompletedProcess(command, status)
            if command[1:4] == ['secrets-manager', 'projects', 'get']:
                return subprocess.CompletedProcess(command, project)
            if command[1:3] == ['secrets', 'get']:
                return subprocess.CompletedProcess(command, lookup_code, stdout=f'{secret or "sk-fixture-" + command[3]}\n')
            if command[1:3] == ['daemon', 'status']:
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps(daemon if isinstance(daemon, dict) else {'localDaemon': daemon}) if daemon is not None else 'not json')
            if command[0] == '/fake/node':
                return subprocess.CompletedProcess(command, zerosub_code, stdout=json.dumps(selection))
            return subprocess.CompletedProcess(command, reload_code)

        with patch('sys.argv', ['script', '--home', str(self.home), *args]), \
             patch.object(api_key.getpass, 'getpass', return_value=key), \
             patch.object(api_key.shutil, 'which', side_effect=lambda name: f'/fake/{name}'), \
             patch.object(api_key.subprocess, 'run', side_effect=run) as reload, \
             patch.object(api_key.os, 'access', return_value=True), \
             patch.object(api_key, 'opencode_login', return_value=login_ok) as self.login, \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = api_key.main()
        if key:
            self.assertNotIn(key, output.getvalue())
        self.assertNotIn('old-fixture-value', output.getvalue())
        self.assertNotIn('sk-fixture-', output.getvalue())
        self.assertNotIn('sk-or-', output.getvalue())
        return result, reload

    def test_replace_preserves_unrelated_settings_and_targets_home(self):
        result, reload = self.run_script()
        expected = copy.deepcopy(self.config)
        expected['agents']['providers']['claude-api']['env']['ANTHROPIC_API_KEY'] = 'new-fixture-value'
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(self.path.read_text()), expected)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(reload.call_args.args[0], ['/fake/paseo', 'reload', '--home', str(self.home)])
        self.assertNotIn('PASEO_HOST', reload.call_args.kwargs['env'])

    def test_create_second_provider_and_profile_preserves_first_key(self):
        result, reload = self.run_script(args=('--create', '--provider', 'claude-api-2', '--profile-name', 'Second', '--no-reload'))
        actual = json.loads(self.path.read_text())
        self.assertEqual(result, 0)
        self.assertFalse(reload.called)
        self.assertEqual(actual['agents']['providers']['claude-api'], self.config['agents']['providers']['claude-api'])
        self.assertEqual(actual['agents']['providers']['claude-api-2']['env']['ANTHROPIC_API_KEY'], 'new-fixture-value')
        self.assertEqual(actual['daemon']['agentProfiles'][-1], {'id': 'local-api-claude-api-2', 'name': 'Second', 'provider': 'claude-api-2'})

    def test_existing_profile_keeps_user_settings(self):
        api_key.add_profile(self.config, 'claude-api', 'K')
        self.config['daemon']['agentProfiles'][-1]['modeId'] = 'plan'
        before = copy.deepcopy(self.config)
        api_key.add_profile(self.config, 'claude-api', 'K')
        self.assertEqual(self.config, before)

    def test_invalid_input_does_not_write_or_reload(self):
        original = self.path.read_bytes()
        for key in ('', 'contains space'):
            result, reload = self.run_script(key)
            self.assertEqual(result, 1)
            self.assertFalse(reload.called)
            self.assertEqual(self.path.read_bytes(), original)
        result, reload = self.run_script(args=('--provider', 'missing'))
        self.assertEqual(result, 1)
        self.assertFalse(reload.called)
        self.assertEqual(self.path.read_bytes(), original)

    def test_conflicts_do_not_write(self):
        original = self.path.read_bytes()
        for args in (('--create',), ('--profile-name', 'Other'), ('--provider', '../bad')):
            with self.assertRaises(ValueError):
                self.run_script(args=args)
            self.assertEqual(self.path.read_bytes(), original)

    def test_concurrent_edit_is_preserved_and_temp_removed(self):
        original = self.path.read_bytes()
        self.path.write_text('{"changedElsewhere": true}')
        with self.assertRaises(ValueError):
            api_key.save_config(self.path, original, self.config)
        self.assertEqual(json.loads(self.path.read_text()), {'changedElsewhere': True})
        self.assertEqual(list(self.home.glob('.config-api-key-*')), [])

    def test_reload_failure_keeps_saved_key_and_reports_failure(self):
        result, reload = self.run_script(reload_code=1)
        self.assertEqual(result, 1)
        self.assertTrue(reload.called)
        self.assertEqual(json.loads(self.path.read_text())['agents']['providers']['claude-api']['env']['ANTHROPIC_API_KEY'], 'new-fixture-value')

    def test_infisical_install_and_reinstall(self):
        self.assertEqual(self.run_script(args=('--infisical',))[0], 0)
        config = json.loads(self.path.read_text())
        runner = self.home / 'paseo-infisical-provider'
        self.assertEqual(runner.stat().st_mode & 0o777, 0o700)
        providers = config['agents']['providers']
        self.assertEqual(providers['claude-api'], self.config['agents']['providers']['claude-api'])
        expected = {'claude-api-office': 'ANTHROPIC_API_KEY_OFFICE', 'claude-api-k': 'ANTHROPIC_API_KEY_K',
                    'claude-api-y': 'ANTHROPIC_API_KEY_Y', 'claude-api-hi': 'ANTHROPIC_API_KEY_HI',
                    'codex-api-office': 'GPT_API_KEY_OFFICE', 'codex-api-k': 'GPT_API_KEY_K'}
        self.assertEqual(len(config['daemon']['agentProfiles']), 7)
        for provider_id, secret in expected.items():
            provider = providers[provider_id]
            self.assertEqual(provider['command'], [str(runner)])
            self.assertEqual(provider['env']['PASEO_INFISICAL_API_SECRET'], secret)
            self.assertNotIn('ANTHROPIC_API_KEY', provider['env'])
            self.assertNotIn('OPENAI_API_KEY', provider['env'])
        config['daemon']['agentProfiles'][-1]['modeId'] = 'read-only'
        self.path.write_text(json.dumps(config))
        before = self.path.read_bytes()
        self.assertEqual(self.run_script(args=('--infisical', '--no-reload'))[0], 0)
        self.assertEqual(self.path.read_bytes(), before)

        old_config = copy.deepcopy(config)
        old_config['agents']['providers']['claude-api-hi']['command'] = [str(self.home / 'infisical-api-provider')]
        self.path.write_text(json.dumps(old_config))
        self.assertEqual(self.run_script(args=('--infisical', '--no-reload'))[0], 0)
        self.assertEqual(json.loads(self.path.read_text()), config)

    def test_automatic_install_skips_without_login_or_project_access(self):
        original = self.path.read_bytes()
        args = ('--infisical', '--if-ready')
        for readiness in ({'login': ''}, {'status': 1}, {'project': 1}):
            with self.subTest(readiness=readiness):
                result, run = self.run_script(args=args, **readiness)
                self.assertEqual(result, 0)
                self.assertEqual(self.path.read_bytes(), original)
                self.assertFalse((self.home / 'paseo-infisical-provider').exists())
                self.assertFalse(any(call.args[0][1] == 'reload' for call in run.call_args_list))

    def test_automatic_install_checks_project_then_reloads(self):
        result, run = self.run_script(args=('--infisical', '--if-ready'))
        self.assertEqual(result, 0)
        calls = [call.args[0] for call in run.call_args_list]
        self.assertEqual([call[1] for call in calls], ['profile', 'login', 'secrets-manager', 'reload'])
        self.assertIn(api_key.INFISICAL_PROJECT_ID, calls[2])
        self.assertEqual(len(json.loads(self.path.read_text())['daemon']['agentProfiles']), 7)

    def test_automatic_install_tolerates_reload_failure_only_when_daemon_is_off(self):
        for daemon, expected in (('stopped', 0), ('running', 1), ('unknown', 1), ({}, 1), (None, 1)):
            with self.subTest(daemon=daemon):
                self.path.write_text(json.dumps(self.config))
                result, run = self.run_script(args=('--infisical', '--if-ready'), reload_code=1, daemon=daemon)
                self.assertEqual(result, expected)
                self.assertTrue(any(call.args[0][1] == 'reload' for call in run.call_args_list))
        result, _ = self.run_script(args=('--infisical',), reload_code=1, daemon='stopped')
        self.assertEqual(result, 1, '직접 실행은 reload 실패를 그대로 알린다')

    def test_infisical_install_stops_on_missing_login_or_manual_provider(self):
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'infisical login'):
            self.run_script(args=('--infisical',), login='')
        self.assertEqual(self.path.read_bytes(), original)
        self.config['agents']['providers']['claude-api-hi'] = {'extends': 'claude'}
        self.path.write_text(json.dumps(self.config))
        with self.assertRaisesRegex(ValueError, 'provider ID'):
            self.run_script(args=('--infisical',))
        self.assertFalse((self.home / 'paseo-infisical-provider').exists())
        self.assertEqual(json.loads(self.path.read_text()), self.config)

    def zerosub_accounts(self):
        config = json.loads(self.path.read_text())
        config['plugins'] = {'zerosub': {'enabled': True}}
        self.path.write_text(json.dumps(config))
        selection = {provider: f'claude-{index:012x}'
                     for index, provider in enumerate(api_key.CLAUDE_PROFILES, 1)}
        state = self.home / 'zerosub' / 'state.json'
        state.parent.mkdir(exist_ok=True)
        state.write_text(json.dumps({'accounts': [
            {'id': identity, 'family': 'claude', 'auth': 'api', 'signedIn': True}
            for identity in selection.values()
        ]}))
        return selection, state

    def test_zerosub_import_removes_only_generated_claude_profiles_and_prevents_reinstall(self):
        self.run_script(args=('--infisical', '--no-reload'))
        selection, state = self.zerosub_accounts()
        config = json.loads(self.path.read_text())
        config['daemon']['agentProfiles'].append({'id': 'custom', 'name': 'Custom', 'provider': 'claude-api-k'})
        self.path.write_text(json.dumps(config))
        result, run = self.run_script(args=('--zerosub',), selection=selection)
        self.assertEqual(result, 0)
        receipt = self.home / api_key.ZEROSUB_SELECTION
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(receipt.read_text()), selection)
        request = next(call for call in run.call_args_list if call.args[0][0] == '/fake/node')
        sent = json.loads(request.kwargs['input'])
        self.assertEqual([a['label'] for a in sent], ['office api', 'k api', 'y api', 'hi api'])
        self.assertNotIn('sk-fixture-', repr(request.args) + repr(request.kwargs['env']))
        self.assertNotIn('sk-fixture-', self.path.read_text() + receipt.read_text())

        self.run_script(args=('--infisical', '--if-ready'))
        providers = json.loads(self.path.read_text())['agents']['providers']
        self.assertTrue(set(selection) <= providers.keys())
        profiles = json.loads(self.path.read_text())['daemon']['agentProfiles']
        self.assertEqual([p['id'] for p in profiles],
                         ['other', 'local-api-codex-api-office', 'local-api-codex-api-k', 'custom'])
        data = json.loads(state.read_text())
        data['accounts'][0]['disabled'] = True
        state.write_text(json.dumps(data))
        self.run_script(args=('--infisical', '--if-ready'))
        self.assertIn('local-api-claude-api-office', [p['id'] for p in json.loads(self.path.read_text())['daemon']['agentProfiles']])

    def test_zerosub_failure_preserves_profiles_and_writes_no_receipt(self):
        self.run_script(args=('--infisical', '--no-reload'))
        selection, _ = self.zerosub_accounts()
        original = self.path.read_bytes()
        duplicate = dict.fromkeys(selection, next(iter(selection.values())))
        for error in ({'lookup_code': 1}, {'zerosub_code': 1}, {'selection': {}}, {'selection': duplicate}):
            with self.subTest(error=error), self.assertRaises(ValueError):
                self.run_script(args=('--zerosub',), **({'selection': selection} | error))
            self.assertEqual(self.path.read_bytes(), original)
            self.assertFalse((self.home / api_key.ZEROSUB_SELECTION).exists())

    def test_openrouter_logs_in_once_then_enables_provider(self):
        result, run = self.run_script(args=('--openrouter',), stored=(False, True), secret='sk-or-fixture-key')
        self.assertEqual(result, 0)
        self.login.assert_called_once_with('/fake/opencode', 'sk-or-fixture-key')
        self.assertNotIn('sk-or-', repr([c.args for c in run.call_args_list]))
        expected = copy.deepcopy(self.config)
        expected['agents']['providers']['opencode'] = {'enabled': True}
        self.assertEqual(json.loads(self.path.read_text()), expected)
        self.assertEqual(run.call_args.args[0], ['/fake/paseo', 'reload', '--home', str(self.home)])

    def test_openrouter_already_stored_skips_infisical_and_login(self):
        result, run = self.run_script(args=('--openrouter', '--no-reload'), stored=(True,))
        self.assertEqual(result, 0)
        self.login.assert_not_called()
        self.assertFalse(any(c.args[0][1:3] == ['secrets', 'get'] for c in run.call_args_list))
        self.assertEqual(json.loads(self.path.read_text())['agents']['providers']['opencode'], {'enabled': True})

    def test_openrouter_failure_keeps_config(self):
        original = self.path.read_bytes()
        for error in ({'lookup_code': 1}, {'secret': 'sk-not-openrouter'}, {'login_ok': False},
                      {'stored': (False, False)}):
            with self.subTest(error=error), self.assertRaises(ValueError):
                self.run_script(args=('--openrouter',), **({'stored': (False, True), 'secret': 'sk-or-fixture-key'} | error))
            self.assertEqual(self.path.read_bytes(), original)


    def test_runner_checks_login_before_secret_lookup(self):
        # 만료 세션의 secrets get은 브라우저 로그인 탭을 열므로, 로그인 확인이 실패하면 조회하지 않는다.
        runner = Path(__file__).with_name('paseo-infisical-provider.sh')
        calls = self.home / 'calls'
        cli = self.home / 'infisical'
        cli.write_text(f'#!/bin/sh\necho "$1 $2" >> "{calls}"\n'
                       '[ "$1" = login ] && exit "$LOGIN_CODE"\necho sk-fixture-key\n')
        cli.chmod(0o700)
        backend = self.home / 'backend'
        backend.write_text('#!/bin/sh\necho "backend $ANTHROPIC_API_KEY"\n')
        backend.chmod(0o700)
        env = {'PATH': '/usr/bin:/bin', 'PASEO_INFISICAL_API_SECRET': 'ANTHROPIC_API_KEY_K',
               'PASEO_INFISICAL_PROFILE': 'fixture-profile', 'PASEO_INFISICAL_CLI': str(cli),
               'PASEO_API_BACKEND': str(backend)}
        for code, expected_calls in (('1', ['login status']), ('0', ['login status', 'secrets get'])):
            with self.subTest(login=code):
                calls.unlink(missing_ok=True)
                result = subprocess.run(['/bin/sh', str(runner)], env=env | {'LOGIN_CODE': code},
                                        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
                self.assertEqual(calls.read_text().split('\n')[:-1], expected_calls)
                if code == '1':
                    self.assertEqual(result.returncode, 1)
                    self.assertIn('infisical login', result.stderr)
                else:
                    self.assertEqual((result.returncode, result.stdout), (0, 'backend sk-fixture-key\n'))

if __name__ == '__main__':
    unittest.main()
