import sys, hashlib, struct, base64
p = open(sys.argv[1],'rb').read()
h = hashlib.sha256(p).hexdigest()
def s(x): b=x.encode(); return struct.pack('<I',len(b))+b
def v(b): return struct.pack('<I',len(b))+b
assert len(p) <= 1<<20
data = b'\x00' + s(h+'.wasm') + b'\x01' + s('application/wasm') + v(p)
open(sys.argv[2],'w').write(base64.b64encode(data).decode())
print(h)
