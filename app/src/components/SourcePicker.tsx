import { ChevronDown } from "lucide-react";
import type { SessionSnapshot } from "../store/session";

export interface SourceSelection {
  source: "system" | "mic";
  deviceId?: string;
}

interface SourcePickerProps {
  devices: SessionSnapshot["devices"];
  value: SourceSelection;
  onChange: (value: SourceSelection) => void;
  disabled?: boolean;
}

export function SourcePicker({ devices, value, onChange, disabled }: SourcePickerProps) {
  const options = devices.map((device) => {
    const source = device.kind === "system" ? "system" : "mic";
    return {
      selection: { source, deviceId: device.id } satisfies SourceSelection,
      label: source === "system" ? "系统音频" : device.name,
    };
  });
  const exactIndex = options.findIndex(({ selection }) =>
    selection.source === value.source && selection.deviceId === value.deviceId);
  const selectedIndex = value.deviceId === undefined
    ? options.findIndex(({ selection }) => selection.source === value.source)
    : exactIndex;

  return (
    <div className="relative min-w-0 max-w-52">
      <select
        aria-label="音源"
        value={selectedIndex < 0 ? "current" : selectedIndex}
        disabled={disabled}
        onChange={(event) => {
          const option = options[Number(event.currentTarget.value)];
          if (option) onChange(option.selection);
        }}
        className="block h-8 w-full truncate appearance-none rounded-[8px] border border-solid border-[var(--border)] bg-[var(--bg-elevated)] pl-2.5 pr-8 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
      >
        {selectedIndex < 0 && (
          <option value="current" disabled>
            {value.source === "system" ? "系统音频" : "麦克风"}
          </option>
        )}
        {options.map(({ selection, label }, index) => (
          <option key={JSON.stringify(selection)} value={index}>{label}</option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        size={16}
        strokeWidth={1.5}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-2)]"
      />
    </div>
  );
}
