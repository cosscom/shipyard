export const chartCenterContainerClassName =
  "@container/chart-center size-full min-w-0";

/** Primary stat — ~22% of center width, clamped between 12px and 30px. */
export const chartCenterValueClassName =
  "font-bold tabular-nums leading-none text-[clamp(0.75rem,22cqw,1.875rem)]";

/** Supporting label — ~9% of center width, clamped between 10px and 12px. */
export const chartCenterLabelClassName =
  "max-w-full truncate leading-tight text-[clamp(0.625rem,9cqw,0.75rem)]";
