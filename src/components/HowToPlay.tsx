import React from 'react';

interface HowToPlayProps {
  onClose: () => void;
}

const SECTIONS: Array<{ title: string; items: string[] }> = [
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
      'Your flashlight (F) never recharges on its own. Batteries lie on the floor.',
      'Sprinting is loud, walking is quiet, crouching (C) is silent. Gunshots carry 26 m.',
      'Close doors (E) behind you. Crouch under a desk to hide once nothing can see you.',
      'Ammo is scarce and killed entities come back. Fight only when cornered.',
    ],
  },
];

const ENTITIES: Array<{ name: string; tell: string; counter: string }> = [
  {
    name: 'Bacteria Howler',
    tell: 'Tall, fast, nearly blind. Clicks while it hunts.',
    counter: 'It hunts by sound. Stop sprinting and put a door between you.',
  },
  {
    name: 'Smiler',
    tell: 'A grin in the dark. Sees far when your light is off.',
    counter: 'Bullets pass through it. Hold your beam on its face to banish it.',
  },
  {
    name: 'Skin-Stealer',
    tell: 'Hides as a bottle of Almond Water.',
    counter: 'Real bottles slowly spin. A still one is not water. Slow, but hits hard.',
  },
];

const CONTROLS: Array<[string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Shift', 'Sprint'],
  ['C', 'Crouch / hide'],
  ['E', 'Open / close door'],
  ['F', 'Flashlight'],
  ['LMB / Space', 'Fire'],
  ['RMB', 'Aim'],
  ['R', 'Reload'],
  ['Esc', 'Pause'],
];

/** First-run briefing, also reachable from the title screen. */
export const HowToPlay: React.FC<HowToPlayProps> = ({ onClose }) => (
  <div
    className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#090805]/85 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="howto-title"
  >
    <div className="max-h-full w-full max-w-3xl overflow-y-auto border border-[#d4be74]/30 bg-[#12100a] p-6 md:p-8">
      <div className="font-mono-hud text-xs tracking-wider text-[#d4be74]">FIELD NOTES · READ BEFORE ENTERING</div>
      <h2 id="howto-title" className="font-display mt-1 text-3xl font-bold tracking-tight text-[#f7f1dc]">
        How to survive Level 0
      </h2>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h3 className="font-mono-hud text-xs tracking-wider text-[#e8b838]">{section.title.toUpperCase()}</h3>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm leading-relaxed text-[#cfc6a6]">
              {section.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="text-[#786f50]">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h3 className="mt-6 font-mono-hud text-xs tracking-wider text-[#e8b838]">WHAT HUNTS YOU</h3>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        {ENTITIES.map((entity) => (
          <div key={entity.name} className="border border-[#d4be74]/20 bg-[#17150e] p-3">
            <div className="text-sm font-semibold text-[#f5efe0]">{entity.name}</div>
            <div className="mt-1 text-xs text-[#9e9472]">{entity.tell}</div>
            <div className="mt-2 text-xs leading-relaxed text-[#cfc6a6]">{entity.counter}</div>
          </div>
        ))}
      </div>

      <h3 className="mt-6 font-mono-hud text-xs tracking-wider text-[#e8b838]">CONTROLS</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono-hud text-xs text-[#cfc6a6] md:grid-cols-5">
        {CONTROLS.map(([key, action]) => (
          <div key={key} className="flex flex-col">
            <span className="text-[#f5efe0]">{key}</span>
            <span className="text-[#9e9472]">{action}</span>
          </div>
        ))}
      </div>

      <div className="mt-7 flex items-center justify-between gap-4">
        <span className="text-xs text-[#9e9472]">Tips will appear in-game the first time each situation comes up.</span>
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
