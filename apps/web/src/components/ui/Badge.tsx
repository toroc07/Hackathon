import type { HTMLAttributes } from 'react';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> { tone?: Tone }

const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  info: 'bg-blue-100 text-blue-800',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-800',
};

export function Badge({ className = '', tone = 'neutral', ...props }: BadgeProps) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]} ${className}`} {...props} />;
}
