import React from 'react';

interface CreditsPanelProps {
  onClose: () => void;
}

const REPO = 'https://github.com/animenzzz128/level-0-survive';
const WIKI = 'https://backrooms-wiki.wikidot.com';

/** The attribution the Backrooms Wiki licence asks for, and this game's own licences. Also in CREDITS.md. */
const WIKI_PAGES: Array<{ concept: string; page: string; path: string; authors: string }> = [
  { concept: 'Level 0', page: 'Level 0 - "Threshold"', path: 'level-0', authors: 'DivineAtlas, DrAkimoto and RobertGoerman' },
  { concept: 'Smilers', page: 'Entity 3 - "Smilers"', path: 'entity-3', authors: 'Palico22, rewritten by Stretchsterz' },
  {
    concept: 'Skin-Stealers',
    page: 'Entity 10 - "Skin-Stealers"',
    path: 'entity-10',
    authors: 'AndromedaMapping1, rewritten by 1000dumplings',
  },
  {
    concept: 'Almond Water',
    page: 'Object 1 - "Almond Water"',
    path: 'object-1',
    authors: '1000dumplings, rewritten by Natedagreat563 and Poliacci',
  },
];

function ExternalLink(props: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#e8b838] underline decoration-[#e8b838]/40 underline-offset-2 hover:text-[#f5cb5c]"
    >
      {props.children}
    </a>
  );
}

export const CreditsPanel: React.FC<CreditsPanelProps> = ({ onClose }) => (
  <div
    className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#090805]/85 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="credits-title"
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }}
  >
    <div className="max-h-full w-full max-w-2xl overflow-y-auto border border-[#d4be74]/30 bg-[#12100a] p-6 md:p-8">
      <h2 id="credits-title" className="font-display text-3xl font-bold tracking-tight text-[#f7f1dc]">
        Credits &amp; License
      </h2>

      <h3 className="mt-5 font-mono-hud text-sm tracking-wider text-[#e8b838]">THE BACKROOMS</h3>
      <p className="mt-2 text-base leading-relaxed text-[#cfc6a6]">
        The Backrooms began as an anonymous post on 4chan&apos;s /x/ board in May 2019. Content relating to the
        Backrooms in this game is licensed under{' '}
        <ExternalLink href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</ExternalLink>. These
        concepts originate from the <ExternalLink href={WIKI}>Backrooms Wiki</ExternalLink> and its authors, adapted
        and changed for this game:
      </p>
      <ul className="mt-2 flex flex-col gap-1.5 text-base leading-relaxed text-[#cfc6a6]">
        {WIKI_PAGES.map((p) => (
          <li key={p.path}>
            <span className="text-[#f5efe0]">{p.concept}</span>:{' '}
            <ExternalLink href={`${WIKI}/${p.path}`}>{p.page}</ExternalLink> by {p.authors}.
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-[#a89e79]">
        Original to this game: the Howler, the entities&apos; gameplay rules, the tape logs, landmarks and arrow graffiti.
      </p>

      <h3 className="mt-5 font-mono-hud text-sm tracking-wider text-[#e8b838]">THIS GAME</h3>
      <p className="mt-2 text-base leading-relaxed text-[#cfc6a6]">
        Code: <ExternalLink href={`${REPO}/blob/main/LICENSE`}>GNU GPL v3.0 or later</ExternalLink>. Art, models,
        textures, audio and design documents:{' '}
        <ExternalLink href={`${REPO}/blob/main/LICENSES/CC-BY-SA-3.0.txt`}>CC BY-SA 3.0</ExternalLink>. The full source
        is public at <ExternalLink href={REPO}>github.com/animenzzz128/level-0-survive</ExternalLink>. No DRM and no
        additional terms.
      </p>

      <h3 className="mt-5 font-mono-hud text-sm tracking-wider text-[#e8b838]">BUILT WITH</h3>
      <p className="mt-2 text-base leading-relaxed text-[#cfc6a6]">
        three.js, React, Tailwind CSS and Lucide icons (MIT and ISC licenses;{' '}
        <ExternalLink href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`}>full notices</ExternalLink>). Fonts:
        IBM Plex Mono, Oswald and Plus Jakarta Sans (SIL Open Font License). Made with Google AI Studio and Claude
        (Anthropic) under Jacky Yao&apos;s direction; the 3D models are built by Blender scripts written with Claude
        Code, and the Skin-Stealer&apos;s body starts from a Tencent Hunyuan3D mesh of its concept art.
      </p>

      <div className="mt-7 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="bg-[#e8b838] px-6 py-2.5 text-sm font-semibold text-[#0d0c08] hover:bg-[#f5cb5c]"
        >
          Close
        </button>
      </div>
    </div>
  </div>
);
