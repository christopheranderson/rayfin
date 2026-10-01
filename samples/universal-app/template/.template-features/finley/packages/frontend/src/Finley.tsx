import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import { FabricAppMark } from './FabricAppMark';
import type { WelcomeCompanionProps } from './Welcome';
import {
  AREAS,
  type ActivityChange,
  type AreaFamily,
} from './Welcome.activity';
import './Finley.css';

const STOPS = ['idle', 'look', 'build', 'peek', 'wave'] as const;
type Stop = (typeof STOPS)[number];
type Greeting = 'wave' | 'hop' | 'wink' | 'sparkle' | 'celebrate';
interface Scene {
  id: number;
  behavior: Stop | 'walk';
  stop: Stop;
  from: AreaFamily;
  to: AreaFamily;
  duration: number;
  change?: ActivityChange;
}

function visitChange(scene: Scene, change: ActivityChange): Scene {
  return {
    id: scene.id + 1,
    behavior: 'walk',
    stop: 'build',
    from: scene.to,
    to: change.family,
    duration: 1600,
    change,
  };
}

function nextScene(
  scene: Scene,
  live: boolean,
  queue: ActivityChange[]
): Scene {
  if (scene.behavior === 'walk') {
    return {
      ...scene,
      id: scene.id + 1,
      behavior: scene.stop,
      from: scene.to,
      duration: 1400,
    };
  }
  if (scene.behavior === 'build') {
    return {
      ...scene,
      id: scene.id + 1,
      behavior: 'look',
      from: scene.to,
      duration: 700,
    };
  }
  const change = queue.shift();
  if (change) return visitChange(scene, change);
  if (live) {
    return {
      ...scene,
      id: scene.id + 1,
      behavior: 'wave',
      stop: 'idle',
      from: scene.to,
      duration: 3500,
      change: undefined,
    };
  }
  const choices = STOPS.filter((stop) => stop !== scene.stop);
  const stop = choices[Math.floor(Math.random() * choices.length)];
  const places = AREAS.filter((area) => area.family !== scene.to);
  return {
    id: scene.id + 1,
    behavior: 'walk',
    stop,
    from: scene.to,
    to: places[Math.floor(Math.random() * places.length)].family,
    duration: 1800,
  };
}

