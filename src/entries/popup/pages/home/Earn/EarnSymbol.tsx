import {
  type SymbolStyles,
  symbolStyles,
} from '~/design-system/styles/core.css';

const DOLLAR =
  'M16.2 8.1C15.6 6.39 14 5.3 12 5.3C9.6 5.3 7.9 6.6 7.9 8.5C7.9 10.5 9.7 11.3 12 12C14.3 12.7 16.1 13.5 16.1 15.7C16.1 17.61 14.3 18.9 12 18.9C9.9 18.9 8.2 17.8 7.7 16M12 2.5V5.3M12 18.9V21.5';

// A dollar sign between a short bar and a tall one: money that grows. It
// draws in currentColor, like Rainbow's symbols, so it takes the button's ink.
export function EarnSymbol({
  size,
  color = 'label',
}: {
  size: number;
  color?: SymbolStyles['color'];
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={symbolStyles({ color })}
      aria-hidden
    >
      <rect
        x="0.8"
        y="13"
        width="4.4"
        height="10"
        rx="1.6"
        fill="currentColor"
        fillOpacity="0.45"
      />
      <rect
        x="18.8"
        y="3"
        width="4.4"
        height="20"
        rx="1.6"
        fill="currentColor"
        fillOpacity="0.45"
      />
      <path
        d={DOLLAR}
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
