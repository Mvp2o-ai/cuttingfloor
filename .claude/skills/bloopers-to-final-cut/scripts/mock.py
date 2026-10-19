# Builds a recreated chat session (vertical 1080x1920, 12 s) for create.motion.
# The video card slot is left empty at CARD so the real export can be laid over it.
import json, sys, html as H

CARD = dict(left=180, top=300, width=720, height=1280)  # 9:16 slot

THEMES = {
    'claude': dict(name='Claude', bg='#262624', panel='#30302e', text='#f5f4ee', muted='#a3a29b', accent='#d97757',
                   user_bg='#141413', font='"Inter",system-ui,sans-serif', mark='<div style="width:56px;height:56px;border-radius:14px;background:#d97757"></div>'),
    'chatgpt': dict(name='ChatGPT', bg='#212121', panel='#303030', text='#ececec', muted='#9b9b9b', accent='#ececec',
                    user_bg='#303030', font='"Inter",system-ui,sans-serif', mark='<div style="width:56px;height:56px;border-radius:50%;border:5px solid #ececec"></div>'),
    'kazi': dict(name='Kazi', bg='#0f1216', panel='#161a20', text='#f2f2f2', muted='#8b929c', accent='#f07c2a',
                 user_bg='#1c2129', font='"Inter",system-ui,sans-serif',
                 mark='<div style="width:62px;height:62px;border-radius:16px;border:3px solid #f07c2a;color:#f07c2a;font-weight:900;font-size:30px;display:flex;align-items:center;justify-content:center">KZ</div>'),
}

def build(theme, prompt, files, reply, calls, done, card_label):
    t = THEMES[theme]
    chips = ''.join(f'<span class="chip">🎬 {H.escape(f)}</span>' for f in files)
    rows = ''
    for i, (fn, note) in enumerate(calls):
        d = 4.3 + i * 0.42
        rows += (f'<div class="row" style="animation-delay:{d:.2f}s"><span class="ico"><span class="spin" style="animation:rot .5s linear infinite, out .1s linear {d+0.35:.2f}s forwards"></span>'
                 f'<span class="ok" style="animation:fade .1s linear {d+0.35:.2f}s forwards">✓</span></span>'
                 f'<span class="src">cuttingfloor</span><span class="fn">{H.escape(fn)}</span><span class="nt">{H.escape(note)}</span></div>')
    t_done = 4.3 + len(calls) * 0.42 + 0.3
    typed = H.escape(prompt)
    n = len(prompt)
    return f'''<style>
*{{margin:0;box-sizing:border-box}}
html,body{{width:1080px;height:1920px;overflow:hidden;background:{t['bg']};color:{t['text']};font-family:{t['font']}}}
.top{{position:absolute;top:0;left:0;right:0;height:150px;display:flex;align-items:center;gap:22px;padding:0 54px;border-bottom:2px solid {t['panel']}}}
.top b{{font-size:52px}}
.chat{{position:absolute;top:190px;left:54px;right:54px}}
.user{{margin-left:auto;max-width:940px;background:{t['user_bg']};border-radius:38px;padding:34px 40px;font-size:44px;line-height:1.35;opacity:0;animation:fade .3s ease-out 3.2s forwards}}
.user .chips{{margin-bottom:16px;display:flex;flex-wrap:wrap;gap:12px}}
.chip{{display:inline-block;padding:10px 18px;border-radius:16px;background:{t['panel']};color:{t['text']};font-size:32px;border:2px solid #ffffff18}}
.asst{{margin-top:40px;font-size:44px;line-height:1.4;opacity:0;animation:fade .35s ease-out 3.7s forwards}}
.row{{display:flex;align-items:center;gap:16px;margin-top:18px;font-size:36px;opacity:0;animation:fade .2s ease-out forwards;color:{t['muted']}}}
.row .src{{color:{t['accent']};font-weight:700}} .row .fn{{font-family:"JetBrains Mono",Menlo,monospace;color:{t['text']}}}
.ico{{position:relative;width:32px;height:32px;flex:none}}
.spin{{position:absolute;inset:0;border-radius:50%;border:4px solid {t['muted']};border-top-color:transparent}}
.ok{{position:absolute;inset:0;color:#3ccf91;font-weight:900;font-size:30px;line-height:32px;opacity:0}}
.done{{margin-top:40px;font-size:44px;line-height:1.4;opacity:0;animation:fade .35s ease-out {t_done:.2f}s forwards}}
.card{{position:absolute;left:{CARD['left']}px;top:{CARD['top']}px;width:{CARD['width']}px;height:{CARD['height']}px;border-radius:36px;background:#000;border:4px solid {t['accent']};box-shadow:0 40px 120px #000c;opacity:0;transform:scale(.6);animation:popin .45s cubic-bezier(.2,.9,.3,1.2) {t_done+1.2:.2f}s forwards}}
.dim{{position:absolute;inset:0;background:#000;opacity:0;animation:dimin .4s ease-out {t_done+1.1:.2f}s forwards}}
.cardlabel{{position:absolute;left:{CARD['left']}px;top:{CARD['top']+CARD['height']+16}px;width:{CARD['width']}px;text-align:center;font-size:34px;color:#fff;opacity:0;animation:fade .35s ease-out {t_done+1.4:.2f}s forwards}}
.input{{position:absolute;left:54px;right:54px;bottom:70px;min-height:180px;border-radius:36px;background:{t['panel']};border:3px solid {t['accent'] if theme=='kazi' else '#ffffff14'};padding:30px 36px;font-size:40px;line-height:1.35;animation:clear .01s linear 3.2s forwards}}
.input .chips{{display:flex;gap:12px;margin-bottom:14px}} .input .chip{{opacity:0;animation:fade .25s ease-out forwards}}
.type{{display:inline-block;overflow:hidden;white-space:normal;color:{t['text']}}}
.type span{{opacity:0;animation:fade .01s linear forwards}}
@keyframes fade{{to{{opacity:1}}}} @keyframes rot{{to{{transform:rotate(360deg)}}}}
@keyframes out{{to{{opacity:0}}}}
@keyframes clear{{to{{opacity:0}}}} @keyframes popin{{to{{opacity:1;transform:none}}}} @keyframes dimin{{to{{opacity:.72}}}}
</style>
<div class="top">{t['mark']}<b>{t['name']}</b></div>
<div class="chat">
  <div class="user"><div class="chips">{chips}</div>{typed}</div>
  <div class="asst">{H.escape(reply)}</div>
  {rows}
  <div class="done">{H.escape(done)}</div>
</div>
<div class="dim"></div><div class="card"></div><div class="cardlabel">{H.escape(card_label)}</div>
<div class="input"><div class="chips">{''.join(f'<span class="chip" style="animation-delay:{0.3+i*0.15:.2f}s">🎬 {H.escape(f)}</span>' for f in files)}</div>
<div class="type">{''.join(f'<span style="animation-delay:{0.9+i*(2.1/n):.3f}s">{H.escape(c)}</span>' for c in prompt)}</div></div>
'''

if __name__ == '__main__':
    spec = json.load(open(sys.argv[1]))
    print(build(**spec))
