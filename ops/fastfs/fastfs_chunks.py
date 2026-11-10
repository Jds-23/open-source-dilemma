import sys, hashlib, struct, base64, time
p = open(sys.argv[1],'rb').read(); cs = int(sys.argv[3])
h = hashlib.sha256(p).hexdigest()
def s(x): b=x.encode(); return struct.pack('<I',len(b))+b
def v(b): return struct.pack('<I',len(b))+b
nonce = int(time.time()) - 1769376240
for i,off in enumerate(range(0,len(p),cs)):
    c = p[off:off+cs]
    d = b'\x01' + s(h+'.wasm') + struct.pack('<III', off, len(p), 0)[:8] + s('application/wasm') + v(c) + struct.pack('<I', nonce)
    open(f"{sys.argv[2]}.{i}",'w').write(base64.b64encode(d).decode())
print(h, (len(p)+cs-1)//cs)
