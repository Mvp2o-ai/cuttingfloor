'use client';

import { useEffect, useRef, useState } from 'react';
import { canRecord, clock, openMicrophone, recordingName, refusal } from './recording.ts';

// Record on the upload page: record from the microphone, listen back, record again, send. Nothing
// leaves the device until Send, which hands the recording to the page as a file, sent like any
// dropped file. A hum, a tapped rhythm, a voiceover, a song playing near the phone.

type State =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'recording'; since: number }
  | { kind: 'review'; file: File; url: string; seconds: number }
  | { kind: 'refused'; text: string };

export function Record({ onSend }: { onSend: (file: File) => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [now, setNow] = useState(0);
  const [level, setLevel] = useState(0);
  const stream = useRef<MediaStream | undefined>(undefined);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const chunks = useRef<Blob[]>([]);
  const turn = useRef(0);
  const audio = useRef<AudioContext | undefined>(undefined);
  const frame = useRef(0);

  const letGo = () => {
    cancelAnimationFrame(frame.current);
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = undefined;
  };

  // The microphone is let go when the page is.
  useEffect(
    () => () => {
      turn.current++;
      cancelAnimationFrame(frame.current);
      for (const t of stream.current?.getTracks() ?? []) t.stop();
    },
    [],
  );

  useEffect(() => {
    if (state.kind !== 'recording') return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'review') return;
    return () => URL.revokeObjectURL(state.url);
  }, [state]);

  const reset = () => {
    turn.current++;
    letGo();
    if (recorder.current && recorder.current.state !== 'inactive') {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    recorder.current = undefined;
    setState({ kind: 'idle' });
  };

  async function start() {
    const mine = ++turn.current;
    const can = await canRecord();
    if (mine !== turn.current) return;
    if (can !== 'ok') return setState({ kind: 'refused', text: refusal(can) });
    setState({ kind: 'asking' });
    let got: MediaStream;
    try {
      got = await openMicrophone();
    } catch (error) {
      if (mine === turn.current)
        setState({ kind: 'refused', text: refusal((error as Error).name) });
      return;
    }
    if (mine !== turn.current) {
      for (const t of got.getTracks()) t.stop();
      return;
    }
    stream.current = got;
    chunks.current = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(got);
    } catch {
      letGo();
      return setState({ kind: 'refused', text: refusal('missing') });
    }
    recorder.current = rec;
    const since = Date.now();
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      if (mine !== turn.current) return;
      letGo();
      const type = rec.mimeType || chunks.current[0]?.type || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      const file = new File([blob], recordingName(type, new Date()), { type });
      setState({
        kind: 'review',
        file,
        url: URL.createObjectURL(blob),
        seconds: (Date.now() - since) / 1000,
      });
    };
    rec.start(1000);
    setNow(since);
    setState({ kind: 'recording', since });
    try {
      audio.current ??= new AudioContext();
      const analyser = audio.current.createAnalyser();
      analyser.fftSize = 1024;
      audio.current.createMediaStreamSource(got).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const draw = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const x of data) sum += x * x;
        const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-6);
        setLevel(Math.max(0, Math.min(100, ((db + 60) / 60) * 100)));
        frame.current = requestAnimationFrame(draw);
      };
      draw();
    } catch {}
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  const send = () => {
    if (state.kind !== 'review' || !state.file.size) return;
    const { file } = state;
    turn.current++;
    setState({ kind: 'idle' });
    onSend(file);
  };

  if (state.kind === 'idle') {
    return (
      <div className="rec-also">
        <button type="button" className="rec-start" id="record" onClick={start}>
          <i aria-hidden="true" />
          Record a sound
        </button>
        <span>A hum, a beat, your voice, a song playing nearby</span>
      </div>
    );
  }
  return (
    <section className="rec-panel" data-state={state.kind} aria-label="Record">
      {state.kind === 'asking' ? (
        <>
          <strong>Record</strong>
          <p role="status">Allow the microphone to start recording.</p>
          <div className="rec-row">
            <button type="button" className="link" onClick={reset}>
              Cancel
            </button>
          </div>
        </>
      ) : state.kind === 'recording' ? (
        <>
          <strong className="rec-live">
            <i aria-hidden="true" />
            Recording <span className="rec-time">{clock((now - state.since) / 1000)}</span>
          </strong>
          <div className="rec-level" aria-hidden="true">
            <span style={{ width: `${level}%` }} />
          </div>
          <div className="rec-row">
            <button type="button" className="rec-stop" onClick={stop}>
              Stop
            </button>
            <button type="button" className="link" onClick={reset}>
              Cancel
            </button>
          </div>
        </>
      ) : state.kind === 'review' ? (
        <>
          <strong>
            Your recording <span className="rec-time">{clock(state.seconds)}</span>
          </strong>
          {/* biome-ignore lint/a11y/useMediaCaption: the person's own recording, just made */}
          <audio controls src={state.url} preload="auto" />
          <div className="rec-row">
            <button type="button" className="rec-again" onClick={start}>
              Record again
            </button>
            <button type="button" className="rec-send" onClick={send} disabled={!state.file.size}>
              Send
            </button>
          </div>
        </>
      ) : (
        <>
          <strong>Record</strong>
          <p role="status">{state.text}</p>
          <div className="rec-row">
            <button type="button" className="rec-send" onClick={start}>
              Try again
            </button>
            <button type="button" className="link" onClick={reset}>
              Back
            </button>
          </div>
        </>
      )}
    </section>
  );
}
