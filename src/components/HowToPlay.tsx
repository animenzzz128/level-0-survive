import React from 'react';
import { KeyHints } from '../game/controls';
import { ENTITY_GUIDE } from '../game/entityGuide';

interface HowToPlayProps {
  keyHints: KeyHints;
  onClose: () => void;
}

const sections = (k: KeyHints): Array<{ title: string; items: string[] }> => [
  {
    title: 'Goal',
    items: [
      'Find the 4 VHS tapes. Each one hisses with static: follow the sound.',
      'Then reach the Sector 00 exit door. A green arrow points to it once it unlocks.',
      'Every tape you take makes Level 0 worse: lights fail and another entity wakes up.',
    ],
  },
  {
    title: 'Staying alive',
    items: [
      `Your flashlight (${k.flashlight}) never recharges on its own. Batteries lie on the floor.`,
      `Sprinting is loud, walking is quiet, crouching (${k.crouch}) is silent. Gunshots carry 26 m.`,
      `Close doors (${k.interact}) behind you. Crouch under a desk to hide once nothing can see you.`,
      'Arrows sprayed at junctions mostly point toward the exit. Mostly.',
      'Ammo is scarce and killed entities come back. Fight only when cornered.',
    ],
  },
];

const ENTITIES = [ENTITY_GUIDE.howler, ENTITY_GUIDE.smiler, ENTITY_GUIDE.brute];

const controls = (k: KeyHints): Array<[string, string]> => [
  [k.move, 'Move'],
  ['Mouse', 'Look'],
  [k.sprint, 'Sprint'],
  [k.crouch, 'Crouch / hide'],
  [k.interact, 'Open / close door'],
  [k.flashlight, 'Flashlight'],
  [k.fire, 'Fire'],
  [k.aim, 'Aim'],
  [k.reload, 'Reload'],
  ['Esc', 'Pause'],
];

/** First-run briefing, also reachable from the title screen. */
export const HowToPlay: React.FC<HowToPlayProps> = ({ keyHints, onClose }) => (
  <div
    className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#090805]/85 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="howto-title"
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }}
  >
    <div className="max-h-full w-full max-w-3xl overflow-y-auto border border-[#d4be74]/30 bg-[#12100a] p-6 md:p-8">
      <div className="font-mono-hud text-sm tracking-wider text-[#d4be74]">FIELD NOTES · READ BEFORE ENTERING</div>
      <h2 id="howto-title" className="font-display mt-1 text-3xl font-bold tracking-tight text-[#f7f1dc]">
        How to survive Level 0
      </h2>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        {sections(keyHints).map((section) => (
          <section key={section.title}>
            <h3 className="font-mono-hud text-sm tracking-wider text-[#e8b838]">{section.title.toUpperCase()}</h3>
            <ul className="mt-2 flex flex-col gap-1.5 text-base leading-relaxed text-[#cfc6a6]">
              {section.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="text-[#a89e79]">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h3 className="mt-6 font-mono-hud text-sm tracking-wider text-[#e8b838]">WHAT HUNTS YOU</h3>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        {ENTITIES.map((entity) => (
          <div key={entity.name} className="border border-[#d4be74]/20 bg-[#17150e] p-3">
            <div className="text-sm font-semibold text-[#f5efe0]">{entity.name}</div>
            <div className="mt-1 text-sm text-[#9e9472]">{entity.tell}</div>
            <div className="mt-2 text-sm leading-relaxed text-[#cfc6a6]">{entity.counter}</div>
          </div>
        ))}
      </div>

      <h3 className="mt-6 font-mono-hud text-sm tracking-wider text-[#e8b838]">CONTROLS</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono-hud text-sm text-[#cfc6a6] md:grid-cols-5">
        {controls(keyHints).map(([key, action]) => (
          <div key={action} className="flex flex-col">
            <span className="text-[#f5efe0]">{key}</span>
            <span className="text-[#9e9472]">{action}</span>
          </div>
        ))}
      </div>

      <div className="mt-7 flex items-center justify-between gap-4">
        <span className="text-sm text-[#9e9472]">Tips appear in-game the first time each situation comes up. Keys can be changed in Settings.</span>
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="bg-[#e8b838] px-6 py-2.5 text-sm font-semibold text-[#0d0c08] hover:bg-[#f5cb5c]"
        >
          Got it
        </button>
      </div>
    </div>
  </div>
);
