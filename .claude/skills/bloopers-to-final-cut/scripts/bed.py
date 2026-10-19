import numpy as np, wave
sr=48000; bpm=90; beat=60/bpm; dur=60.0; n=int(sr*dur); t=np.arange(n)/sr
out=np.zeros((n,2))
def note(f): return 440*2**((f-69)/12)
chords=[[60,64,67,71],[57,60,64,67],[53,57,60,64],[55,59,62,65]]  # Cmaj7 Am7 Fmaj7 G7
bar=4*beat
rng=np.random.default_rng(7)
for i in range(int(dur/bar)+1):
    c=chords[i%4]; s=int(i*bar*sr); e=min(n,int((i+1)*bar*sr)); L=e-s
    if L<=0: break
    tt=np.arange(L)/sr; env=np.minimum(1,tt/0.6)*np.minimum(1,(bar-tt)/0.4)
    pad=sum(np.sin(2*np.pi*note(m)*tt+0.3*np.sin(2*np.pi*0.3*tt))+0.3*np.sin(2*np.pi*2*note(m)*tt) for m in c)/len(c)
    bass=np.sin(2*np.pi*note(c[0]-24)*tt)*0.6
    out[s:e,0]+=(pad*0.35+bass*0.3)*env; out[s:e,1]+=(pad*0.35+bass*0.3)*env
    for b in range(4):
        k=s+int(b*beat*sr)
        if b in (0,2):
            kl=int(0.25*sr); kt=np.arange(kl)/sr; f=50+70*np.exp(-kt*30)
            kick=np.sin(2*np.pi*np.cumsum(f)/sr)*np.exp(-kt*12)*0.55
            out[k:k+kl]+=kick[:max(0,min(kl,n-k)),None]
        if b in (1,3):
            sl=int(0.2*sr); sn=rng.standard_normal(sl)*np.exp(-np.arange(sl)/sr*25)*0.18
            out[k:k+sl]+=sn[:max(0,min(sl,n-k)),None]
        for h in (0,0.5):
            hk=k+int(h*beat*sr); hl=int(0.05*sr); hh=np.diff(rng.standard_normal(hl+1))*np.exp(-np.arange(hl)/sr*90)*0.05
            out[hk:hk+hl]+=hh[:max(0,min(hl,n-hk)),None]
# vinyl-ish warmth: gentle lowpass via moving average
k=np.ones(6)/6
for ch in range(2): out[:,ch]=np.convolve(out[:,ch],k,mode='same')
out/=np.max(np.abs(out))*1.1
fade=int(sr*1.5); out[-fade:]*=np.linspace(1,0,fade)[:,None]
s=(out*32767).astype(np.int16)
with wave.open('out/bed.wav','wb') as f: f.setnchannels(2); f.setsampwidth(2); f.setframerate(sr); f.writeframes(s.tobytes())
print('bed ok', dur)
