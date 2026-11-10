import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertReadOnlyCommand, run } from './scan.mjs';

// Restrict the actual subprocess and filesystem entry points, not command-name substrings.
function auditSource(source) {
  const childImports = [...source.matchAll(/import\s+(.+?)\s+from\s+['"]node:child_process['"]/g)];
  assert.equal(childImports.length, 1); assert.equal(childImports[0][1].trim(), '{ spawnSync }');
  const fsImports = [...source.matchAll(/import\s+(.+?)\s+from\s+['"]node:fs['"]/g)];
  assert.equal(fsImports.length, 1);
  const allowedFs = new Set(['readFileSync', 'readdirSync', 'statSync', 'realpathSync', 'existsSync', 'mkdirSync', 'chmodSync', 'writeFileSync', 'lstatSync', 'globSync', 'createReadStream']);
  for (const name of fsImports[0][1].replace(/[{}]/g, '').split(',').map(name => name.trim())) assert.ok(allowedFs.has(name), `unapproved filesystem import: ${name}`);
  const runnerStart = source.indexOf('export function run('), runnerEnd = source.indexOf('\nexport function parseStatus', runnerStart);
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);
  const runner = source.slice(runnerStart, runnerEnd);
  const subprocessCalls = [...source.matchAll(/\b(?:spawn\w*|exec\w*)\s*\(/g)];
  assert.equal(subprocessCalls.length, 1);
  assert.ok(subprocessCalls[0].index > runnerStart && subprocessCalls[0].index < runnerEnd);
  assert.match(runner, /assertReadOnlyCommand\(command, args\);\s+const r = spawnSync\(command, args,/);
  const runCalls = [...source.matchAll(/(?<!function )\brun\(\s*['"]([^'"]+)['"]\s*,\s*\[([^\]]*)\]/g)];
  assert.equal(runCalls.length, 2);
  for (const call of runCalls) {
    assert.ok(['git', 'gh'].includes(call[1]));
    if (call[1] === 'git') assert.match(call[2], /^'-C', path, \.\.\.args$/);
    else assert.match(call[2], /^'pr', 'list', '--repo', g.origin, '--state', 'all', '--head', g.branch, '--limit', '100', '--json', 'number,state,headRefOid,mergedAt,url'$/);
  }
  for (const call of source.matchAll(/\bgit\(\s*(\[[^\]]*\])/g)) {
    const query = call[1].slice(1, -1).split(/\s*,\s*/).map(part => {
      if (/^'[^']*'$/.test(part)) return part.slice(1, -1);
      if (part === 'g.defaultRef') return 'refs/remotes/origin/fake';
      assert.fail(`unapproved dynamic git argument: ${part}`);
    });
    assertReadOnlyCommand('git', ['-C', '/fake', ...query]);
  }
  const outputStart = source.indexOf('export function writeOutputs('), outputEnd = source.indexOf('\nasync function main()', outputStart);
  assert.ok(outputStart >= 0 && outputEnd > outputStart);
  const writeCalls = [...source.matchAll(/\b(?:writeFile\w*|mkdir\w*|chmod\w*)\s*\(/g)];
  assert.equal(writeCalls.length, 4);
  for (const call of writeCalls) assert.ok(call.index > outputStart && call.index < outputEnd, 'output mutations belong only to writeOutputs');
  const output = source.slice(outputStart, outputEnd);
  assert.equal([...output.matchAll(/writeFileSync\(join\(out, '(?:scan\.json|plan-draft\.md)'\)/g)].length, 2);
  assert.equal([...output.matchAll(/mkdirSync\(out, /g)].length, 1);
  assert.equal([...output.matchAll(/chmodSync\(out, /g)].length, 1);
  assert.match(source, /GIT_OPTIONAL_LOCKS: '0'/);
}
const source = readFileSync(new URL('./scan.mjs', import.meta.url), 'utf8');
test('P2 read-only entry-point allowlist accepts current collector structure', () => auditSource(source));
for (const mutation of ["git(['reset','--hard']);", "git(['branch','-D','fake']);", "run('git',['fetch']);", "writeFileSync('/tmp/outside', 'bad');", "spawnSync('curl',[]);", "execFileSync('git',['status']);", "mkdirSync('/tmp/outside');"]) test(`P2 source audit rejects reviewer bypass: ${mutation}`, () => assert.throws(() => auditSource(`${source}\n${mutation}`)));
test('P2 source audit rejects mutation inside output helper and subprocess alias import', () => {
  assert.throws(() => auditSource(source.replace("writeFileSync(join(out, 'scan.json')", "writeFileSync('/tmp/outside'")));
  assert.throws(() => auditSource(source.replace('{ spawnSync }', '{ spawnSync, execFileSync as other }')));
});
test('P2 runtime guard rejects destructive commands, writable query flags and other executables before spawning', () => {
  for (const query of [['reset', '--hard'], ['fetch'], ['worktree', 'remove', '/fake'], ['branch', '-D', 'fake'], ['tag', '-d', 'fake'], ['config', 'user.name', 'fake'], ['symbolic-ref', 'HEAD', 'refs/heads/fake'], ['log', '--output=/tmp/fake'], ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored']]) {
    assert.throws(() => assertReadOnlyCommand('git', ['-C', '/fake', ...query]));
    assert.throws(() => run('git', ['-C', '/fake', ...query]));
  }
  assert.throws(() => run('curl', [])); assert.throws(() => run('git', ['fetch']));
  assert.throws(() => assertReadOnlyCommand('gh', ['api', '--method', 'POST', '/fake']));
  assert.doesNotThrow(() => assertReadOnlyCommand('git', ['-C', '/fake', 'status', '--porcelain=v2', '-z', '--untracked-files=all']));
  assert.doesNotThrow(() => assertReadOnlyCommand('git', ['-C', '/fake', 'branch', '-a', '--contains', 'HEAD', '--format=%(refname)']));
});
