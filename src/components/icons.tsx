/** 轻量 SVG 图标集（避免引入图标库增大体积） */

type P = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconFolderPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </svg>
);

export const IconDocPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 12v4M10 14h4" />
  </svg>
);

export const IconSettings = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1.5 14h5M9.5 8h5M17.5 16h5" />
  </svg>
);

export const IconChevron = ({ size = 14, open }: P & { open: boolean }) => (
  <svg
    {...base(size)}
    style={{
      transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 0.15s ease',
    }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconBack = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </svg>
);

export const IconTrash = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
);

export const IconRefresh = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
);

export const IconClock = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);

export const IconImport = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export const IconExport = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v12" />
  </svg>
);

export const IconSearch = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

export const IconGripVertical = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="9" cy="6" r="1.3" />
    <circle cx="15" cy="6" r="1.3" />
    <circle cx="9" cy="12" r="1.3" />
    <circle cx="15" cy="12" r="1.3" />
    <circle cx="9" cy="18" r="1.3" />
    <circle cx="15" cy="18" r="1.3" />
  </svg>
);

export const IconExternalLink = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M14 4h6v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4L11 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconShield = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconUsers = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M16.5 14.5c2.8.3 4.5 2.5 4.5 5.5" />
  </svg>
);

export const IconChart = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M7 14l4-4 3 3 5-6" />
  </svg>
);

export const IconDice = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMapPin = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconCopy = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const IconMinimize = ({ size = 12 }: P) => (
  <svg {...base(size)}>
    <path d="M5 12h14" />
  </svg>
);

export const IconMaximize = ({ size = 12 }: P) => (
  <svg {...base(size)}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

export const IconRestore = ({ size = 12 }: P) => (
  <svg {...base(size)}>
    <rect x="5" y="8" width="11" height="11" rx="1.5" />
    <path d="M9 5h8.5A1.5 1.5 0 0 1 19 6.5V15" />
  </svg>
);

export const IconClose = ({ size = 12 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconFocus = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    <path d="M8 12h8" />
  </svg>
);

export const IconCopyChapter = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const IconMore = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSortReverse = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M7 4v13M7 17l-3-3M7 17l3-3" transform="translate(0,1)" />
    <path d="M17 20V7M17 7l-3 3M17 7l3 3" transform="translate(0,-1)" />
  </svg>
);

export const IconTrashRestore = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M3 12a9 9 0 1 0 2.64-6.36" />
    <path d="M3 3v6h6" />
  </svg>
);

export const IconMap = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4" width="7" height="5" rx="1.5" />
    <rect x="14" y="4" width="7" height="5" rx="1.5" />
    <rect x="8.5" y="15" width="7" height="5" rx="1.5" />
    <path d="M6.5 9v3.5h11V9M12 12.5V15" />
  </svg>
);

export const IconOverview = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M3 6h4M3 12h4M3 18h4" />
    <circle cx="13" cy="6" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="18" cy="6" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="10" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconFitView = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </svg>
);

export const IconLink = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5" />
    <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6L12.5 17.5" />
  </svg>
);

export const IconSparkle = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
  </svg>
);
