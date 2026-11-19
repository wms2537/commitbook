import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compileContracts, projectRoot} from './compile.mjs';

const evidence = path.join(projectRoot, 'evidence');
fs.mkdirSync(evidence, {recursive:true});
const startedAt = new Date().toISOString();
const setup = spawnSync(process.execPath, ['scripts/setup.mjs'], {cwd:projectRoot, encoding:'utf8', timeout:60_000});
if (setup.status !== 0) throw new Error('Pinned Reactive dependency verification failed. Run npm run setup for details.');
const dependency = JSON.parse(setup.stdout);
const compilation = compileContracts({writeArtifacts:true});
if (compilation.warnings.length) throw new Error(compilation.warnings.map(w=>w.formattedMessage).join('\n'));
const tests = fs.readdirSync(path.join(projectRoot,'test')).filter(n=>n.endsWith('.test.mjs')).sort();
const run = spawnSync(process.execPath, ['--test','--test-concurrency=1','--test-reporter=tap', ...tests.map(n=>path.join('test',n))], {
  cwd:projectRoot, encoding:'utf8', timeout:180_000, maxBuffer:10*1024*1024,
});
const output = `${run.stdout??''}${run.stderr??''}`;
fs.writeFileSync(path.join(evidence,'test-output.txt'), output);
const summary = {
  startedAt, mode:'local-evm-and-mocked-finality',
  publicTestnetExecution:false, aiInference:false,
  compiler:compilation.compiler, compilerWarnings:compilation.warnings.length,
  node:process.version, reactiveSdkRevision:dependency.revision,
  testsPassed:Number(output.match(/^# pass (\d+)$/m)?.[1]??0),
  testsFailed:Number(output.match(/^# fail (\d+)$/m)?.[1]??0),
  testProcessExitCode:run.status, success:run.status===0,
};
summary.success = summary.success && summary.testsPassed > 0 && summary.testsFailed === 0;
function files(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
}
const sourceFiles = ['contracts','scripts','test','app','agent'].flatMap(d=>files(path.join(projectRoot,d)))
  .concat(['package.json','package-lock.json'].map(n=>path.join(projectRoot,n))).sort();
const hash=createHash('sha256');
for(const file of sourceFiles) hash.update(path.relative(projectRoot,file)).update('\0').update(fs.readFileSync(file)).update('\0');
summary.sourceSha256=hash.digest('hex');
if(summary.success){
  const demo=spawnSync(process.execPath,['scripts/demo.mjs'],{cwd:projectRoot,encoding:'utf8',timeout:90_000,maxBuffer:5*1024*1024});
  summary.demoExitCode=demo.status;
  summary.success=demo.status===0;
  if(!summary.success) process.stderr.write(`${demo.stdout??''}${demo.stderr??''}`);
}
summary.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(evidence,'verification.json'), JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
if(!summary.success){process.stderr.write(output);process.exitCode=1;}
