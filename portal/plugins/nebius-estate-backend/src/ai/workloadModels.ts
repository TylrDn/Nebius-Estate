import { promises as fs } from 'fs';
import { join } from 'path';
import { extractModelRefs } from '@internal/nebius-domain';
import { isAllowedRepoPath, RepoReader } from '../repo/RepoReader';

/** Files whose model ids the workloads pull: the inference overlays, the serverless recipe scripts and the pinned versions. */
const FIXED = ['platform/versions.yaml', 'recipes/serverless/endpoint.sh', 'recipes/serverless/job.sh'];
const OVERLAYS = 'workloads/inference/overlays';

/** Hugging Face repos the repository's workloads and recipes reference (read through the allowlisted RepoReader). */
export async function readWorkloadModelRefs(repo: RepoReader): Promise<{ repo: string; usedBy: string[] }[]> {
  const overlays = await fs.readdir(join(repo.root, OVERLAYS), { withFileTypes: true }).catch(() => []);
  const paths = [...FIXED, ...overlays.filter(d => d.isDirectory()).map(d => `${OVERLAYS}/${d.name}/kustomization.yaml`)].filter(isAllowedRepoPath);
  const files = await Promise.all(paths.map(async path => ({ path, text: await repo.read(path).catch(() => '') })));
  return extractModelRefs(files.filter(f => f.text));
}
