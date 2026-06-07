import type { AllocationSlice } from "../types";

type AllocationDonutProps = {
  data: AllocationSlice[];
  size?: number;
};

const fallbackColors = ["#00c805", "#18181b", "#71717a", "#d4d4d8", "#ef4444", "#f59e0b"];

export function AllocationDonut({ data, size = 176 }: AllocationDonutProps) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0) || 1;
  let offset = 0;

  return (
    <div className="flex items-center gap-6">
      <svg width={size} height={size} viewBox="0 0 42 42" className="-rotate-90">
        <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#f4f4f5" strokeWidth="5" />
        {data.map((slice, index) => {
          const dash = (slice.value / total) * 100;
          const currentOffset = offset;
          offset += dash;

          return (
            <circle
              key={slice.label}
              cx="21"
              cy="21"
              r="15.915"
              fill="transparent"
              stroke={slice.color ?? fallbackColors[index % fallbackColors.length]}
              strokeDasharray={`${dash} ${100 - dash}`}
              strokeDashoffset={-currentOffset}
              strokeWidth="5"
            />
          );
        })}
      </svg>
      <div className="min-w-0 space-y-2">
        {data.map((slice, index) => (
          <div key={slice.label} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: slice.color ?? fallbackColors[index % fallbackColors.length] }}
            />
            <span className="text-zinc-600">{slice.label}</span>
            <span className="font-medium text-zinc-950">{Math.round((slice.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
