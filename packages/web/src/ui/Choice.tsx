import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { Icon } from './Icon';
import { cx } from './cx';
import { nextIndex } from './roving';
import './Choice.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  hint?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, className, ...rest },
  ref
) {
  return (
    <label className={cx('ui-check', rest.disabled && 'is-disabled', className)}>
      <input ref={ref} type="checkbox" className="ui-check-input" {...rest} />
      <span className="ui-check-box" aria-hidden="true">
        <Icon glyph={Check} size={12} strokeWidth={2} />
      </span>
      <span className="ui-check-text">
        {label}
        {hint && <span className="ui-check-hint">{hint}</span>}
      </span>
    </label>
  );
});

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'children'
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Keep the label for screen readers only, as in a table row. */
  hideLabel?: boolean;
}

/** An on/off switch that takes effect at once, without a Save. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, hideLabel = false, className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx('ui-switch', className)}
      onClick={() => onChange(!checked)}
      {...rest}
    >
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      <span className={hideLabel ? 'ui-sr-only' : 'ui-switch-label'}>{label}</span>
    </button>
  );
});

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** One choice from a few, side by side. Arrow keys move and choose. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.findIndex((o) => o.value === value);
  const focusable = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const to = nextIndex(
      index,
      e.key,
      options.map((o) => Boolean(o.disabled)),
      'horizontal'
    );
    if (to === null) return;
    e.preventDefault();
    buttons.current[to]?.focus();
    onChange(options[to].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('ui-segmented', `ui-segmented--${size}`, className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === selected}
          tabIndex={i === focusable ? 0 : -1}
          disabled={o.disabled}
          className="ui-segment"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.icon && <Icon glyph={o.icon} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
