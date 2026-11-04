import type { ReactNode } from 'react';

import { Box } from '~/design-system';
import { BottomSheet } from '~/design-system/components/BottomSheet/BottomSheet';
import { zIndexes } from '~/entries/popup/utils/zIndexes';

// Rainbow's BottomSheet sits at the bottom of the nearest positioned ancestor.
// That ancestor is the top of the page, so when the page is scrolled
// the sheet opens above the visible area and only the dimmed background shows.
// A full-screen fixed wrapper makes the sheet follow the visible screen. It
// ignores clicks while the sheet is closed.
export function EarnSheet({
  show,
  onClickOutside,
  children,
}: {
  show: boolean;
  onClickOutside?: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      position="fixed"
      style={{
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: show ? 'auto' : 'none',
        zIndex: zIndexes.BOTTOM_SHEET,
      }}
    >
      <BottomSheet show={show} onClickOutside={onClickOutside}>
        {children}
      </BottomSheet>
    </Box>
  );
}
