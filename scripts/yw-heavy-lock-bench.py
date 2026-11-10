#!/usr/bin/env python3
"""macOS lock_queue CPU comparison. Uses only a new temporary queue; never installs.

Example: python3 scripts/yw-heavy-lock-bench.py --baseline-ref e3c2bef --seconds 10
wait4 includes each bash waiter's reaped descendants (lockf/sleep/edit helpers).
CPU deltas cover the entire waiter lifecycle, including startup and final drain,
so delta / held_seconds is a conservative upper bound on CPU during contention.
ps samples are sums of %CPU for all processes in the waiters' process groups.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
ENTRY = 'main "$@"; exit $?'


def reap(child):
    _, status, usage = os.wait4(child.pid, 0)
    child.returncode = os.waitstatus_to_exitcode(status)
    return usage.ru_utime, usage.ru_stime


def run(source, count, seconds):
    children = []
    with tempfile.TemporaryDirectory(prefix='yw-heavy-lock-bench-') as tmp:
        directory = Path(tmp)
        env = {k: v for k, v in os.environ.items() if not k.startswith('YW_HEAVY_') and k != 'BASH_ENV'}
        env.update(HOME=tmp, XDG_CONFIG_HOME=tmp,
                   YW_HEAVY_QUEUE=f'{tmp}/q', YW_HEAVY_EXEC_LOCK=f'{tmp}/exec',
                   YW_HEAVY_EDIT_LOCK=f'{tmp}/edit', YW_HEAVY_FLOCK=f'{tmp}/flock',
                   YW_HEAVY_LOG=f'{tmp}/log', YW_HEAVY_EVENTS=f'{tmp}/events',
                   YW_HEAVY_NO_RECLAIM=f'{tmp}/no-reclaim')
        assert source.count(ENTRY) == 1
        harness = directory / 'waiter.sh'
        harness.write_text(source.replace(ENTRY, '') + '''
init
printf ready >"$Q.ready.$1"
lock_queue || exit 1
unlock_queue
''')
        try:
            holder = subprocess.Popen(
                ['/bin/bash', '-c', 'exec 9>>"$YW_HEAVY_FLOCK"; /usr/bin/lockf -s -t 0 9 || exit; echo held; read -r _'],
                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
            children.append(holder)
            assert holder.stdout.readline().strip() == b'held'
            waiters = [subprocess.Popen(['/bin/bash', str(harness), str(i)], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True) for i in range(count)]
            children.extend(waiters)
            deadline = time.monotonic() + 30
            while len(list(directory.glob('q.ready.*'))) != count:
                if time.monotonic() > deadline:
                    raise TimeoutError('waiters did not start')
                time.sleep(.02)
            groups = {p.pid for p in waiters}
            samples = []
            begin = time.monotonic()
            for i in range(1, 6):
                time.sleep(max(0, begin + seconds * i / 5 - time.monotonic()))
                lines = subprocess.check_output(['ps', '-A', '-o', 'pgid=,pcpu='], text=True)
                samples.append(round(sum(float(fields[1]) for line in lines.splitlines()
                                         if len(fields := line.split()) == 2 and int(fields[0]) in groups), 3))
            held_seconds = time.monotonic() - begin
            holder.stdin.write(b'release\n')
            holder.stdin.close()
            reap(holder)
            # All waiters finish normally after release; no signal loses their child accounting.
            user = system = 0.0
            deadline = time.monotonic() + 30
            pending = list(waiters)
            while pending:
                for p in pending[:]:
                    pid, status, usage = os.wait4(p.pid, os.WNOHANG)
                    if pid:
                        p.returncode = os.waitstatus_to_exitcode(status)
                        assert p.returncode == 0, p.returncode
                        user += usage.ru_utime
                        system += usage.ru_stime
                        pending.remove(p)
                if time.monotonic() > deadline:
                    raise TimeoutError('waiters did not drain')
                if pending:
                    time.sleep(.02)
            cpu = user + system
            return dict(n=count, held_seconds=round(held_seconds, 4),
                        ps_cpu_percent_samples=samples,
                        ps_cpu_percent_mean=round(sum(samples) / len(samples), 3),
                        cpu_before_seconds=0, cpu_after_seconds=round(cpu, 6),
                        user_seconds=round(user, 6), system_seconds=round(system, 6),
                        cpu_delta_seconds=round(cpu, 6),
                        average_cores_upper_bound=round(cpu / held_seconds, 6),
                        lifecycle_seconds=round(time.monotonic() - begin, 4))
        finally:
            for child in children:
                if child.returncode is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', required=True)
    parser.add_argument('--seconds', type=float, default=10)
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error('--seconds must be positive')
    baseline = subprocess.check_output(['git', 'show', f'{args.baseline_ref}:scripts/yw-heavy.sh'], cwd=ROOT, text=True)
    fixed = (ROOT / 'scripts/yw-heavy.sh').read_text()
    results = []
    for count in (1, 8, 40):
        for name, source in [('baseline', baseline), ('fixed', fixed)]:
            result = dict(version=name, **run(source, count, args.seconds))
            results.append(result)
            print(json.dumps(result), flush=True)
    before, after = results[-2:]
    reduction = 1 - after['average_cores_upper_bound'] / before['average_cores_upper_bound']
    passes = after['average_cores_upper_bound'] <= .25 and reduction >= .95
    print(json.dumps(dict(n40_reduction_percent=round(reduction * 100, 3), passes=passes)), flush=True)
    if not passes:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
