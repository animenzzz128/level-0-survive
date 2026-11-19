import { HudTip } from './types';

/** Facts about the current frame the guide may react to. */
export interface GuideContext {
  elapsed: number;
  battery: number;
  flashlightOn: boolean;
  ammoTotal: number;
  winded: boolean;
  crouched: boolean;
  tapesCollected: number;
  exitUnlocked: boolean;
  nearDoor: boolean;
  nearDesk: boolean;
  /** A non-disguised entity is within 18 m, or one is investigating / chasing. */
  somethingNear: boolean;
  howlerNear: boolean;
  smilerNear: boolean;
  skinStealerRevealed: boolean;
}

interface TipRule {
  id: string;
  /** Higher wins; a tip at least 2 higher replaces the one on screen. */
  priority: number;
  title: string;
  text: string;
  when: (ctx: GuideContext) => boolean;
}

// Order matters only between equal priorities. Danger tips (entities) outrank everything else.
const RULES: TipRule[] = [
  {
    id: 'smiler',
    priority: 5,
    title: 'Smiler',
    text: 'Bullets pass straight through it. Hold your flashlight beam on its face to drive it off.',
    when: (c) => c.smilerNear,
  },
  {
    id: 'howler',
    priority: 5,
    title: 'Bacteria Howler',
    text: 'Nearly blind; it hunts by sound. Stop sprinting, walk or crouch, and get a door between you.',
    when: (c) => c.howlerNear,
  },
  {
    id: 'skin_stealer',
    priority: 5,
    title: 'Skin-Stealer',
    text: 'It hides as Almond Water. Real bottles slowly spin; a still one is not water.',
    when: (c) => c.skinStealerRevealed,
  },
  {
    id: 'exit',
    priority: 4,
    title: 'Exit unlocked',
    text: 'Follow the green arrow at the top of the screen to the Sector 00 door. Everything is coming.',
    when: (c) => c.exitUnlocked,
  },
  {
    id: 'noise',
    priority: 3,
    title: 'Something is close',
    text: 'Sprinting is loud, walking is quiet, crouching (C) is silent. Gunshots carry across the level.',
    when: (c) => c.somethingNear,
  },
  {
    id: 'battery_low',
    priority: 3,
    title: 'Battery low',
    text: 'Spare cells with a yellow band lie on the floor. Switch the light off (F) under working ceiling lights.',
    when: (c) => c.battery < 25,
  },
  {
    id: 'ammo_low',
    priority: 3,
    title: 'Running out of rounds',
    text: 'Killed entities come back. Doors (E) and hiding (C) cost nothing; fight only when cornered.',
    when: (c) => c.ammoTotal <= 6,
  },
  {
    id: 'winded',
    priority: 2,
    title: 'Out of breath',
    text: 'You cannot sprint until you catch your breath. Let go of Shift to recover sooner.',
    when: (c) => c.winded,
  },
  {
    id: 'tape',
    priority: 2,
    title: 'The level noticed',
    text: 'Each tape fails more lights and wakes another entity. Watch the THREAT meter, top left.',
    when: (c) => c.tapesCollected >= 1,
  },
  {
    id: 'door',
    priority: 2,
    title: 'Doors',
    text: 'Press E to close a door behind you. Entities must go around it, or batter it down.',
    when: (c) => c.nearDoor,
  },
  {
    id: 'hide',
    priority: 2,
    title: 'Hiding',
    text: 'Crouch (C) under a desk to hide. Break line of sight first: they search where they last saw you.',
    when: (c) => c.nearDesk && !c.crouched,
  },
  {
    id: 'flashlight',
    priority: 1,
    title: 'Flashlight',
    text: 'F toggles your light. The battery never recharges on its own, and the beam makes you easier to spot.',
    when: (c) => c.elapsed > 14 && c.flashlightOn,
  },
  {
    id: 'start',
    priority: 1,
    title: 'Find the four VHS tapes',
    text: 'Each tape hisses with static: follow the sound. WASD to move, mouse to look, Shift to sprint.',
    when: (c) => c.elapsed > 1.2,
  },
];

const SHOW_SECONDS = 8;
const GAP_SECONDS = 1.5;

/**
 * Contextual tips for new players: each one appears the first time its situation comes up,
 * then never again (unless the guide is reset from Settings).
 */
export class GuideDirector {
  public enabled = true;
  private current: TipRule | null = null;
  private timer = 0;
  private gap = 0;

  constructor(
    private readonly seen: Set<string>,
    private readonly onSeen: (seen: Set<string>) => void,
  ) {}

  /** Forget which tips were shown so every tip can appear again. */
  public clearSeen(): void {
    this.seen.clear();
    this.onSeen(this.seen);
    this.reset();
  }

  public reset(): void {
    this.current = null;
    this.timer = 0;
    this.gap = 0;
  }

  public update(delta: number, ctx: GuideContext): void {
    if (this.current) {
      this.timer -= delta;
      if (this.timer <= 0) {
        this.current = null;
        this.gap = GAP_SECONDS;
      }
    } else if (this.gap > 0) {
      this.gap -= delta;
    }
    if (!this.enabled) {
      this.current = null;
      return;
    }

    const minPriority = this.current ? this.current.priority + 2 : this.gap > 0 ? Infinity : -Infinity;
    let next: TipRule | null = null;
    for (const rule of RULES) {
      if (rule.priority < minPriority || this.seen.has(rule.id)) continue;
      if (!rule.when(ctx)) continue;
      if (!next || rule.priority > next.priority) next = rule;
    }
    if (!next) return;
    this.current = next;
    this.timer = SHOW_SECONDS;
    this.seen.add(next.id);
    this.onSeen(this.seen);
  }

  public get tip(): HudTip | null {
    if (!this.current) return null;
    return { id: this.current.id, title: this.current.title, text: this.current.text };
  }
}
