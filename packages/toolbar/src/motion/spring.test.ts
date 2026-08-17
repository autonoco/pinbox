// @autono/pinbox-toolbar — spring integrator tests. Pure math, no DOM.
import { describe, expect, test } from "bun:test";
import { FOLLOW_SPRING, mkSpring } from "./spring.ts";

const FRAME = 1 / 60;

function settle(spring: ReturnType<typeof mkSpring<{ x: number }>>, cap = 1000): number {
  for (let i = 1; i <= cap; i++) {
    if (spring.step(FRAME)) return i;
  }
  return cap;
}

describe("mkSpring", () => {
  test("converges to the target and snaps exactly onto it", () => {
    const spring = mkSpring({ x: 0 });
    spring.to({ x: 100 });
    const frames = settle(spring);
    expect(spring.cur.x).toBe(100);
    // MORPH (300/30) settles well under a second of simulated time.
    expect(frames).toBeLessThan(120);
  });

  test("a huge frame gap cannot destabilize the integration", () => {
    const spring = mkSpring({ x: 0, y: 0 });
    spring.to({ x: 300, y: -180 });
    // One 5-second step — a throttled tab waking up. Substepping must keep
    // this finite and settled, not oscillating or NaN.
    expect(spring.step(5)).toBe(true);
    expect(spring.cur.x).toBe(300);
    expect(spring.cur.y).toBe(-180);
  });

  test("snap teleports and zeroes velocity", () => {
    const spring = mkSpring({ x: 0 });
    spring.to({ x: 100 });
    spring.step(FRAME);
    spring.step(FRAME);
    spring.snap({ x: 0 });
    // No residual velocity: the very next step reports settled at 0.
    expect(spring.step(FRAME)).toBe(true);
    expect(spring.cur.x).toBe(0);
  });

  test("retargeting mid-flight with a different config still settles", () => {
    const spring = mkSpring({ x: 0 });
    spring.to({ x: 100 });
    for (let i = 0; i < 5; i++) spring.step(FRAME);
    spring.to({ x: 40 }, FOLLOW_SPRING);
    settle(spring);
    expect(spring.cur.x).toBe(40);
  });
});
