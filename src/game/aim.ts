// Aim and field-of-view math, kept pure so `npm test` can check it.
const DEG = Math.PI / 180;

/** Aiming magnifies the view by a fixed factor (fps-shooter skill), instead of "hip FOV minus 16°". */
export const AIM_ZOOM = 1.35;

/** Vertical FOV while aiming, for a given hip-fire vertical FOV. */
export function aimFov(hipFov: number): number {
  return (2 * Math.atan(Math.tan((hipFov * DEG) / 2) / AIM_ZOOM)) / DEG;
}

/**
 * Look-speed scale for the current zoom: tan(fov/2) / tan(hipFov/2). A mouse movement then sweeps the same
 * fraction of the screen whether aiming or not, and the scale follows the zoom as it eases in.
 */
export function lookScale(currentFov: number, hipFov: number): number {
  return Math.tan((currentFov * DEG) / 2) / Math.tan((hipFov * DEG) / 2);
}

/** three.js FOV is vertical; most PC shooters show horizontal. */
export function horizontalFov(verticalFov: number, aspect = 16 / 9): number {
  return (2 * Math.atan(Math.tan((verticalFov * DEG) / 2) * aspect)) / DEG;
}
