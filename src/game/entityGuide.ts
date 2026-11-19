import { EntityArchetype } from './types';

/** What each entity is and how to survive it: shown in How to Play and on the results screen after a death. */
export const ENTITY_GUIDE: Record<EntityArchetype, { name: string; tell: string; counter: string }> = {
  howler: {
    name: 'Bacteria Howler',
    tell: 'Tall, fast, nearly blind. Clicks while it hunts.',
    counter: 'It hunts by sound. Stop sprinting and put a door between you.',
  },
  smiler: {
    name: 'Smiler',
    tell: 'A grin in the dark. Sees far when your light is off.',
    counter: 'Bullets pass through it. Hold your beam on its face to banish it.',
  },
  brute: {
    name: 'Skin-Stealer',
    tell: 'Hides as a bottle of Almond Water.',
    counter: 'Real bottles slowly spin. A still one is not water. Slow, but hits hard.',
  },
};
