import type { ReactNode } from 'react';

import { Box } from '~/design-system';
import { BottomSheet } from '~/design-system/components/BottomSheet/BottomSheet';
import { zIndexes } from '~/entries/popup/utils/zIndexes';

// Rainbow's BottomSheet sits at the bottom of the nearest positioned ancestor,
// so on a scrolled page it opens above the visible area. This fixed wrapper
// follows the screen, and ignores clicks while the sheet is closed.
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
