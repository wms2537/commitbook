import fs from 'node:fs';
import path from 'node:path';
import {Wallet} from 'ethers';
import {projectRoot} from './compile.mjs';

// An isolated test wallet. Never prints key material or overwrites an existing key.
const directory = path.join(projectRoot, '.secrets');
const destination = path.join(directory, 'testnet-wallet.json');
if (fs.existsSync(destination)) {
  console.error('A task wallet already exists. Use its public address; this command will not replace it.');
  process.exitCode = 1;
} else {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  fs.chmodSync(directory, 0o700);
  const wallet = Wallet.createRandom();
  fs.writeFileSync(destination, JSON.stringify({
    purpose:'CommitBook testnets only', createdAt:new Date().toISOString(),
    address:wallet.address, privateKey:wallet.privateKey,
  }, null, 2)+'\n', {flag:'wx', mode:0o600});
  console.log(JSON.stringify({address:wallet.address, testnetsOnly:true, privateKeyPrinted:false}, null, 2));
}
