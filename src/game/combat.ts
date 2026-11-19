// Weapon numbers in one place, so the time-to-kill table can be checked by `npm test`.

/** Suppressed 9mm body-shot damage. */
export const BULLET_DAMAGE = 34;

/**
 * Head damage multiplier (fps-shooter skill: 2-4x). At 1.85 a Skin-Stealer (165 HP) took 4 shots with one
 * headshot and still 4 with two (63 + 63 + 34 = 160), so the second headshot was wasted.
 */
export const HEADSHOT_MULTIPLIER = 2;

export function shotDamage(isHead: boolean): number {
  return Math.round(BULLET_DAMAGE * (isHead ? HEADSHOT_MULTIPLIER : 1));
}

/** Shots needed to kill `hp` when up to `heads` of them land on the head (the rest on the body). */
export function shotsToKill(hp: number, heads: number): number {
  const head = shotDamage(true);
  const body = shotDamage(false);
  if (heads * head >= hp) return Math.ceil(hp / head);
  return heads + Math.ceil((hp - heads * head) / body);
}
