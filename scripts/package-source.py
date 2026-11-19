#!/usr/bin/env python3
"""Package original source and public evidence, excluding credentials/dependencies."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
destination = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / "commitbook-submission-source.zip"
files = [root / name for name in ["README.md", "LICENSE", "THIRD_PARTY.md", "package.json", "package-lock.json", ".gitignore"]]
for directory in ["contracts", "scripts", "test", "app", "agent", "docs", "evidence"]:
    files.extend(path for path in (root / directory).rglob("*") if path.is_file())
for name in ["demo/README.md", "demo/commitbook-walkthrough.metadata.json"]:
    if (root / name).is_file():
        files.append(root / name)
files = sorted(set(files))
for source in files:
    if source.is_symlink() or "__pycache__" in source.parts:
        raise SystemExit("Unexpected symlink or generated Python cache in source selection")
    if source.suffix in {".key", ".raw"} or ".secrets" in source.parts:
        raise SystemExit("Private material in source selection")

# Check known scoped key bytes without printing or including them.
wallet_path = root / ".secrets" / "testnet-wallet.json"
secret = json.loads(wallet_path.read_text()).get("privateKey", "") if wallet_path.exists() else ""
if secret and any(secret.encode() in source.read_bytes() for source in files):
    raise SystemExit("Scoped key detected in selected source content")

destination.parent.mkdir(parents=True, exist_ok=True)
members = {}
for source in files:
    relative = source.relative_to(root)
    if relative.as_posix() in {"evidence/testnet-deployment.json", "evidence/testnet-loop.json", "evidence/testnet-ai-plan.json"}:
        relative = Path("evidence") / "snapshots" / relative.name
    member = (Path("commitbook") / relative).as_posix()
    if member in members and members[member].read_bytes() != source.read_bytes():
        raise SystemExit("Conflicting evidence snapshot")
    members[member] = source

with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for member, source in sorted(members.items()):
        archive.write(source, member)
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Archive integrity check failed")
print(json.dumps({
    "file": str(destination), "files": len(members),
    "bytes": destination.stat().st_size,
    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    "includesPrivateKeys": False, "includesNodeModules": False,
    "includesReactiveSdkSource": False,
}, indent=2))
