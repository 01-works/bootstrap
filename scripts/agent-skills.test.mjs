import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('스킬 설치: dry-run, 양쪽 동일 원본, 재실행, 충돌·중복 보존', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-skills-test-'));
  const script = fileURLToPath(new URL('./agent-skills.mjs', import.meta.url));
  const source = fileURLToPath(new URL('../agents/skills/yw-supervisor', import.meta.url));
  const codex = join(dir, '.agents/skills/yw-supervisor');
  const claude = join(dir, '.claude/skills/yw-supervisor');
  const run = (...args) => spawnSync(process.execPath, [script, '--home', dir, ...args], {
    env: { ...process.env, DRY_RUN: '0' }, encoding: 'utf8'
  });
  try {
    assert.equal(run('--dry-run').status, 0);
    assert.equal(run('--check').status, 1);
    assert.equal(existsSync(join(dir, '.agents')), false);
    assert.equal(existsSync(join(dir, '.claude')), false);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(codex), source);
    assert.equal(readlinkSync(claude), source);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    rmSync(claude);
    rmSync(codex);
    mkdirSync(claude);
    writeFileSync(join(claude, 'SKILL.md'), 'personal skill');
    assert.equal(run().status, 1);
    assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'personal skill');
    assert.equal(existsSync(codex), false, '한쪽 충돌 시 다른 쪽도 쓰기 전에 중단');
    rmSync(claude, { recursive: true });
    mkdirSync(join(dir, '.codex/skills/yw-supervisor'), { recursive: true });
    assert.equal(run().status, 1);
    assert.equal(existsSync(codex), false);
    assert.equal(existsSync(claude), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
