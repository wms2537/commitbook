#!/usr/bin/env python3
"""One local neural model, bounded JSON requests over process-owned stdio."""
from pathlib import Path
import hashlib
import json
import sys

MODEL_ALIAS = 'commitbook-qwen2.5-1.5b'
ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / '.models' / 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
EXPECTED = '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'

def send(message):
    print(json.dumps(message, ensure_ascii=True), flush=True)

try:
    checksum = hashlib.sha256()
    with MODEL.open('rb') as source:
        while chunk := source.read(8 * 1024 * 1024):
            checksum.update(chunk)
    if checksum.hexdigest() != EXPECTED:
        raise ValueError('Unexpected model bytes')
    import llama_cpp
    if llama_cpp.__version__ != '0.3.19':
        raise ValueError('Unexpected runtime version')
    from llama_cpp import Llama
    model = Llama(model_path=str(MODEL), n_ctx=4096, n_threads=4,
                  n_threads_batch=4, chat_format='chatml', verbose=False)
    send({'ready':True, 'model':MODEL_ALIAS, 'sha256':EXPECTED})
except Exception:
    send({'startupError':True})
    raise SystemExit(1)

for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 64_000:
            raise ValueError('Request too large')
        request = json.loads(line)
        request_id = request['id']
        body = request['body']
        response = model.create_chat_completion(
            model=MODEL_ALIAS, messages=body['messages'], temperature=0,
            seed=17, max_tokens=min(int(body.get('max_tokens',256)),256),
            stream=False, response_format=body['response_format'],
        )
        send({'id':request_id, 'response':response})
    except BrokenPipeError:
        break
    except Exception:
        # Do not echo a prompt, provider exception, or file content on failure.
        send({'id':request_id, 'error':'inference-failed'})
