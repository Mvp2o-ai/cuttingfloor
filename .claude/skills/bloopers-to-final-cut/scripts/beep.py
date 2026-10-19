import numpy as np, wave
sr=48000; d=0.55; t=np.arange(int(sr*d))/sr
a=np.sin(2*np.pi*1000*t)*0.5; env=np.minimum(1,np.minimum(t/0.005,(d-t)/0.01)); a*=env
s=(a*32767).astype(np.int16)
with wave.open('out/beep.wav','wb') as f: f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr); f.writeframes(s.tobytes())
print('ok')
