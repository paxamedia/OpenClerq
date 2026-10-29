import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { cx } from './cx';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Drawn before the label. */
  icon?: LucideIcon;
  /** Working on it: the button is disabled and a 1px line runs along its bottom edge. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    busy = false,
    disabled,
    className,
    type = 'button',
    children,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        busy && 'is-busy',
        className
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon && <Icon glyph={icon} />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  icon: LucideIcon;
  /** What the button does. Screen readers read it, and it shows as a tooltip. */
  label: string;
}

/** A square button with only an icon. Its label is its accessible name and its tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', className, ...rest },
  ref
) {
  return (
    <Tooltip label={label} describe={false}>
      <Button
        ref={ref}
        variant={variant}
        className={cx('ui-icon-button', className)}
        aria-label={label}
        {...rest}
      >
        <Icon glyph={icon} />
      </Button>
    </Tooltip>
  );
});
