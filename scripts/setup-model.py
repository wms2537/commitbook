#!/usr/bin/env python3
"""Fetch the pinned public model and build a task-local CPU runtime."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / '.models' / 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
REVISION = '91cad51170dc346986eccefdc2dd33a9da36ead9'
SHA256 = '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
MODEL_URL = f'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/{REVISION}/{MODEL.name}'
RUNTIME = ROOT / '.runtime' / 'model-venv'
PYTHON = RUNTIME / 'bin' / 'python'

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(8 * 1024 * 1024):
            value.update(chunk)
    return value.hexdigest()

if not shutil.which('uv'):
    raise SystemExit('Install uv, then rerun setup. A C++ compiler is also required for the CPU runtime build.')
if not PYTHON.exists():
    subprocess.run(['uv', 'venv', str(RUNTIME), '--python', sys.executable], check=True)
probe = subprocess.run([str(PYTHON), '-c', "import llama_cpp; assert llama_cpp.__version__ == '0.3.19'"], capture_output=True)
if probe.returncode:
    environment = dict(os.environ)
    environment['CMAKE_ARGS'] = '-DGGML_CUDA=OFF -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF'
    environment['CMAKE_BUILD_PARALLEL_LEVEL'] = '4'
    environment['UV_LINK_MODE'] = 'copy'
    environment['CC'] = shutil.which('gcc') or environment.get('CC', 'cc')
    environment['CXX'] = shutil.which('g++') or environment.get('CXX', 'c++')
    # Build against the host C library. The publisher's generic Linux CPU wheel
    # required musl here, so installing it on this glibc host did not work.
    subprocess.run(['uv', 'pip', 'install', '--python', str(PYTHON),
                    '--no-binary', 'llama-cpp-python', '--reinstall-package', 'llama-cpp-python',
                    '--requirements', str(ROOT / 'agent' / 'model-requirements.txt')],
                   env=environment, check=True)
    subprocess.run([str(PYTHON), '-c', "import llama_cpp; assert llama_cpp.__version__ == '0.3.19'"], check=True)

MODEL.parent.mkdir(exist_ok=True)
if not MODEL.exists():
    temporary = MODEL.with_suffix('.partial')
    with urllib.request.urlopen(MODEL_URL, timeout=60) as response, temporary.open('wb') as destination:
        while chunk := response.read(8 * 1024 * 1024):
            destination.write(chunk)
    if digest(temporary) != SHA256:
        raise SystemExit('Downloaded model checksum mismatch; refusing to use it.')
    temporary.replace(MODEL)
if digest(MODEL) != SHA256:
    raise SystemExit('Existing model checksum mismatch; refusing to use it.')
print(json.dumps({'model':'Qwen2.5-1.5B-Instruct-Q4_K_M', 'revision':REVISION,
                  'sha256':SHA256, 'bytes':MODEL.stat().st_size,
                  'runtime':'llama-cpp-python 0.3.19', 'inferencePerformed':False}, indent=2))
