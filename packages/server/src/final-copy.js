// The Download control the player and the editor share: a watermarked file downloads as the final
// copy (the watermark removed with export.release, which spends its release_credits once) or as
// the review copy (watermarked, free). The user's click on "Download final", with the price shown
// beside their balance, is their go-ahead. A file without the watermark downloads as it is.
// player.ts inlines it at the top of each view's script; it defines window.cfFinalCopy.
(() => {
  const CSS = `
  .fc { position: relative; display: inline-flex; }
  .fc .fc-go { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .fc .fc-go .fc-price { font-weight: 500; opacity: .75; }
  .fc .fc-more { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 6px; margin-left: 1px; }
  .fc.plain .fc-go { border-radius: inherit; }
  .fc.plain .fc-more { display: none; }
  .fc .fc-go[aria-busy="true"] { cursor: progress; }
  .fc-menu { position: fixed; z-index: 50; width: min(300px, calc(100vw - 16px)); padding: 6px; border-radius: 12px;
    background: var(--card, #1b1b1f); color: var(--fg, #f2f2f3); border: 1px solid var(--line, rgba(255,255,255,.12));
    box-shadow: 0 12px 32px rgba(0,0,0,.35); font: 13px/1.4 var(--font, system-ui, sans-serif); text-align: left; }
  .fc-menu[hidden] { display: none; }
  .fc-opt { display: grid; grid-template-columns: 18px 1fr; gap: 2px 8px; align-items: start; padding: 8px; border-radius: 8px; cursor: pointer; }
  .fc-opt:hover { background: var(--card-2, rgba(255,255,255,.06)); }
  .fc-opt input { margin: 2px 0 0; accent-color: var(--accent, #7c5cff); }
  .fc-opt b { font-weight: 600; }
  .fc-opt span { grid-column: 2; color: var(--muted, #a1a1aa); font-size: 12px; }
  .fc-opt.off { cursor: default; }
  .fc-opt.off b { opacity: .6; }
  .fc-buy { grid-column: 2; justify-self: start; margin-top: 2px; padding: 0; border: 0; background: none; color: var(--accent, #7c5cff); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .fc-why { margin: 2px 8px 6px; padding-top: 8px; border-top: 1px solid var(--line, rgba(255,255,255,.12)); color: var(--muted, #a1a1aa); font-size: 12px; }
  .fc-why summary { cursor: pointer; color: var(--fg, #f2f2f3); list-style: none; }
  .fc-why summary::-webkit-details-marker { display: none; }
  .fc-why p { margin: 6px 0 0; }`;

  const CARET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const ACCOUNT = 'https://cuttingfloor.ai/account';

  const n = (x) => String(Math.round(x * 100) / 100);
  const credits = (x) => `${n(x)} credit${x > 0 && x <= 1 ? '' : 's'}`;

  /** What export.release takes for this file: its media, or the job its signed link names. */
  function releaseRef(file) {
    if (file.media_id) return { media_id: file.media_id };
    const job = /\/(j_[0-9a-z]{26})(?:\/|$)/.exec(
      `${file.uri || ''} ${file.url ? new URL(file.url).pathname : ''}`,
    );
    return job ? { job_id: job[1] } : null;
  }

  /**
   * o: { btnClass, icon (download svg), callTool(name, args) → structuredContent (throws on an
   * error result), save(file) downloads it, openLink(url), toast(text), onReleased(file) }.
   * Returns { node, set(file) }.
   */
  window.cfFinalCopy = function finalCopy(o) {
    if (!document.getElementById('fc-css')) {
      const s = document.createElement('style');
      s.id = 'fc-css';
      s.textContent = CSS;
      document.head.append(s);
    }
    const node = document.createElement('div');
    node.className = 'fc plain';
    node.innerHTML = `
      <button class="${o.btnClass} fc-go" type="button">${o.icon}<span class="lbl">Download</span></button>
      <button class="${o.btnClass} fc-more" type="button" aria-haspopup="true" aria-expanded="false" title="Final or review copy">${CARET}</button>`;
    const menu = document.createElement('div');
    menu.className = 'fc-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Which copy to download');
    document.body.append(menu);
    const go = node.querySelector('.fc-go');
    const more = node.querySelector('.fc-more');
    const lbl = go.querySelector('.lbl');

    let file = null;
    let choice = 'final';
    let busy = false;

    const price = () => file?.release_credits ?? 0;
    const left = () => file?.credits_left;
    const marked = () => Boolean(file?.watermarked && releaseRef(file));
    const affords = () => left() === null || left() === undefined || left() >= price();

    function paint() {
      const m = marked();
      node.classList.toggle('plain', !m);
      go.disabled = !file || busy;
      more.disabled = !file || busy;
      if (busy) return;
      if (!m) {
        lbl.textContent = 'Download';
        go.title = file?.watermarked ? 'Download the file (watermarked)' : 'Download the file';
        return;
      }
      if (choice === 'final') {
        lbl.innerHTML = `Download final <span class="fc-price">· ${n(price())}</span>`;
        go.title = `Removes the watermark for ${credits(price())}${typeof left() === 'number' ? ` (you have ${n(left())})` : ''}, then downloads`;
      } else {
        lbl.textContent = 'Download review';
        go.title = 'Download the watermarked copy, free';
      }
    }

    function paintMenu() {
      const have = left();
      const cost =
        have === null
          ? `${credits(price())} · no credit cap`
          : typeof have === 'number'
            ? have < price()
              ? `${credits(price())} · you have ${n(have)}`
              : `${n(price())} of your ${credits(have)}`
            : credits(price());
      const short = !affords();
      menu.innerHTML = `
        <label class="fc-opt${short ? ' off' : ''}"><input type="radio" name="fc-copy" value="final"${choice === 'final' ? ' checked' : ''}${short ? ' disabled' : ''}>
          <b>Final copy</b><span>No watermark · ${cost}</span>
          ${short ? '<button class="fc-buy" type="button">Get credits</button>' : ''}</label>
        <label class="fc-opt"><input type="radio" name="fc-copy" value="review"${choice === 'review' ? ' checked' : ''}>
          <b>Review copy</b><span>Watermarked · free</span></label>
        <details class="fc-why"><summary>What's the difference?</summary>
          <p>The review copy is for watching and sharing for feedback, so it carries a small cuttingfloor mark. The final copy is the one to post: it uses 1 credit a finished minute, once, and after that every link to this file is clean.</p></details>`;
      for (const r of menu.querySelectorAll('input')) {
        r.onchange = () => {
          choice = r.value;
          paint();
          close();
        };
      }
      menu.querySelector('details').ontoggle = place;
      const buy = menu.querySelector('.fc-buy');
      if (buy)
        buy.onclick = (e) => {
          e.preventDefault();
          o.openLink(ACCOUNT);
        };
    }

    function place() {
      const r = more.getBoundingClientRect();
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
      // Below the button when it fits, else above it (the player's strip sits at the bottom).
      const below = r.bottom + 6 + h <= window.innerHeight;
      menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    }
    function open() {
      paintMenu();
      menu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      place();
    }
    function close() {
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }
    more.onclick = (e) => {
      e.stopPropagation();
      menu.hidden ? open() : close();
    };
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) close();
    });
    window.addEventListener('resize', () => {
      if (!menu.hidden) place();
    });

    go.onclick = async () => {
      if (!file || busy) return;
      if (!marked() || choice === 'review') return o.save(file);
      busy = true;
      go.setAttribute('aria-busy', 'true');
      lbl.textContent = 'Removing watermark…';
      paint();
      try {
        const r = await o.callTool('export.release', releaseRef(file));
        file = {
          ...file,
          url: r.url,
          page_url: r.page_url,
          expires_at: r.expires_at,
          watermarked: false,
        };
        delete file.release_credits;
        delete file.watermark_note;
        file.credits_left = r.balance;
        o.toast(r.credits ? `Watermark removed: ${credits(r.credits)} used` : 'Watermark removed');
        o.onReleased?.(file);
        o.save(file);
      } catch (e) {
        o.toast(String(e?.message || 'The watermark could not be removed').split('\n')[0]);
        if (/credit|quota/i.test(String(e?.message))) choice = 'review';
      } finally {
        busy = false;
        go.removeAttribute('aria-busy');
        paint();
      }
    };

    return {
      node,
      // Called again whenever the view repaints: the choice resets only for a different file.
      set(f) {
        const fresh = (f?.url || null) !== (file?.url || null);
        file = f || null;
        if (fresh) {
          if (file?.watermarked) choice = affords() ? 'final' : 'review';
          close();
        }
        if (!busy) paint();
      },
    };
  };
})();
