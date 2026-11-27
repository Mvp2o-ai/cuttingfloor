// The Record control the upload box and the upload page share: record from the microphone, listen
// back, redo, send. Nothing leaves the device until Send, which hands the recording to the page as
// a file, sent like any picked file. It records what the browser records (WebM/Opus in Chrome,
// Ogg/Opus in Firefox, MP4/AAC in Safari), with the browser's voice processing off so a hum or a
// song near the phone comes through as it sounds. Where the microphone is not open to the page (a
// chat app's frame that does not allow it, or no recorder at all) it says so and offers the
// page's fallback: the upload page in the browser, which records.
// upload.ts and the upload page inline it; it defines window.cfRecorder.
(() => {
  const CSS = `
  .cfr { --cfr-key: var(--key, var(--accent, #12b84a)); --cfr-mute: var(--mute, var(--muted, #8f887c)); --cfr-line: var(--rule-2, var(--line, #3a362f)); --cfr-red: var(--red, #e0573f);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 150px; padding: 16px; border: 1.5px solid var(--cfr-line); border-radius: 12px; background: var(--bg-2, transparent); text-align: center; }
  .cfr-top { display: flex; align-items: center; gap: 8px; font-size: 15px; }
  .cfr-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--cfr-red); flex: none; }
  .cfr[data-state="recording"] .cfr-dot { animation: cfr-blink 1s steps(2, start) infinite; }
  .cfr[data-state="review"] .cfr-dot, .cfr[data-state="asking"] .cfr-dot, .cfr[data-state="refused"] .cfr-dot { background: var(--cfr-mute); }
  @keyframes cfr-blink { to { visibility: hidden; } }
  .cfr-time { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; color: var(--cfr-mute); }
  .cfr-level { width: min(240px, 100%); height: 6px; border-radius: 6px; background: var(--cfr-line); overflow: hidden; }
  .cfr-level i { display: block; height: 100%; width: 0; background: var(--cfr-key); transition: width .08s linear; }
  .cfr-say { margin: 0; color: var(--cfr-mute); font-size: 12.5px; max-width: 340px; }
  .cfr-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  .cfr button { font: inherit; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 16px; border-radius: 9px; cursor: pointer;
    color: inherit; background: none; border: 1.5px solid var(--cfr-line); }
  .cfr button.go { background: var(--cfr-key); border-color: var(--cfr-key); color: #04170a; }
  .cfr button.stop { background: var(--cfr-red); border-color: var(--cfr-red); color: #fff; }
  .cfr button.quiet { border: 0; padding: 0 8px; font-weight: 500; color: var(--cfr-mute); text-decoration: underline; text-underline-offset: 2px; }
  .cfr button:focus-visible { outline: 2px solid var(--cfr-key); outline-offset: 2px; }
  .cfr button[disabled] { opacity: .55; cursor: default; }`;

  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const stamp = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };
  /** The file's extension, from what the browser says it recorded. */
  const extension = (type) =>
    /mp4|aac|m4a/i.test(type)
      ? '.m4a'
      : /ogg/i.test(type)
        ? '.ogg'
        : /mpeg/i.test(type)
          ? '.mp3'
          : '.webm';

  /** Whether this page can record at all: the recorder exists and the frame allows the microphone. */
  async function available() {
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function')
      return 'missing';
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature('microphone')) return 'blocked';
    try {
      const state = (await navigator.permissions?.query({ name: 'microphone' }))?.state;
      if (state === 'denied') return 'denied';
    } catch {}
    return 'ok';
  }

  /**
   * panel: the element the recorder fills. opts.send(file) takes the recording. opts.shown(on)
   * says when the panel takes the place of the page's own controls. opts.fallback, where there is
   * somewhere else to record: { label, say, open() }. opts.maxBytes(): the most the upload takes.
   */
  window.cfRecorder = (panel, opts) => {
    if (!document.getElementById('cfr-css')) {
      const style = document.createElement('style');
      style.id = 'cfr-css';
      style.textContent = CSS;
      document.head.append(style);
    }
    let state = 'idle';
    let stream;
    let rec;
    let chunks = [];
    let bytes = 0;
    let began = 0;
    let tick;
    let meter;
    let ctx;
    let take;
    let playing;
    let turn = 0;

    const el = (tag, props, kids) => {
      const node = Object.assign(document.createElement(tag), props || {});
      for (const kid of kids || []) node.append(kid);
      return node;
    };
    const button = (text, cls, onclick) =>
      el('button', { type: 'button', className: cls || '', textContent: text, onclick });

    function show(next, parts) {
      state = next;
      panel.replaceChildren();
      if (next === 'idle') {
        panel.hidden = true;
        opts.shown?.(false);
        return;
      }
      const box = el('div', { className: 'cfr', role: 'group', ariaLabel: 'Record' });
      box.dataset.state = next;
      box.append(...parts);
      panel.append(box);
      panel.hidden = false;
      opts.shown?.(true);
    }
    const top = (title, time) =>
      el('div', { className: 'cfr-top' }, [
        el('span', { className: 'cfr-dot' }),
        el('b', { textContent: title }),
        ...(time ? [time] : []),
      ]);
    const say = (text) => el('p', { className: 'cfr-say', role: 'status', textContent: text });
    const row = (...kids) => el('div', { className: 'cfr-row' }, kids);

    function release() {
      clearInterval(tick);
      cancelAnimationFrame(meter);
      for (const t of stream?.getTracks() || []) t.stop();
      stream = undefined;
      stopPlaying();
    }
    function stopPlaying() {
      try {
        playing?.stop();
      } catch {}
      playing = undefined;
    }
    function reset() {
      turn++;
      release();
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null;
        try {
          rec.stop();
        } catch {}
      }
      rec = undefined;
      chunks = [];
      take = undefined;
      show('idle');
    }

    function refused(why) {
      release();
      const text =
        why === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : why === 'NotReadableError'
            ? 'The microphone is busy in another app. Close it there and try again.'
            : opts.fallback
              ? opts.fallback.say
              : 'The microphone was not allowed. Allow it for this page in your browser’s settings, then try again.';
      const kids = [];
      if (opts.fallback) kids.push(button(opts.fallback.label, 'go', () => opts.fallback.open()));
      else kids.push(button('Try again', 'go', () => start()));
      kids.push(button('Back', 'quiet', reset));
      show('refused', [top('Record'), say(text), row(...kids)]);
      panel.querySelector('button')?.focus();
    }

    async function start() {
      if (state === 'asking' || state === 'recording') return;
      const mine = ++turn;
      stopPlaying();
      take = undefined;
      const can = await available();
      if (mine !== turn) return;
      if (can !== 'ok') return refused(can);
      show('asking', [
        top('Record'),
        say('Allow the microphone to start recording.'),
        row(button('Cancel', 'quiet', reset)),
      ]);
      let got;
      try {
        const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        got = await navigator.mediaDevices.getUserMedia({ audio: raw }).catch((error) => {
          if (error?.name === 'OverconstrainedError' || error?.name === 'TypeError')
            return navigator.mediaDevices.getUserMedia({ audio: true });
          throw error;
        });
      } catch (error) {
        if (mine === turn) refused(error?.name || 'NotAllowedError');
        return;
      }
      if (mine !== turn) {
        for (const t of got.getTracks()) t.stop();
        return;
      }
      stream = got;
      record(mine);
    }

    function record(mine) {
      chunks = [];
      bytes = 0;
      try {
        rec = new MediaRecorder(stream);
      } catch (error) {
        return refused(error?.name || 'missing');
      }
      const limit = opts.maxBytes?.() || 0;
      rec.ondataavailable = (e) => {
        if (!e.data?.size) return;
        chunks.push(e.data);
        bytes += e.data.size;
        // Stopped before it is more than the upload takes.
        if (limit && bytes > limit * 0.95 && rec?.state === 'recording') stop();
      };
      rec.onstop = () => mine === turn && review(mine);
      const time = el('span', { className: 'cfr-time', textContent: '0:00' });
      const level = el('i');
      show('recording', [
        top('Recording', time),
        el('div', { className: 'cfr-level', ariaHidden: 'true' }, [level]),
        row(button('Stop', 'stop', stop), button('Cancel', 'quiet', reset)),
      ]);
      panel.querySelector('button.stop')?.focus();
      began = Date.now();
      rec.start(1000);
      tick = setInterval(() => {
        time.textContent = clock((Date.now() - began) / 1000);
      }, 250);
      try {
        ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume?.().catch(() => {});
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const draw = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (const x of data) sum += x * x;
          const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-6);
          level.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
          meter = requestAnimationFrame(draw);
        };
        draw();
      } catch {}
    }

    function stop() {
      if (rec?.state === 'recording') rec.stop();
      clearInterval(tick);
      cancelAnimationFrame(meter);
      for (const t of stream?.getTracks() || []) t.stop();
    }

    async function review(mine) {
      release();
      const type = rec?.mimeType || chunks[0]?.type || '';
      const blob = new Blob(chunks, type ? { type } : {});
      const seconds = (Date.now() - began) / 1000;
      take = new File([blob], `recording-${stamp(new Date())}${extension(type)}`, {
        type: blob.type || 'audio/webm',
      });
      const time = el('span', { className: 'cfr-time', textContent: clock(seconds) });
      const listen = button('Listen', '', () => play(listen, time, seconds));
      show('review', [
        top('Your recording', time),
        say(
          blob.size
            ? 'Listen back, record again, or send it.'
            : 'Nothing was recorded. Record again.',
        ),
        row(
          listen,
          button('Record again', '', () => start()),
          button('Send', 'go', send),
        ),
      ]);
      if (!blob.size) panel.querySelector('button.go').disabled = true;
      panel.querySelector('button.go')?.focus();
      // Played through Web Audio, which no frame's content policy stands in the way of.
      try {
        ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (mine !== turn || take === undefined) return;
        take.buffer = buffer;
        time.textContent = clock(buffer.duration);
      } catch {
        if (mine === turn) listen.disabled = true;
      }
    }

    function play(listen, time, seconds) {
      if (playing) {
        stopPlaying();
        listen.textContent = 'Listen';
        return;
      }
      const buffer = take?.buffer;
      if (!buffer || !ctx) return;
      ctx.resume?.().catch(() => {});
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const from = ctx.currentTime;
      const shown = setInterval(() => {
        time.textContent = `${clock(ctx.currentTime - from)} / ${clock(buffer.duration || seconds)}`;
      }, 200);
      source.onended = () => {
        clearInterval(shown);
        time.textContent = clock(buffer.duration || seconds);
        if (playing === source) playing = undefined;
        listen.textContent = 'Listen';
      };
      source.start();
      playing = source;
      listen.textContent = 'Stop';
    }

    function send() {
      const file = take;
      if (!file?.size) return;
      turn++;
      stopPlaying();
      take = undefined;
      show('idle');
      opts.send(new File([file], file.name, { type: file.type }));
    }

    // A page put away mid-recording lets go of the microphone.
    window.addEventListener('pagehide', () => {
      if (state === 'recording' || state === 'asking') reset();
    });
    return {
      start,
      reset,
      get state() {
        return state;
      },
    };
  };
})();
