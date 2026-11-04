import { type MouseEvent, useMemo, useState } from 'react';

import type { ValuePoint } from '~/core/earn/strategies';
import {
  accentColorAsHsl,
  transparentAccentColorAsHsl,
} from '~/design-system/styles/core.css';
import { globalColors } from '~/design-system/styles/designTokens';

import { formatUsd } from './earnFormat';

// Room above the highest point for the hover label.
const PAD_TOP = 44;
const PAD_BOTTOM = 2;
const LABEL_WIDTH = 90;

const formatWhen = (timestamp: number, hours: number) =>
  new Date(timestamp).toLocaleString(
    'en-US',
    hours <= 168
      ? { month: 'short', day: 'numeric', hour: 'numeric' }
      : { month: 'short', day: 'numeric' },
  );

// The position value over time as a filled area that starts at $0, so
// deposits and withdrawals show as steps and yield as the slope between them.
export function EarnValueChart({
  data,
  width,
  height,
  hours,
}: {
  data: ValuePoint[];
  width: number;
  height: number;
  hours: number;
}) {
  const points = useMemo(() => {
    const from = data[0].timestamp;
    const span = data[data.length - 1].timestamp - from || 1;
    const max = Math.max(0, ...data.map((p) => p.value));
    const usable = height - PAD_TOP - PAD_BOTTOM;
    return data.map((p) => ({
      ...p,
      x: ((p.timestamp - from) / span) * width,
      y: height - PAD_BOTTOM - (max === 0 ? 0 : (p.value / max) * usable),
    }));
  }, [data, height, width]);

  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  const [hover, setHover] = useState<(typeof points)[number] | null>(null);
  const onMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const mouseX = ((event.clientX - box.left) / box.width) * width;
    setHover(
      points.reduce((best, p) =>
        Math.abs(p.x - mouseX) < Math.abs(best.x - mouseX) ? p : best,
      ),
    );
  };

  const flip = hover !== null && hover.x + LABEL_WIDTH > width;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="presentation"
      style={{ display: 'block' }}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <linearGradient id="earn-value-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accentColorAsHsl} stopOpacity="0.35" />
          <stop offset="100%" stopColor={accentColorAsHsl} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#earn-value-area)" />
      <path
        d={line}
        fill="none"
        stroke={accentColorAsHsl}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      {hover && (
        <>
          <rect
            x={hover.x - 1}
            y={PAD_TOP - 8}
            width={2}
            height={height - PAD_TOP + 8}
            fill={transparentAccentColorAsHsl}
          />
          <circle
            cx={hover.x}
            cy={hover.y}
            r={12}
            fill={transparentAccentColorAsHsl}
          />
          <circle cx={hover.x} cy={hover.y} r={6} fill={accentColorAsHsl} />
          <text
            x={flip ? hover.x - 6 : hover.x + 6}
            y={16}
            textAnchor={flip ? 'end' : 'start'}
            fill={accentColorAsHsl}
            fontWeight="bold"
            fontSize="14px"
            fontFamily="SFRounded, system-ui"
          >
            {formatUsd(hover.value)}
          </text>
          <text
            x={flip ? hover.x - 6 : hover.x + 6}
            y={33}
            textAnchor={flip ? 'end' : 'start'}
            fill={globalColors.blueGrey60}
            fontWeight="600"
            fontSize="12px"
            fontFamily="SFRounded, system-ui"
          >
            {formatWhen(hover.timestamp, hours)}
          </text>
        </>
      )}
    </svg>
  );
}
