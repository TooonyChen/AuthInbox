import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Copy, Inbox, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { getJson, type MailDetail, type MailListResponse, type User } from '@/api';
import { CategoryBadge } from '@/components/CategoryBadge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

function formatDate(value: string | null): string {
	if (!value) return '-';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function codeAndLink(value: string | null): { code: string | null; link: string | null } {
	if (!value) return { code: null, link: null };
	const urlMatch = value.match(/https?:\/\/\S+/);
	if (urlMatch) {
		const link = urlMatch[0];
		const beforeUrl = value.slice(0, urlMatch.index).replace(/,\s*$/, '').trim();
		return { code: beforeUrl || null, link };
	}
	return { code: value.trim() || null, link: null };
}

function toPreviewHtml(htmlBody: string, hideRemoteImages: boolean): string {
	const sanitized = DOMPurify.sanitize(htmlBody, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
		FORBID_ATTR: ['onerror', 'onload', 'onclick'],
	});

	const doc = new DOMParser().parseFromString(sanitized, 'text/html');
	if (hideRemoteImages) {
		doc.querySelectorAll('img').forEach((img) => img.remove());
	}
	doc.querySelectorAll('a').forEach((anchor) => {
		anchor.setAttribute('target', '_blank');
		anchor.setAttribute('rel', 'noopener noreferrer');
	});

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		body { margin: 0; padding: 20px; font-family: "Manrope", sans-serif; color: #e5e5e5; background: #000000; line-height: 1.5; }
		a { color: #5fe0c0; }
		pre { white-space: pre-wrap; word-break: break-word; }
		img { max-width: 100%; height: auto; border-radius: 8px; }
	</style>
</head>
<body>${doc.body.innerHTML}</body>
</html>`;
}

function CopyChip({ value, label }: { value: string; label: string }): JSX.Element {
	return (
		<Button
			variant="outline"
			size="sm"
			className="h-7 gap-1.5 text-xs"
			onClick={() => {
				navigator.clipboard.writeText(value);
				toast.success(`${label} copied`);
			}}
		>
			<Copy className="h-3 w-3" />
			Copy {label.toLowerCase()}
		</Button>
	);
}

function ExtractedPanel({ detail }: { detail: MailDetail }): JSX.Element {
	const parsedCode = codeAndLink(detail.code);
	return (
		<div className="space-y-3 rounded-lg border border-border/80 bg-[#111111] p-4 text-sm text-slate-200">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Category:</span>
				<CategoryBadge category={detail.category} />
			</div>
			<div>
				<span className="text-muted-foreground">Topic:</span> {detail.topic || '-'}
			</div>
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Code:</span>
				{parsedCode.code ? <span className="font-mono font-semibold text-primary">{parsedCode.code}</span> : '-'}
				{parsedCode.code ? <CopyChip value={parsedCode.code} label="Code" /> : null}
			</div>
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Link:</span>
				{parsedCode.link ? <CopyChip value={parsedCode.link} label="Link" /> : '-'}
			</div>
		</div>
	);
}

export function InboxPage({ user }: { user: User }): JSX.Element {
	const isAdmin = user.role === 'admin';

	const [page, setPage] = useState(1);
	const [search, setSearch] = useState('');
	const [activeSearch, setActiveSearch] = useState('');
	const [list, setList] = useState<MailListResponse>({ page: 1, pageSize: PAGE_SIZE, total: 0, items: [] });
	const [isListLoading, setIsListLoading] = useState(true);
	const [listError, setListError] = useState<string | null>(null);
	const [selectedMailId, setSelectedMailId] = useState<number | null>(null);

	const [detail, setDetail] = useState<MailDetail | null>(null);
	const [isDetailLoading, setIsDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [hideRemoteImages, setHideRemoteImages] = useState(true);

	const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));

	const refreshList = (): void => {
		setIsListLoading(true);
		setListError(null);
		const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
		if (activeSearch) params.set('service', activeSearch);

		getJson<MailListResponse>(`/api/mails?${params.toString()}`)
			.then((payload) => {
				setList(payload);
				setSelectedMailId((previousId) => {
					if (previousId && payload.items.some((item) => item.id === previousId)) {
						return previousId;
					}
					return payload.items[0]?.id ?? null;
				});
			})
			.catch((error: unknown) => {
				setListError(error instanceof Error ? error.message : 'Unable to load mail list.');
			})
			.finally(() => setIsListLoading(false));
	};

	useEffect(() => {
		refreshList();
	}, [page, activeSearch]);

	useEffect(() => {
		if (!selectedMailId) {
			setDetail(null);
			return;
		}
		setHideRemoteImages(true);
		setDetailError(null);
		setIsDetailLoading(true);

		getJson<MailDetail>(`/api/mails/${selectedMailId}`)
			.then(setDetail)
			.catch((error: unknown) => {
				setDetailError(error instanceof Error ? error.message : 'Unable to load mail details.');
			})
			.finally(() => setIsDetailLoading(false));
	}, [selectedMailId]);

	const previewHtml = useMemo(() => {
		if (!detail?.htmlBody) return null;
		return toPreviewHtml(detail.htmlBody, hideRemoteImages);
	}, [detail?.htmlBody, hideRemoteImages]);

	return (
		<div className="grid gap-6 lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle className="flex items-center gap-2">
						<Inbox className="h-4 w-4 text-primary" />
						Mail List
					</CardTitle>
					<div className="text-xs text-muted-foreground">
						{list.total} entries · page {page} / {totalPages}
					</div>
				</CardHeader>

				<div className="mb-3 flex gap-2">
					<div className="relative flex-1">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder="Filter by sender, e.g. netflix"
							className="pl-8"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									setPage(1);
									setActiveSearch(search.trim());
								}
							}}
						/>
					</div>
					<Button
						variant="outline"
						onClick={() => {
							setPage(1);
							setActiveSearch(search.trim());
							if (search.trim() === activeSearch) refreshList();
						}}
						className="gap-2"
					>
						<RefreshCw className="h-4 w-4" />
						Refresh
					</Button>
				</div>

				{listError ? (
					<div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{listError}</div>
				) : null}

				<div className="overflow-hidden rounded-xl border border-border/80">
					<div className="max-h-[600px] overflow-auto">
						<table className="w-full border-collapse text-sm">
							<thead className="sticky top-0 bg-[#111111] text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
								<tr>
									<th className="px-3 py-3">From</th>
									<th className="hidden px-3 py-3 md:table-cell">To</th>
									<th className="px-3 py-3">Category</th>
									<th className="hidden px-3 py-3 sm:table-cell">Time</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/80">
								{isListLoading ? (
									Array.from({ length: 6 }).map((_, index) => (
										<tr key={`skeleton-${index}`} className="animate-pulse">
											<td className="px-3 py-3"><div className="h-3 w-24 rounded bg-slate-500/30" /></td>
											<td className="hidden px-3 py-3 md:table-cell"><div className="h-3 w-24 rounded bg-slate-500/30" /></td>
											<td className="px-3 py-3"><div className="h-3 w-20 rounded bg-slate-500/30" /></td>
											<td className="hidden px-3 py-3 sm:table-cell"><div className="h-3 w-28 rounded bg-slate-500/30" /></td>
										</tr>
									))
								) : list.items.length === 0 ? (
									<tr>
										<td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
											{activeSearch
												? `No mail matches "${activeSearch}".`
												: isAdmin
													? 'No extracted mails yet.'
													: 'No mail is visible to your account yet. Ask your admin to grant access.'}
										</td>
									</tr>
								) : (
									list.items.map((item) => {
										const active = item.id === selectedMailId;
										return (
											<tr
												key={item.id}
												className={cn(
													'cursor-pointer bg-transparent transition-colors hover:bg-[#1a1a1a]',
													active && 'bg-[#252525]',
												)}
												onClick={() => setSelectedMailId(item.id)}
											>
												<td className="max-w-[150px] px-3 py-3">
													<div className="truncate font-medium text-slate-100">{item.fromOrg || item.fromAddr || '-'}</div>
													<div className="truncate text-xs text-muted-foreground">{item.subject || item.topic || ''}</div>
												</td>
												<td className="hidden max-w-[150px] truncate px-3 py-3 font-mono text-xs text-slate-300 md:table-cell">
													{item.toAddr || '-'}
												</td>
												<td className="px-3 py-3">
													<CategoryBadge category={item.category} />
												</td>
												<td className="hidden whitespace-nowrap px-3 py-3 text-xs text-muted-foreground sm:table-cell">
													{formatDate(item.createdAt)}
												</td>
											</tr>
										);
									})
								)}
							</tbody>
						</table>
					</div>
				</div>

				<div className="mt-4 flex items-center justify-between">
					<Button variant="ghost" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isListLoading}>
						Previous
					</Button>
					<Button
						variant="ghost"
						onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
						disabled={page >= totalPages || isListLoading}
					>
						Next
					</Button>
				</div>
			</Card>

			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle>Mail Detail</CardTitle>
				</CardHeader>

				{detailError ? (
					<div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{detailError}</div>
				) : null}

				{!selectedMailId ? (
					<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
						Select one row from the list to inspect details.
					</div>
				) : isDetailLoading ? (
					<div className="space-y-3">
						<div className="h-4 w-1/2 animate-pulse rounded bg-slate-500/30" />
						<div className="h-4 w-full animate-pulse rounded bg-slate-500/30" />
						<div className="h-44 w-full animate-pulse rounded bg-slate-500/30" />
					</div>
				) : detail ? (
					<>
						<div className="mb-4 grid gap-2 rounded-lg border border-border/80 bg-[#111111] p-3 text-sm text-slate-300">
							<div><span className="text-muted-foreground">From:</span> {detail.fromOrg || detail.fromAddr || '-'}</div>
							<div>
								<span className="text-muted-foreground">To:</span>{' '}
								<span className="font-mono text-xs">{detail.toAddr || '-'}</span>
							</div>
							<div><span className="text-muted-foreground">Subject:</span> {detail.subject || '-'}</div>
							<div><span className="text-muted-foreground">Received:</span> {formatDate(detail.createdAt)}</div>
						</div>

						{isAdmin ? (
							<Tabs defaultValue="parsed">
								<TabsList>
									<TabsTrigger value="parsed">Extracted</TabsTrigger>
									<TabsTrigger value="raw">Raw Email</TabsTrigger>
									<TabsTrigger value="rendered">Rendered</TabsTrigger>
								</TabsList>

								<TabsContent value="parsed">
									<ExtractedPanel detail={detail} />
								</TabsContent>

								<TabsContent value="raw">
									<pre className="max-h-[420px] overflow-auto rounded-lg border border-border/80 bg-[#0a0a0a] p-4 font-mono text-xs leading-6 text-slate-300">
										{detail.raw || 'No raw email payload saved.'}
									</pre>
								</TabsContent>

								<TabsContent value="rendered">
									<div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
										<div>HTML is sanitized before preview and loaded in a sandboxed iframe.</div>
										<label className="inline-flex cursor-pointer items-center gap-2">
											<input
												type="checkbox"
												className="h-4 w-4 accent-primary"
												checked={hideRemoteImages}
												onChange={(event) => setHideRemoteImages(event.target.checked)}
											/>
											Hide remote images
										</label>
									</div>

									{previewHtml ? (
										<iframe
											title="mail-preview"
											sandbox=""
											srcDoc={previewHtml}
											className="h-[460px] w-full rounded-lg border border-border bg-[#000000]"
										/>
									) : detail.textBody ? (
										<pre className="max-h-[420px] overflow-auto rounded-lg border border-border/80 bg-[#0a0a0a] p-4 font-mono text-xs leading-6 text-slate-300">
											{detail.textBody}
										</pre>
									) : (
										<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
											No renderable body found for this email.
										</div>
									)}
								</TabsContent>
							</Tabs>
						) : (
							<>
								<ExtractedPanel detail={detail} />
								<p className="mt-3 text-xs text-muted-foreground">
									You see the extracted fields. The original message is only visible to admins.
								</p>
							</>
						)}
					</>
				) : (
					<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No details loaded.</div>
				)}
			</Card>
		</div>
	);
}