export function Finley({
  activity,
  anchors,
  lane,
  phase,
  paused,
  reducedMotion,
  visible,
  onActiveChange,
  onInteractionChange,
}: WelcomeCompanionProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const greeted = hovered || focused;
  const moving = !reducedMotion && !paused && visible && !greeted;
  const [scene, setScene] = useState<Scene>({
    id: 0,
    behavior: 'idle',
    stop: 'idle',
    from: 'screens',
    to: 'screens',
    duration: 2600,
  });
  const remaining = useRef<{ id: number; time: number } | null>(null);
  const seen = useRef(new Set<string>());
  const queue = useRef<ActivityChange[]>([]);
  const activityRef = useRef(activity);
  const previousPhase = useRef(phase);
  const [greeting, setGreeting] = useState<{
    kind: Greeting;
    id: number;
  } | null>(null);
  const greetingId = useRef(0);
  const lastClick = useRef<Greeting | undefined>(undefined);
  const sayHello = useCallback((kind: Greeting) => {
    setGreeting({ kind, id: ++greetingId.current });
  }, []);

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);
  useEffect(() => {
    onActiveChange(scene.change);
  }, [scene.change, onActiveChange]);
  useEffect(() => {
    onInteractionChange(greeted);
    return () => onInteractionChange(false);
  }, [greeted, onInteractionChange]);
  useEffect(() => {
    const resetHover = () => setHovered(false);
    document.addEventListener('visibilitychange', resetHover);
    return () => document.removeEventListener('visibilitychange', resetHover);
  }, []);

  useEffect(() => {
    if (!activity) {
      queue.current = [];
      return;
    }
    for (const change of [...activity.changes].reverse()) {
      if (seen.current.has(change.id)) continue;
      seen.current.add(change.id);
      if (Date.parse(activity.generatedAt) - Date.parse(change.at) > 15_000)
        continue;
      queue.current = queue.current.filter(
        (pending) => pending.family !== change.family
      );
      queue.current.push(change);
    }
    if (seen.current.size > 100)
      seen.current = new Set([...seen.current].slice(-60));
    if (!moving || ['walk', 'build', 'look'].includes(scene.behavior)) return;
    const change = queue.current.shift();
    if (change) setScene(visitChange(scene, change));
  }, [activity, moving, scene]);

  useEffect(() => {
    if (!moving) return;
    const duration =
      remaining.current?.id === scene.id
        ? remaining.current.time
        : scene.duration;
    const started = globalThis.performance.now();
    let finished = false;
    const timer = window.setTimeout(() => {
      finished = true;
      remaining.current = null;
      setScene(nextScene(scene, !!activityRef.current, queue.current));
    }, duration);
    return () => {
      if (!finished)
        remaining.current = {
          id: scene.id,
          time: Math.max(
            0,
            duration - (globalThis.performance.now() - started)
          ),
        };
      window.clearTimeout(timer);
    };
  }, [moving, scene]);

  useEffect(() => {
    if (!greeting) return;
    const timer = window.setTimeout(() => setGreeting(null), 900);
    return () => window.clearTimeout(timer);
  }, [greeting]);

  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (!activity && !reducedMotion && !paused && visible)
      sayHello('celebrate');
  }, [phase, activity, paused, reducedMotion, visible, sayHello]);

  const home = anchors.screens ?? { x: 0, y: 0 };
  const from = reducedMotion ? home : (anchors[scene.from] ?? home);
  const to = reducedMotion ? home : (anchors[scene.to] ?? home);

  return (
    <div
      className="app-welcome__trail"
      data-greeting={greeted && !paused && visible}
    >
      <div
        key={scene.id}
        className="app-welcome__path"
        style={
          {
            '--from-x': `${from.x}px`,
            '--to-x': `${to.x}px`,
            '--from-y': `${from.y}px`,
            '--to-y': `${to.y}px`,
            '--via-x': `${from.y === to.y ? (from.x + to.x) / 2 : lane}px`,
            '--scene-duration': `${scene.duration}ms`,
          } as CSSProperties
        }
      >
        <button
          type="button"
          className="app-welcome__traveler"
          aria-label="Finley, your app builder. Say hello"
          title="Say hello to Finley"
          data-behavior={reducedMotion ? 'idle' : scene.behavior}
          data-carrying={
            scene.stop === 'build' &&
            (scene.behavior === 'walk' || scene.behavior === 'build')
          }
          data-edge={scene.to === 'screens' ? 'left' : 'right'}
          data-target={reducedMotion ? 'screens' : scene.to}
          data-reaction={greeting?.kind ?? 'none'}
          onPointerEnter={() => {
            setHovered(true);
            sayHello(reducedMotion || paused ? 'wink' : 'wave');
          }}
          onPointerLeave={() => setHovered(false)}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) {
              setFocused(true);
              sayHello(reducedMotion || paused ? 'wink' : 'wave');
            }
          }}
          onBlur={() => setFocused(false)}
          onPointerDown={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setFocused(true);
          }}
          onClick={() => {
            const choices: Greeting[] = ['hop', 'wink', 'sparkle'];
            const available = choices.filter(
              (kind) => kind !== lastClick.current
            );
            const kind =
              reducedMotion || paused
                ? 'wink'
                : available[Math.floor(Math.random() * available.length)];
            lastClick.current = kind;
            sayHello(kind);
          }}
        >
          <span className="app-welcome__character" aria-hidden="true">
            <span key={greeting?.id ?? 'rest'} className="app-welcome__gesture">
              <FabricAppMark />
              <span className="app-welcome__eyes">
                <i />
                <i />
              </span>
              <span className="app-welcome__smile" />
              <span className="app-welcome__hand" />
              <span className="app-welcome__feet">
                <i />
                <i />
              </span>
              <span className="app-welcome__parcel" />
              <span className="app-welcome__hammer" />
              <span className="app-welcome__twinkles">
                <i />
                <i />
                <i />
              </span>
            </span>
          </span>
          <span className="app-welcome__thought" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="app-welcome__character-shadow" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
