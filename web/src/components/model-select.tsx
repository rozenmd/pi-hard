import { BoltIcon, LightBulbIcon } from "@heroicons/react/16/solid";
import { Picker, type PickerOption } from "./picker";

const CHATGPT = "ChatGPT subscription";
const CLAUDE = "Claude subscription";

const word = (part: string) =>
  /^(gpt|o\d)$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);

/**
 * Human name for an API model ID: "gpt-6.1-sol" → "GPT-6.1 Sol",
 * "claude-opus-5-5" → "Claude Opus 5.5". Unknown IDs are prettified, never hidden.
 */
export function modelName(id: string) {
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(id);

  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2]?.split("-").map(word) ?? [])].join(" ");

  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/i.exec(id);

  if (claude) return `Claude ${word(claude[1])} ${claude[2]}.${claude[3]}`;

  return /^[a-z0-9.-]+$/i.test(id) && id.includes("-") ? id.split("-").map(word).join(" ") : id;
}

export const MODELS: PickerOption[] = [
  { value: "", label: "Server default" },
  ...["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"].map((value) => ({
    value,
    label: modelName(value),
    group: CHATGPT,
  })),
  ...["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"].map(
    (value) => ({ value, label: modelName(value), group: CLAUDE }),
  ),
];

/** Pi thinking levels. Providers clamp levels a model doesn't support to the nearest one. */
export const EFFORTS: PickerOption[] = [
  { value: "off", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export const DEFAULT_EFFORT = "low";

export const effortName = (level: string) =>
  EFFORTS.find((option) => option.value === level)?.label ?? level;

export function ModelPicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const current = MODELS.find((model) => model.value === value);

  return (
    <Picker
      id={id}
      label="Model"
      className="model-picker"
      align="end"
      value={value}
      options={MODELS}
      disabled={disabled}
      onChange={onChange}
      trigger={
        <>
          <BoltIcon className="model-picker-bolt" aria-hidden="true" />
          <span>{current?.label ?? modelName(value)}</span>
        </>
      }
    />
  );
}

export function EffortPicker({
  id,
  value,
  disabled,
  placement = "below",
  onChange,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  placement?: "above" | "below";
  onChange: (level: string) => void;
}) {
  return (
    <Picker
      id={id}
      label="Thinking effort"
      className={`model-picker effort-picker${placement === "above" ? " opens-up" : ""}`}
      align="end"
      value={value}
      options={EFFORTS}
      disabled={disabled}
      onChange={onChange}
      trigger={
        <>
          <LightBulbIcon className="model-picker-bolt" aria-hidden="true" />
          <span>{effortName(value)}</span>
        </>
      }
    />
  );
}
