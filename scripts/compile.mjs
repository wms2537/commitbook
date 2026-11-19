import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import solc from 'solc';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function solidityFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? solidityFiles(absolute) : absolute.endsWith('.sol') ? [absolute] : [];
  });
}

export function compileContracts({ writeArtifacts = false } = {}) {
  const sources = Object.fromEntries(solidityFiles(path.join(projectRoot, 'contracts')).map((absolute) => [
    path.relative(projectRoot, absolute).split(path.sep).join('/'),
    { content: fs.readFileSync(absolute, 'utf8') },
  ]));
  if (Object.keys(sources).length === 0) throw new Error('No Solidity source files found.');
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (sourcePath) => {
      const relative = sourcePath.startsWith('@reactive/')
        ? path.join('lib', 'reactive-lib-omni', sourcePath.slice('@reactive/'.length))
        : sourcePath;
      const absolute = path.resolve(projectRoot, relative);
      if (!absolute.startsWith(`${projectRoot}${path.sep}`)) return { error: `Import escapes project: ${sourcePath}` };
      if (!fs.existsSync(absolute)) return { error: `Missing import: ${sourcePath}. Run dependency setup first.` };
      return { contents: fs.readFileSync(absolute, 'utf8') };
    },
  }));
  const errors = (output.errors ?? []).filter((item) => item.severity === 'error');
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
  const warnings = (output.errors ?? []).filter((item) => item.severity !== 'error');
  const artifacts = {};
  for (const [source, contracts] of Object.entries(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(contracts)) {
      const artifact = {
        contractName: name,
        sourceName: source,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        compiler: solc.version(),
        evmVersion: 'shanghai',
      };
      artifacts[`${source}:${name}`] = artifact;
      if (writeArtifacts) {
        const destination = path.join(projectRoot, 'artifacts', source, `${name}.json`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`);
      }
    }
  }
  return { artifacts, warnings, compiler: solc.version() };
}

export function getArtifact(compiled, name) {
  const matches = Object.values(compiled.artifacts).filter((item) => item.contractName === name);
  if (matches.length !== 1) throw new Error(`Expected one artifact for ${name}; found ${matches.length}.`);
  return matches[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const compiled = compileContracts({ writeArtifacts: true });
  for (const warning of compiled.warnings) process.stderr.write(warning.formattedMessage);
  console.log(JSON.stringify({ compiler: compiled.compiler, contracts: Object.keys(compiled.artifacts).length, warnings: compiled.warnings.length, evmVersion: 'shanghai' }, null, 2));
}
