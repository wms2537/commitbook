import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from '../compile.mjs';

export function sourceFingerprint(paths) {
  const walk=relative=>fs.statSync(path.join(projectRoot,relative)).isDirectory()
    ?fs.readdirSync(path.join(projectRoot,relative)).flatMap(name=>walk(path.join(relative,name))):[relative];
  const files=[...new Set(paths.flatMap(walk))].sort();
  const hash=createHash('sha256');
  for(const relative of files)hash.update(relative).update('\0').update(fs.readFileSync(path.join(projectRoot,relative))).update('\0');
  return {algorithm:'sha256',sha256:hash.digest('hex'),paths};
}
export const MODEL_SOURCES=['agent','scripts/evaluate-agent.mjs','scripts/model-worker.py','scripts/serve-model.py','scripts/setup-model.py','scripts/lib/source-fingerprint.mjs'];
export const WORKFLOW_SOURCES=[...MODEL_SOURCES,'app/runtime.mjs','app/catalog.mjs','app/scenario.mjs','contracts','test/helpers.mjs','scripts/compile.mjs','scripts/demo-agent.mjs','package.json','package-lock.json'];
