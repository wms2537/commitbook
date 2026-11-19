#!/usr/bin/env python3
"""Run the pinned model locally. No API key, wallet, or public listener."""
from pathlib import Path
import os
import sys

root = Path(__file__).resolve().parent.parent
python = root / '.runtime' / 'model-venv' / 'bin' / 'python'
model = root / '.models' / 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
if not python.exists() or not model.exists():
    raise SystemExit('Run python3 scripts/setup-model.py first.')
arguments = [str(python), '-m', 'llama_cpp.server', '--model', str(model),
             '--model_alias', 'commitbook-qwen2.5-1.5b', '--host', '127.0.0.1',
             '--port', '8081', '--n_ctx', '4096', '--n_threads', '4',
             '--n_threads_batch', '4', '--chat_format', 'chatml', '--verbose', 'false']
os.execv(str(python), arguments)
