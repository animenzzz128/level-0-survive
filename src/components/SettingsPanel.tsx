import React from 'react';
import { GameSettings, QualityLevel, SETTINGS_LIMITS } from '../game/storage';

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
        <span className="font-mono-hud text-xs text-[#f5efe0]">{props.display}</span>
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
        <span className="text-xs text-[#8a805f]">{props.hint}</span>
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
            label="Field of view"
            value={settings.fov}
            min={SETTINGS_LIMITS.fov.min}
            max={SETTINGS_LIMITS.fov.max}
            step={1}
            display={`${settings.fov}°`}
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
            <span className="text-xs text-[#8a805f]">{QUALITY_HINTS[effectiveQuality]}</span>
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
            className="w-fit border border-[#d4be74]/25 px-3 py-1.5 text-xs text-[#cfc6a6] hover:border-[#e8b838] hover:text-white"
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
