#!/usr/bin/env bash
# Execute only the credential-free setup step, with synthetic network outputs.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
python3 - "${repo_root}" "${work}" <<'PY'
import os
from pathlib import Path
import re
import subprocess
import sys

repo, work = map(Path, sys.argv[1:])
action = (repo / '.github/actions/nebius-stage-setup/action.yml').read_text()
# This is the last composite step; extract its literal bash block without a YAML dependency.
step = action.split('    - name: Backend config, run labels, toolbox pass-through\n', 1)[1]
script = '\n'.join(line[8:] for line in step.split('      run: |\n', 1)[1].splitlines())
workflow = (repo / '.github/workflows/terraform.yml').read_text()
for job in ('plan', 'apply'):
    job_text = workflow.split('\n  ' + job + ':', 1)[1]
    job_text = re.split(r'\n  [a-z]+:', job_text, maxsplit=1)[0]
    for key in ('NIP_SERVICE_CIDR', 'NIP_SECURITY_GROUP_IDS', 'NIP_NODE_SERVICE_ACCOUNT_ID'):
        assert key + ': ${{ vars.' + key + ' }}' in job_text, (job, key)

for stack in ('inference', 'training', 'gpu-vm', 'ml-services'):
    root = work / stack
    (root / 'terraform/live/sandbox' / stack).mkdir(parents=True)
    envfile, outfile = root / 'env', root / 'out'
    env = dict(os.environ, STAGE='sandbox', STACK=stack, STATE_BUCKET='fixture',
               RUN_LABEL='fixture', TTL_HOURS='4', TTL_EXPIRES='2099-01-01T00:00:00Z',
               NEBIUS_REGION='eu-north1', NEBIUS_PROJECT_ID='project-fixture',
               GITHUB_RUN_ID='1', GITHUB_ENV=str(envfile), GITHUB_OUTPUT=str(outfile),
               NIP_SUBNET_ID='subnet-fixture', NIP_SERVICE_CIDR='/20',
               NIP_SECURITY_GROUP_IDS='["securitygroup-fixture"]',
               NIP_NODE_SERVICE_ACCOUNT_ID='serviceaccount-fixture')
    subprocess.run(['bash', '-euo', 'pipefail', '-c', script], env=env, cwd=root, check=True)
    exported = dict(line.split('=', 1) for line in envfile.read_text().splitlines())
    expected = {'TF_VAR_security_group_ids': env['NIP_SECURITY_GROUP_IDS']}
    if stack in ('inference', 'training'):
        expected.update(TF_VAR_service_cidr='/20', TF_VAR_node_service_account_id='serviceaccount-fixture')
    if stack == 'ml-services':
        expected = {}
    for key, value in expected.items():
        assert exported.get(key) == value, (stack, key, exported)
        assert key in exported['TOOLBOX_ENV'].split(), (stack, key, 'missing toolbox forwarding')
    for key in ('TF_VAR_service_cidr', 'TF_VAR_node_service_account_id'):
        if stack not in ('inference', 'training'):
            assert key not in exported, (stack, key, 'cluster-only input leaked')
    if stack == 'ml-services':
        assert 'TF_VAR_security_group_ids' not in exported, 'unsupported ml-services input'
    # Empty optional inputs must preserve Terraform defaults and avoid an invalid empty list.
    env.update(NIP_SERVICE_CIDR='', NIP_SECURITY_GROUP_IDS='', NIP_NODE_SERVICE_ACCOUNT_ID='')
    envfile.unlink()
    subprocess.run(['bash', '-euo', 'pipefail', '-c', script], env=env, cwd=root, check=True)
    exported = dict(line.split('=', 1) for line in envfile.read_text().splitlines())
    assert not any(key in exported for key in (
        'TF_VAR_service_cidr', 'TF_VAR_security_group_ids', 'TF_VAR_node_service_account_id'))

for stage in ('sandbox', 'staging', 'prod'):
    sizing = (repo / f'terraform/live/{stage}/ml-services/{stage}.auto.tfvars').read_text()
    assert re.search(r'^create_node_service_account\s*=\s*false\s*$', sizing, re.M), stage
print('ok: stage setup forwards complete network and node identity inputs; live R12 avoids admin IAM')
PY
