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

    def run_script(self, key='new-fixture-value', args=(), reload_code=0, login='fixture-profile', status=0, project=0):
        output = io.StringIO()
        def run(command, **kwargs):
            if command[1:3] == ['profile', 'current']:
                return subprocess.CompletedProcess(command, 0, stdout=login)
            if command[1:3] == ['login', 'status']:
                return subprocess.CompletedProcess(command, status)
            if command[1:4] == ['secrets-manager', 'projects', 'get']:
                return subprocess.CompletedProcess(command, project)
            return subprocess.CompletedProcess(command, reload_code)

        with patch('sys.argv', ['script', '--home', str(self.home), *args]), \
             patch.object(api_key.getpass, 'getpass', return_value=key), \
             patch.object(api_key.shutil, 'which', side_effect=lambda name: f'/fake/{name}'), \
             patch.object(api_key.subprocess, 'run', side_effect=run) as reload, \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = api_key.main()
        if key:
            self.assertNotIn(key, output.getvalue())
        self.assertNotIn('old-fixture-value', output.getvalue())
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


if __name__ == '__main__':
    unittest.main()
