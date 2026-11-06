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

    def run_script(self, key='new-fixture-value', args=(), reload_code=0):
        output = io.StringIO()
        with patch('sys.argv', ['script', '--home', str(self.home), *args]), \
             patch.object(api_key.getpass, 'getpass', return_value=key), \
             patch.object(api_key.shutil, 'which', return_value='/fake/paseo'), \
             patch.object(api_key.subprocess, 'run', return_value=subprocess.CompletedProcess([], reload_code)) as reload, \
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


if __name__ == '__main__':
    unittest.main()
