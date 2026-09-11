import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from './bridge';
import impulseLogo from './generated/impulse-logo.png';

export type CrashWheelResult = { required: boolean; sector: number; crash: boolean; duration_ms: number; start_delay_ms?: number; passed?: boolean; mercy?: boolean };

const sectors = [
  { label: 'CRASH', color: '#ca4b61' },
  { label: 'PLAY', color: '#218777' },
  { label: 'CRASH', color: '#923f66' },
  { label: 'PLAY', color: '#306f99' },
  { label: 'CRASH', color: '#b54e42' },
];

function point(angle: number, radius: number) {
  const radians = (angle - 90) * Math.PI / 180;
  return [260 + radius * Math.cos(radians), 260 + radius * Math.sin(radians)];
}

// Keep the wheel artwork static; only its containing layer rotates.
const WheelArtwork = memo(function WheelArtwork({ mercy }: { mercy: boolean }) {
  return <svg viewBox="0 0 520 520" aria-hidden="true">
    {sectors.map((sector, index) => {
      const start = point(index * 72, 224);
      const end = point((index + 1) * 72, 224);
      return <g key={index}>
        <path d={`M260 260 L${start.join(' ')} A224 224 0 0 1 ${end.join(' ')} Z`} fill={sector.color} stroke="#eedba3" strokeWidth="2" />
        <g transform={`rotate(${index * 72 + 36} 260 260)`}>
          <text x="260" y="98" textAnchor="middle" className="wheel-sector-label">{mercy ? 'PLAY' : sector.label}</text>
          <path d="M260 120 L264 128 L260 136 L256 128 Z" fill="#fff2d1" opacity=".65" />
        </g>
      </g>;
    })}
    <circle cx="260" cy="260" r="214" fill="none" stroke="#fff" strokeOpacity=".14" />
  </svg>;
});

const WheelRim = memo(function WheelRim() {
  return <svg className="wheel-rim" viewBox="0 0 520 520" aria-hidden="true">
    <defs>
      <linearGradient id="wheel-metal" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#fff0bd" /><stop offset=".45" stopColor="#9d7940" /><stop offset=".72" stopColor="#ead399" /><stop offset="1" stopColor="#74552c" />
      </linearGradient>
    </defs>
    <circle cx="260" cy="260" r="249" fill="none" stroke="url(#wheel-metal)" strokeWidth="15" />
    <circle cx="260" cy="260" r="237" fill="none" stroke="#292628" strokeWidth="18" />
    <circle cx="260" cy="260" r="225" fill="none" stroke="#f1d9a0" strokeWidth="4" />
    {Array.from({ length: 40 }, (_, index) => {
      const [x, y] = point(index * 9, 240);
      return <circle key={index} cx={x} cy={y} r="3.4" fill={index % 2 ? '#d7b773' : '#fff6cf'} />;
    })}
  </svg>;
});

export function CrashWheel({ round, onSurvived, onError }: { round: CrashWheelResult; onSurvived: () => Promise<void>; onError: (message: string) => void }) {
  const [remaining, setRemaining] = useState(Math.ceil(round.duration_ms / 1000));
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const callbacks = useRef({ onSurvived, onError });
  const screen = useRef<HTMLDivElement>(null);
  const endRotation = (round.mercy ? 3 : 7) * 360 - (round.sector * 72 + 36);
  const startDelay = round.start_delay_ms ?? 2000;
  useEffect(() => { callbacks.current = { onSurvived, onError }; }, [onSurvived, onError]);
  useEffect(() => {
    screen.current?.focus();
    let started = 0;
    let active = true;
    let ticker: number | undefined;
    let reveal: number | undefined;
    let finish: number | undefined;
    const begin = window.setTimeout(() => {
      started = performance.now();
      setSpinning(true);
      ticker = window.setInterval(() => setRemaining(Math.max(0, Math.ceil((round.duration_ms - (performance.now() - started)) / 1000))), 1000);
      reveal = window.setTimeout(() => {
        window.clearInterval(ticker);
        setRemaining(0);
        setRevealed(true);
        finish = window.setTimeout(async () => {
          try {
            const result = await invoke<{ crash: boolean }>('completeCrashWheel');
            if (active && !result.crash) await callbacks.current.onSurvived();
          } catch (reason) {
            if (active) callbacks.current.onError(reason instanceof Error ? reason.message : String(reason));
          }
        }, 1000);
      }, round.duration_ms);
    }, startDelay);
    return () => {
      active = false;
      window.clearTimeout(begin);
      window.clearInterval(ticker);
      window.clearTimeout(reveal);
      window.clearTimeout(finish);
    };
  }, [round.duration_ms, startDelay]);

  return <div ref={screen} tabIndex={-1} className={`crash-wheel-screen ${revealed ? (round.crash ? 'lost' : 'won') : spinning ? 'spinning' : 'waiting'}`} aria-labelledby="crash-wheel-title">
    <header>
      <div className="brand"><span className="brand-mark"><img src={impulseLogo} alt="" /></span><strong>IMPULSE</strong></div>
      <span className="wheel-edition">A little luck. A lot of suspense.</span>
    </header>
    <main>
      <div className="crash-wheel-copy">
        <p className="wheel-kicker">{round.mercy ? 'The Crash Wheel' : "You've been selected for"}</p>
        <h1 id="crash-wheel-title">{round.mercy ? "I'm not that sadic." : 'The Crash Wheel'}</h1>
      </div>
      <div className="wheel-stage" style={{ '--wheel-end': `${endRotation}deg`, '--wheel-duration': `${round.duration_ms}ms` } as CSSProperties}>
        <div className="wheel-rotor"><WheelArtwork mercy={!!round.mercy} /></div>
        <WheelRim />
        <div className="wheel-hub"><img src={impulseLogo} alt="" /></div>
        <div className="wheel-pointer" />
        {revealed && !round.crash && <div className="wheel-confetti" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => <i key={index} style={{ '--angle': `${index * 30}deg`, '--confetti-color': ['#f1d9a0', '#61c4b3', '#f0f0ef'][index % 3] } as CSSProperties} />)}
        </div>}
      </div>
      <div className="wheel-result" role="status" aria-live="polite" aria-atomic="true">
        <div className="wheel-countdown" aria-hidden="true">{revealed ? (round.crash ? '0' : 'GO') : spinning ? String(remaining).padStart(2, '0') : '--'}</div>
        <div>
          <strong>{revealed ? (round.crash ? 'Crash! Better luck next launch.' : "You survived. Let's play!") : spinning ? 'The wheel is spinning.' : 'Get ready.'}</strong>
          <p>{revealed ? (round.crash ? 'Closing Minecraft...' : 'Preparing your server...') : spinning ? 'Your luck is about to land.' : 'Your spin is about to begin.'}</p>
        </div>
      </div>
    </main>
  </div>;
}
