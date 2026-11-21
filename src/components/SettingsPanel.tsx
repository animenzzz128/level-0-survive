import React from 'react';
import { horizontalFov } from '../game/aim';
import { ACTIONS, DEFAULT_BINDINGS, GameAction, keyLabel, rebind } from '../game/controls';
import { GameSettings, JumpscareMode, QualityLevel, SETTINGS_LIMITS } from '../game/storage';

const actionLabel = (id: GameAction) => ACTIONS.find((a) => a.id === id)?.label ?? id;

interface SettingsPanelProps {
  settings: GameSettings;
  /** What 'auto' resolves to on this machine, for the label. */
  autoQuality: 'low' | 'medium' | 'high';
  onChange: (settings: GameSettings) => void;
  onResetTips: () => void;
  onClose: () => void;
}

const QUALITY_LABELS: Record<Exclude<QualityLevel, 'auto'>, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const QUALITY_HINTS: Record<Exclude<QualityLevel, 'auto'>, string> = {
  low: 'No shadows, reduced resolution, 4 ceiling lights. For weak laptops.',
  medium: 'Flashlight shadows at half resolution, 6 ceiling lights.',
  high: 'Full shadows and resolution, 8 ceiling lights.',
};

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  const id = `setting-${props.label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <label htmlFor={id} className="text-[#cfc6a6]">
          {props.label}
        </label>
        <span className="font-mono-hud text-sm text-[#f5efe0]">{props.display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-[#e8b838]"
      />
    </div>
  );
}

function Toggle(props: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-sm text-[#cfc6a6]">{props.label}</span>
        <span className="text-sm text-[#a89e79]">{props.hint}</span>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[#e8b838]"
      />
    </label>
  );
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  autoQuality,
  onChange,
  onResetTips,
  onClose,
}) => {
  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) =>
    onChange({ ...settings, [key]: value });
  const effectiveQuality = settings.quality === 'auto' ? autoQuality : settings.quality;
  const [tipsReset, setTipsReset] = React.useState(false);
  // Rebinding: the action waiting for a key, and a note about the last change (conflict, reserved key).
  const [listening, setListening] = React.useState<GameAction | null>(null);
  const [bindNote, setBindNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!listening) return;
    // Capture phase on window: the key must reach neither the dialog's Esc handler nor the game.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        setListening(null);
        setBindNote(null);
        return;
      }
      const result = rebind(settings.bindings, listening, e.code);
      if (!result) {
        setBindNote(`${keyLabel(e.code)} is kept for the game or the browser. Pick another key.`);
        return;
      }
      onChange({ ...settings, bindings: result.bindings });
      setBindNote(
        result.swappedWith
          ? `${keyLabel(e.code)} was already ${actionLabel(result.swappedWith)}: the two actions swapped keys.`
          : null,
      );
      setListening(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, settings, onChange]);

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#090805]/85 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto border border-[#d4be74]/30 bg-[#12100a] p-6">
        <h2 id="settings-title" className="font-display text-3xl font-semibold tracking-wide text-[#f7f1dc]">
          Settings
        </h2>

        <div className="mt-5 flex flex-col gap-5">
          <Slider
            label="Mouse sensitivity"
            value={settings.sensitivity}
            min={SETTINGS_LIMITS.sensitivity.min}
            max={SETTINGS_LIMITS.sensitivity.max}
            step={0.05}
            display={`${settings.sensitivity.toFixed(2)}x`}
            onChange={(v) => set('sensitivity', v)}
          />
          <Toggle
            label="Invert vertical look"
            hint="Moving the mouse up looks down."
            checked={settings.invertY}
            onChange={(v) => set('invertY', v)}
          />
          <Slider
            label="Volume"
            value={Math.round(settings.volume * 100)}
            min={0}
            max={100}
            step={1}
            display={`${Math.round(settings.volume * 100)}%`}
            onChange={(v) => set('volume', v / 100)}
          />
          <Slider
            label="Field of view (vertical)"
            value={settings.fov}
            min={SETTINGS_LIMITS.fov.min}
            max={SETTINGS_LIMITS.fov.max}
            step={1}
            display={`${settings.fov}° · ${Math.round(horizontalFov(settings.fov))}° horizontal at 16:9`}
            onChange={(v) => set('fov', v)}
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setting-quality" className="text-sm text-[#cfc6a6]">
              Graphics quality
            </label>
            <select
              id="setting-quality"
              value={settings.quality}
              onChange={(e) => set('quality', e.target.value as QualityLevel)}
              className="border border-[#d4be74]/30 bg-[#17150e] px-3 py-2 text-sm text-[#f5efe0]"
            >
              <option value="auto">Auto ({QUALITY_LABELS[autoQuality]})</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <span className="text-sm text-[#a89e79]">{QUALITY_HINTS[effectiveQuality]}</span>
          </div>

          <h3 className="mt-1 font-mono-hud text-sm tracking-wider text-[#e8b838]">COMFORT</h3>
          <Slider
            label="Screen shake"
            value={Math.round(settings.shakeStrength * 100)}
            min={0}
            max={100}
            step={5}
            display={`${Math.round(settings.shakeStrength * 100)}%`}
            onChange={(v) => set('shakeStrength', v / 100)}
          />
          <Toggle
            label="Reduce motion"
            hint="No head bob and no camera roll."
            checked={settings.reduceMotion}
            onChange={(v) => set('reduceMotion', v)}
          />
          <Toggle
            label="Reduce flashing"
            hint="Smooth light flicker, no flashlight stutter or muzzle light, softer damage flash."
            checked={settings.reduceFlashing}
            onChange={(v) => set('reduceFlashing', v)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="setting-jumpscares" className="text-sm text-[#cfc6a6]">
              Death scenes
            </label>
            <select
              id="setting-jumpscares"
              value={settings.jumpscares}
              onChange={(e) => set('jumpscares', e.target.value as JumpscareMode)}
              className="border border-[#d4be74]/30 bg-[#17150e] px-3 py-2 text-sm text-[#f5efe0]"
            >
              <option value="full">Full</option>
              <option value="reduced">Reduced</option>
              <option value="off">Off</option>
            </select>
            <span className="text-sm text-[#a89e79]">
              {settings.jumpscares === 'full'
                ? 'The creature that kills you gets a short close-up before the results.'
                : settings.jumpscares === 'reduced'
                  ? 'The close-up without flashes or a sudden camera turn, and quieter.'
                  : 'Straight to the results screen.'}
            </span>
          </div>

          <h3 className="mt-1 font-mono-hud text-sm tracking-wider text-[#e8b838]">INTERFACE</h3>
          <Slider
            label="Interface size"
            value={Math.round(settings.uiScale * 100)}
            min={Math.round(SETTINGS_LIMITS.uiScale.min * 100)}
            max={Math.round(SETTINGS_LIMITS.uiScale.max * 100)}
            step={5}
            display={`${Math.round(settings.uiScale * 100)}%`}
            onChange={(v) => set('uiScale', v / 100)}
          />

          <h3 className="mt-1 font-mono-hud text-sm tracking-wider text-[#e8b838]">CONTROLS</h3>
          <Toggle
            label="Toggle aim"
            hint="Press aim once to aim, again to stop (instead of holding)."
            checked={settings.aimToggle}
            onChange={(v) => set('aimToggle', v)}
          />
          <Toggle
            label="Toggle sprint"
            hint="Press sprint once; it stops when you stop moving or press it again."
            checked={settings.sprintToggle}
            onChange={(v) => set('sprintToggle', v)}
          />
          <Toggle
            label="Toggle crouch"
            hint="Off: crouch only while the key is held."
            checked={settings.crouchToggle}
            onChange={(v) => set('crouchToggle', v)}
          />
          <div className="flex flex-col gap-1" role="group" aria-label="Key bindings">
            {ACTIONS.map(({ id, label }) => (
              <div key={id} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-[#cfc6a6]">{label}</span>
                <button
                  type="button"
                  aria-label={`Change key for ${label}, now ${keyLabel(settings.bindings[id])}`}
                  onClick={() => {
                    setBindNote(null);
                    setListening(listening === id ? null : id);
                  }}
                  className={`min-w-[7.5rem] border px-3 py-1 font-mono-hud text-sm ${
                    listening === id
                      ? 'border-[#e8b838] bg-[#2a2414] text-[#f5efe0]'
                      : 'border-[#d4be74]/30 bg-[#17150e] text-[#f5efe0] hover:border-[#e8b838]'
                  }`}
                >
                  {listening === id ? 'Press a key…' : keyLabel(settings.bindings[id])}
                </button>
              </div>
            ))}
            <div className="min-h-5 text-sm text-[#e8b838]" aria-live="polite">
              {listening ? 'Press the new key, or Esc to cancel.' : bindNote}
            </div>
            <button
              type="button"
              onClick={() => {
                setListening(null);
                setBindNote('Keys reset to the defaults.');
                onChange({ ...settings, bindings: { ...DEFAULT_BINDINGS } });
              }}
              className="w-fit border border-[#d4be74]/25 px-3 py-1.5 text-sm text-[#cfc6a6] hover:border-[#e8b838] hover:text-white"
            >
              Reset keys
            </button>
            <span className="text-sm text-[#a89e79]">Arrow keys also look around; Esc pauses. Those two cannot be rebound.</span>
          </div>

          <Toggle
            label="New-player tips"
            hint="Short hints the first time each situation comes up."
            checked={settings.tips}
            onChange={(v) => set('tips', v)}
          />
          <button
            type="button"
            onClick={() => {
              onResetTips();
              setTipsReset(true);
            }}
            className="w-fit border border-[#d4be74]/25 px-3 py-1.5 text-sm text-[#cfc6a6] hover:border-[#e8b838] hover:text-white"
          >
            {tipsReset ? 'Tips will show again' : 'Show all tips again'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="mt-7 w-full bg-[#e8b838] px-5 py-2.5 text-sm font-semibold text-[#0d0c08] hover:bg-[#f5cb5c]"
        >
          Done
        </button>
      </div>
    </div>
  );
};
