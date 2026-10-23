"""Run real PostgreSQL authorization checks in a disposable local container.

This does not connect to a Supabase project or touch existing containers.
Requires Docker and the postgres:17 image. No ports are exposed.
"""
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[1]
container = 'presentation-studio-test-' + uuid.uuid4().hex[:12]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)

try:
    run('docker', 'run', '-d', '--name', container, '--network', 'none',
        '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
        'postgres:17', stdout=subprocess.DEVNULL)
    for attempt in range(60):
        ready = subprocess.run(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('Test PostgreSQL did not start')
    for script in [root / 'tests/fixture.sql', *sorted((root / 'migrations').glob('*.sql')), root / 'tests/bootstrap.sql', root / 'tests/authorization.sql']:
        print('Running', script.name, flush=True)
        run('docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-q', input=script.read_text())
    print('PostgreSQL authorization checks passed.')
finally:
    subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
