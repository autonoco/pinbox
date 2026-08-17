// @autono/pinbox-toolbar — spring physics for the minimize morph.
// Multi-property damped spring (semi-implicit Euler), substepped so a large
// frame gap — a throttled background tab, a slow device — can never
// destabilize the integration. Values match the validated prototype
// (docs/design/toolbar/v3-minimize.html): morph 300/30, pointer-follow 600/38.

export interface SpringConfig {
  /** Stiffness. */
  k: number;
  /** Damping. */
  c: number;
}

/** Bar ⇄ puck morphs and the post-drag settle. */
export const MORPH_SPRING: SpringConfig = { k: 300, c: 30 };
/** The morph surface chasing the pointer mid-drag. */
export const FOLLOW_SPRING: SpringConfig = { k: 600, c: 38 };

/** Integration substep — small enough that MORPH/FOLLOW stay stable at any dt. */
const SUBSTEP = 1 / 240;
/** A property this close to target, moving this slowly, counts as settled. */
const SETTLE = 0.5;

export interface Spring<T extends Record<string, number>> {
  readonly cur: T;
  readonly tgt: T;
  /** Teleport: current, target, and velocity all jump to the given values. */
  snap(values: Partial<T>): void;
  /** Retarget, optionally switching the spring's feel. */
  to(values: Partial<T>, cfg?: SpringConfig): void;
  /** Advance by dt seconds. Returns true once every property has settled. */
  step(dt: number): boolean;
}

export function mkSpring<T extends Record<string, number>>(init: T): Spring<T> {
  const cur = { ...init };
  const tgt = { ...init };
  const keys = Object.keys(init);
  const vel: Record<string, number> = {};
  for (const key of keys) vel[key] = 0;
  let cfg: SpringConfig = { ...MORPH_SPRING };
  // The generic view is for callers; integration works on plain number maps.
  const curN = cur as Record<string, number>;
  const tgtN = tgt as Record<string, number>;

  function integrate(h: number): void {
    for (const key of keys) {
      const x = curN[key] ?? 0;
      const v = vel[key] ?? 0;
      const force = -cfg.k * (x - (tgtN[key] ?? 0)) - cfg.c * v;
      const nextV = v + force * h;
      vel[key] = nextV;
      curN[key] = x + nextV * h;
    }
  }

  return {
    cur,
    tgt,
    snap(values) {
      Object.assign(cur, values);
      Object.assign(tgt, values);
      for (const key of Object.keys(vel)) vel[key] = 0;
    },
    to(values, nextCfg) {
      Object.assign(tgt, values);
      if (nextCfg) cfg = { ...nextCfg };
    },
    step(dt) {
      let remaining = dt;
      while (remaining > 1e-6) {
        const h = Math.min(SUBSTEP, remaining);
        remaining -= h;
        integrate(h);
      }
      for (const key of keys) {
        const v = vel[key] ?? 0;
        const gap = (curN[key] ?? 0) - (tgtN[key] ?? 0);
        if (Math.abs(v) > SETTLE || Math.abs(gap) > SETTLE) return false;
      }
      this.snap({ ...tgt });
      return true;
    },
  };
}
