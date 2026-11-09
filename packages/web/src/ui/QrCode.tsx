import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { cx } from './cx';
import './QrCode.css';

/** The dark modules of a QR code as one SVG path, with a four-module quiet zone. */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
  }
  return { size: n + 8, d };
}

/** A QR code for a phone to scan. `label` says what it holds, for screen readers. */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      className={cx('ui-qr', className)}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect className="ui-qr-paper" width={size} height={size} />
      <path className="ui-qr-ink" d={d} />
    </svg>
  );
}
