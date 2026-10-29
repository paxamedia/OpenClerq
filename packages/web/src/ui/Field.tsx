import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from './Icon';
import { cx } from './cx';
import './Field.css';

interface FieldParts {
  label?: ReactNode;
  /** One sentence under the control. Hidden while there is an error. */
  hint?: ReactNode;
  /** What is wrong and how to fix it. Marks the control invalid. */
  error?: ReactNode;
}

interface FieldIds {
  control: string;
  hint: string;
  error: string;
}

function useFieldIds(id: string | undefined): FieldIds {
  const auto = useId();
  const control = id ?? auto;
  return { control, hint: `${control}-hint`, error: `${control}-error` };
}

function describedBy(ids: FieldIds, { hint, error }: FieldParts, own?: string): string | undefined {
  return (
    [own, error ? ids.error : hint ? ids.hint : undefined].filter(Boolean).join(' ') || undefined
  );
}

function Frame({
  ids,
  label,
  hint,
  error,
  className,
  children,
}: FieldParts & { ids: FieldIds; className?: string; children: ReactNode }) {
  return (
    <div className={cx('ui-field', Boolean(error) && 'is-invalid', className)}>
      {label && (
        <label className="ui-field-label" htmlFor={ids.control}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={ids.error} className="ui-field-error">
          {error}
        </p>
      ) : hint ? (
        <p id={ids.hint} className="ui-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, FieldParts {
  /** Monospace, for paths, IDs and cron lines. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, id, className, 'aria-describedby': own, ...rest },
  ref
) {
  const ids = useFieldIds(id);
  return (
    <Frame ids={ids} label={label} hint={hint} error={error} className={className}>
      <input
        ref={ref}
        id={ids.control}
        className={cx('ui-control', mono && 'is-mono')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, { hint, error }, own)}
        {...rest}
      />
    </Frame>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldParts {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, mono, id, className, rows = 4, 'aria-describedby': own, ...rest },
  ref
) {
  const ids = useFieldIds(id);
  return (
    <Frame ids={ids} label={label} hint={hint} error={error} className={className}>
      <textarea
        ref={ref}
        id={ids.control}
        rows={rows}
        className={cx('ui-control', 'ui-textarea', mono && 'is-mono')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, { hint, error }, own)}
        {...rest}
      />
    </Frame>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldParts {}

/** A native select, so the keyboard and screen readers work as the system expects. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, children, 'aria-describedby': own, ...rest },
  ref
) {
  const ids = useFieldIds(id);
  return (
    <Frame ids={ids} label={label} hint={hint} error={error} className={className}>
      <span className="ui-select">
        <select
          ref={ref}
          id={ids.control}
          className="ui-control"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, { hint, error }, own)}
          {...rest}
        >
          {children}
        </select>
        <Icon glyph={ChevronDown} className="ui-select-chevron" />
      </span>
    </Frame>
  );
});
