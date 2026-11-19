import fs from 'node:fs';
import path from 'node:path';
import {projectRoot} from './compile.mjs';
import {createRuntime} from '../app/runtime.mjs';
import {runRecoveryScenario} from '../app/scenario.mjs';
import {sourceFingerprint,WORKFLOW_SOURCES} from './lib/source-fingerprint.mjs';

const source=sourceFingerprint(WORKFLOW_SOURCES);
const runtime=await createRuntime();
const destination=path.join(projectRoot,'evidence/agent-workflow.json');
try {
  const report=await runRecoveryScenario(runtime,{sessionId:runtime.snapshot().sessionId},{onStep:step=>console.log(JSON.stringify({step}))});
  if(source.sha256!==sourceFingerprint(WORKFLOW_SOURCES).sha256)throw Object.assign(new Error('Workflow source changed during execution.'),{code:'SOURCE_CHANGED_DURING_RUN'});
  report.source=source;
  fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({evidence:destination,summary:report.summary,aiInference:report.aiInference,publicTestnetExecution:false},null,2));
} catch(error) {
  const report={mode:'local-evm',passed:false,publicTestnetExecution:false,aiInference:runtime.snapshot().aiInference,
    error:{code:error.code??'WORKFLOW_FAILED'},state:runtime.snapshot()};
  fs.mkdirSync(path.join(projectRoot,'runtime-data'),{recursive:true});
  fs.writeFileSync(path.join(projectRoot,'runtime-data/agent-workflow-failure.json'),JSON.stringify(report,null,2)+'\n');
  console.error(JSON.stringify({error:report.error,passed:false}));process.exitCode=1;
} finally {await runtime.close();}
