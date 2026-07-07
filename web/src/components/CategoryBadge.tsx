import { CATEGORY_LABELS } from '@/api';
import { cn } from '@/lib/utils';

// 分类色: 主色薄荷绿留给 login_code (最常用的一类),
// 敏感类用暗红, 其余低饱和, 不和整体暗色主题打架。
const STYLES: Record<string, string> = {
	login_code: 'border-primary/40 bg-primary/10 text-primary',
	registration: 'border-sky-400/40 bg-sky-400/10 text-sky-300',
	payment: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
	password_reset: 'border-red-500/40 bg-red-500/10 text-red-300',
	account_security: 'border-red-500/40 bg-red-500/10 text-red-300',
	legacy: 'border-border bg-transparent text-muted-foreground border-dashed',
	other: 'border-border bg-secondary text-muted-foreground',
};

export function CategoryBadge({ category, className }: { category: string; className?: string }): JSX.Element {
	return (
		<span
			className={cn(
				'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] leading-4',
				STYLES[category] ?? STYLES.other,
				className,
			)}
		>
			{CATEGORY_LABELS[category] ?? category}
		</span>
	);
}
