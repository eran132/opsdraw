import { useEffect, useState } from 'react';
import { onPacksChanged, resolveIcon } from './icons';

/** Re-renders when icon packs are added or removed. */
export function usePacksVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => onPacksChanged(() => setVersion((v) => v + 1)), []);
  return version;
}

export function Icon({
  refName,
  size = 40,
  className = 'icon',
}: {
  refName?: string;
  size?: number;
  /** `icon` draws in the text color; `ui-icon` follows the surrounding control's color. */
  className?: string;
}) {
  usePacksVersion();
  const icon = resolveIcon(refName);
  if (!icon) {
    // Unknown icon (for example a vendor pack that isn't installed here): show a placeholder.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={`${className} icon-missing`}
        aria-hidden
      >
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeDasharray="3 2"
        />
        <text x="12" y="16" textAnchor="middle" fontSize="10" fill="currentColor">
          ?
        </text>
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${icon.width} ${icon.height}`}
      className={className}
      aria-hidden
      // Lucide bodies are bundled; imported pack bodies are sanitized on import (packs.ts).
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

/** A Lucide glyph for buttons and menus; it takes the color of the control it sits in. */
export const UiIcon = ({ name, size = 16 }: { name: string; size?: number }) => (
  <Icon refName={`lucide:${name}`} size={size} className="ui-icon" />
);
