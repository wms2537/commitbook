import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'lib', 'reactive-lib-omni');
const revision = '3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8';
const remote = 'https://github.com/Reactive-Network/reactive-lib-omni.git';
mkdirSync(path.dirname(destination), {recursive: true});
if (!existsSync(destination)) {
  execFileSync('git', ['clone', '--no-checkout', remote, destination], {stdio:'inherit'});
  execFileSync('git', ['-C', destination, 'checkout', '--detach', revision], {stdio:'inherit'});
}
const current = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const changes = execFileSync('git', ['-C', destination, 'status', '--porcelain'], {encoding:'utf8'}).trim();
if (current !== revision || changes) {
  throw new Error('Reactive dependency differs from the pinned clean revision. Resolve it explicitly before building.');
}
console.log(JSON.stringify({dependency:'reactive-lib-omni', revision, verified:true}, null, 2));
