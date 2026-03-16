import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Copy, Inbox, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardHeader, CardTitle } from './components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { cn } from './lib/utils';

const PAGE_SIZE = 20;

type ViewMode = 'inbox' | 'mcp';

interface MailListItem {
	id: number;
	messageId: string | null;
	fromOrg: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	topic: string | null;
	code: string | null;
	createdAt: string | null;
	subject: string | null;
}

interface MailListResponse {
	page: number;
	pageSize: number;
	total: number;
	items: MailListItem[];
}

interface MailDetail {
	id: number;
	messageId: string | null;
	fromOrg: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	subject: string | null;
	topic: string | null;
	code: string | null;
	createdAt: string | null;
	raw: string | null;
	textBody: string | null;
	htmlBody: string | null;
}

interface McpConfigResponse {
	mcpUrl: string;
	configSnippet: string;
}

function formatDate(value: string | null): string {
	if (!value) {
		return '-';
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function codeAndLink(value: string | null): { code: string | null; link: string | null } {
	if (!value) {
		return { code: null, link: null };
	}

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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			Accept: 'application/json',
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
			...(init?.headers ?? {}),
		},
	});

	const text = await response.text();
	const payload = text ? safeParseJson(text) : null;

	if (!response.ok) {
		if (typeof payload === 'string') {
			throw new Error(payload);
		}

		if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
			throw new Error(payload.error);
		}

		throw new Error(`Request failed (${response.status})`);
	}

	return payload as T;
}

function safeParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function buildPlaceholderMcpConfig(mcpUrl: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				authInbox: {
					url: mcpUrl,
					headers: {
						Authorization: 'Basic <base64(username:password)>',
					},
				},
			},
		},
		null,
		2
	);
}

async function copyText(value: string, successMessage: string): Promise<void> {
	await navigator.clipboard.writeText(value);
	toast.success(successMessage);
}

function App(): JSX.Element {
	const [viewMode, setViewMode] = useState<ViewMode>('inbox');
	const [page, setPage] = useState(1);
	const [list, setList] = useState<MailListResponse>({ page: 1, pageSize: PAGE_SIZE, total: 0, items: [] });
	const [isListLoading, setIsListLoading] = useState(true);
	const [listError, setListError] = useState<string | null>(null);
	const [selectedMailId, setSelectedMailId] = useState<number | null>(null);

	const [detail, setDetail] = useState<MailDetail | null>(null);
	const [isDetailLoading, setIsDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [hideRemoteImages, setHideRemoteImages] = useState(true);

	const [mcpConfig, setMcpConfig] = useState<McpConfigResponse | null>(null);
	const [isMcpLoading, setIsMcpLoading] = useState(false);
	const [mcpError, setMcpError] = useState<string | null>(null);
	const [hasAttemptedMcpConfigLoad, setHasAttemptedMcpConfigLoad] = useState(false);

	const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
	const defaultMcpUrl = useMemo(
		() => (typeof window !== 'undefined' ? `${window.location.origin}/mcp` : '/mcp'),
		[]
	);

	const refreshList = (): void => {
		setIsListLoading(true);
		setListError(null);
		requestJson<MailListResponse>(`/api/mails?page=${page}&pageSize=${PAGE_SIZE}`)
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
			.finally(() => {
				setIsListLoading(false);
			});
	};

	const refreshMcpConfig = (): void => {
		if (isMcpLoading) {
			return;
		}

		setHasAttemptedMcpConfigLoad(true);
		setIsMcpLoading(true);
		setMcpError(null);
		requestJson<McpConfigResponse>('/api/mcp/config')
			.then((payload) => {
				setMcpConfig(payload);
			})
			.catch((error: unknown) => {
				setMcpError(error instanceof Error ? error.message : 'Unable to load MCP config.');
			})
			.finally(() => {
				setIsMcpLoading(false);
			});
	};

	useEffect(() => {
		refreshList();
	}, [page]);

	useEffect(() => {
		if (viewMode === 'mcp' && !hasAttemptedMcpConfigLoad) {
			refreshMcpConfig();
		}
	}, [viewMode, hasAttemptedMcpConfigLoad]);

	useEffect(() => {
		if (!selectedMailId) {
			setDetail(null);
			return;
		}

		setHideRemoteImages(true);
		setDetailError(null);
		setIsDetailLoading(true);

		requestJson<MailDetail>(`/api/mails/${selectedMailId}`)
			.then((payload) => {
				setDetail(payload);
			})
			.catch((error: unknown) => {
				setDetailError(error instanceof Error ? error.message : 'Unable to load mail details.');
			})
			.finally(() => {
				setIsDetailLoading(false);
			});
	}, [selectedMailId]);

	const previewHtml = useMemo(() => {
		if (!detail?.htmlBody) {
			return null;
		}
		return toPreviewHtml(detail.htmlBody, hideRemoteImages);
	}, [detail?.htmlBody, hideRemoteImages]);

	const displayedMcpUrl = mcpConfig?.mcpUrl ?? defaultMcpUrl;
	const displayedConfigSnippet = mcpConfig?.configSnippet ?? buildPlaceholderMcpConfig(displayedMcpUrl);

	return (
		<div className="min-h-screen bg-background text-slate-100">
			<Toaster theme="dark" position="bottom-right" closeButton />
			<div className="pointer-events-none fixed inset-0 bg-[radial-gradient(1200px_500px_at_10%_0%,rgba(95,224,192,0.08),transparent)]" />
			<main className="relative mx-auto w-full max-w-[1300px] px-4 pb-8 pt-6 lg:px-8">
				<header className="mb-6 flex flex-wrap items-end justify-between gap-4">
					<div>
						<div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
							<ShieldCheck className="h-4 w-4" />
							Private Mail Console
						</div>
						<h1 className="font-sans text-3xl font-bold text-slate-100">Auth Inbox</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{viewMode === 'inbox'
								? 'Verification messages, raw source, and sanitized HTML preview.'
								: 'Remote MCP access reuses the same Basic Auth credentials as the admin site.'}
						</p>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<Badge>{viewMode === 'inbox' ? `${list.total} Entries` : 'MCP Ready'}</Badge>
						<Button variant={viewMode === 'inbox' ? 'default' : 'ghost'} onClick={() => setViewMode('inbox')} className="gap-2">
							<Inbox className="h-4 w-4" />
							Inbox
						</Button>
						<Button variant={viewMode === 'mcp' ? 'default' : 'ghost'} onClick={() => setViewMode('mcp')} className="gap-2">
							<KeyRound className="h-4 w-4" />
							MCP
						</Button>
						<Button variant="outline" onClick={viewMode === 'inbox' ? refreshList : refreshMcpConfig} className="gap-2">
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
					</div>
				</header>

				{viewMode === 'inbox' ? (
					<div className="grid gap-6 lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<Inbox className="h-4 w-4 text-primary" />
									Mail List
								</CardTitle>
								<div className="text-xs text-muted-foreground">Page {page} / {totalPages}</div>
							</CardHeader>

							{listError ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{listError}</div> : null}

							<div className="overflow-hidden rounded-xl border border-border/80">
								<div className="max-h-[640px] overflow-auto">
									<table className="w-full border-collapse text-sm">
										<thead className="sticky top-0 bg-[#111111] text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
											<tr>
												<th className="px-3 py-3">From</th>
												<th className="hidden px-3 py-3 sm:table-cell">To</th>
												<th className="px-3 py-3">Subject / Topic</th>
												<th className="hidden px-3 py-3 sm:table-cell">Time</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-border/80">
											{isListLoading ? (
												Array.from({ length: 6 }).map((_, index) => (
													<tr key={`skeleton-${index}`} className="animate-pulse">
														<td className="px-3 py-3"><div className="h-3 w-24 rounded bg-slate-500/30" /></td>
														<td className="hidden px-3 py-3 sm:table-cell"><div className="h-3 w-24 rounded bg-slate-500/30" /></td>
														<td className="px-3 py-3"><div className="h-3 w-56 rounded bg-slate-500/30" /></td>
														<td className="hidden px-3 py-3 sm:table-cell"><div className="h-3 w-28 rounded bg-slate-500/30" /></td>
													</tr>
												))
											) : list.items.length === 0 ? (
												<tr>
													<td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
														No extracted mails available.
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
																active && 'bg-[#252525]'
															)}
															onClick={() => setSelectedMailId(item.id)}
														>
															<td className="max-w-[140px] truncate px-3 py-3 font-medium text-slate-100">{item.fromOrg || item.fromAddr || '-'}</td>
															<td className="hidden max-w-[130px] truncate px-3 py-3 text-slate-300 sm:table-cell">{item.toAddr || '-'}</td>
															<td className="max-w-[200px] truncate px-3 py-3 text-slate-200 sm:max-w-[320px]">{item.subject || item.topic || '-'}</td>
															<td className="hidden whitespace-nowrap px-3 py-3 text-xs text-muted-foreground sm:table-cell">{formatDate(item.createdAt)}</td>
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

						<Card>
							<CardHeader>
								<CardTitle>Mail Detail</CardTitle>
							</CardHeader>

							{detailError ? <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{detailError}</div> : null}

							{!selectedMailId ? (
								<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">Select one row from the list to inspect details.</div>
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
										<div><span className="text-muted-foreground">To:</span> {detail.toAddr || '-'}</div>
										<div><span className="text-muted-foreground">Subject:</span> {detail.subject || '-'}</div>
										<div><span className="text-muted-foreground">Received:</span> {formatDate(detail.createdAt)}</div>
									</div>

									<Tabs defaultValue="parsed">
										<TabsList>
											<TabsTrigger value="parsed">Extracted</TabsTrigger>
											<TabsTrigger value="raw">Raw Email</TabsTrigger>
											<TabsTrigger value="rendered">Rendered</TabsTrigger>
										</TabsList>

										<TabsContent value="parsed">
											<div className="space-y-3 rounded-lg border border-border/80 bg-[#111111] p-4 text-sm text-slate-200">
												<div><span className="text-muted-foreground">Topic:</span> {detail.topic || '-'}</div>
												{(() => {
													const parsedCode = codeAndLink(detail.code);
													return (
														<>
															<div className="flex items-center gap-2">
																<span className="text-muted-foreground">Code:</span>
																{parsedCode.code ? (
																	parsedCode.code.startsWith('http') ? (
																		<Button
																			variant="outline"
																			size="sm"
																			className="h-7 gap-1.5 text-xs"
																			onClick={() => {
																				void copyText(parsedCode.code!, 'Code copied');
																			}}
																		>
																			<Copy className="h-3 w-3" />
																			Copy code
																		</Button>
																	) : (
																		<span className="font-mono font-semibold text-primary">{parsedCode.code}</span>
																	)
																) : '-'}
															</div>
															<div className="flex items-center gap-2">
																<span className="text-muted-foreground">Link:</span>
																{parsedCode.link ? (
																	<Button
																		variant="outline"
																		size="sm"
																		className="h-7 gap-1.5 text-xs"
																		onClick={() => {
																			void copyText(parsedCode.link!, 'Link copied');
																		}}
																	>
																		<Copy className="h-3 w-3" />
																		Copy link
																	</Button>
																) : '-'}
															</div>
														</>
													);
												})()}
											</div>
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
								</>
							) : (
								<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No details loaded.</div>
							)}
						</Card>
					</div>
				) : (
					<div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] [&>*]:min-w-0">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<KeyRound className="h-4 w-4 text-primary" />
									Remote MCP Config
								</CardTitle>
							</CardHeader>

							{mcpError ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{mcpError}</div> : null}

							<div className="space-y-4 text-sm text-slate-200">
								<div className="rounded-lg border border-border/80 bg-[#111111] p-4">
									<div className="mb-2 text-xs uppercase tracking-[0.08em] text-muted-foreground">How It Works</div>
									<p className="text-sm text-slate-300">
										The MCP endpoint reuses the same Basic Auth as the whole site. Configure the same username and password in
										your MCP client. This page only shows a template and does not expose the live <code>Authorization</code>{' '}
										header from the current browser session.
									</p>
								</div>

								<div className="rounded-lg border border-border/80 bg-[#111111] p-4">
									<div className="mb-3 grid gap-3 sm:grid-cols-2">
										<div>
											<div className="mb-1 text-xs uppercase tracking-[0.08em] text-muted-foreground">Endpoint</div>
											<div className="rounded-md border border-border bg-black/40 px-3 py-2 font-mono text-xs break-all">
												{displayedMcpUrl}
											</div>
										</div>
										<div>
											<div className="mb-1 text-xs uppercase tracking-[0.08em] text-muted-foreground">Header</div>
											<div className="rounded-md border border-border bg-black/40 px-3 py-2 font-mono text-xs break-all">
												Authorization: Basic &lt;base64(username:password)&gt;
											</div>
										</div>
									</div>

									<div className="flex flex-wrap gap-2">
										<Button variant="outline" size="sm" className="gap-2" onClick={() => { void copyText(displayedMcpUrl, 'MCP URL copied'); }}>
											<Copy className="h-3.5 w-3.5" />
											Copy URL
										</Button>
										<Button
											variant="outline"
											size="sm"
											className="gap-2"
											onClick={() => {
												void copyText(displayedConfigSnippet, 'MCP config copied');
											}}
										>
											<Copy className="h-3.5 w-3.5" />
											Copy Config
										</Button>
									</div>
								</div>

								<div>
									<div className="mb-2 text-xs uppercase tracking-[0.08em] text-muted-foreground">Client Config</div>
									<pre className="max-h-[420px] overflow-auto rounded-lg border border-border/80 bg-[#0a0a0a] p-4 font-mono text-xs leading-6 text-slate-300">
										{isMcpLoading && !mcpConfig ? 'Loading MCP config...' : displayedConfigSnippet}
									</pre>
								</div>
							</div>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Available Tools</CardTitle>
							</CardHeader>

							<div className="space-y-4 text-sm text-slate-300">
								<div className="rounded-lg border border-border/80 bg-[#111111] p-4">
									<div className="font-medium text-slate-100"><code>get_latest_mail</code></div>
									<p className="mt-1 text-sm text-slate-300">Returns the latest extracted mail details, including decoded text and HTML bodies.</p>
								</div>

								<div className="rounded-lg border border-border/80 bg-[#111111] p-4">
									<div className="font-medium text-slate-100"><code>get_multiple_mail</code></div>
									<p className="mt-1 text-sm text-slate-300">Returns the latest extracted mails sorted newest first. Default is 5 and the client can pass <code>limit</code>.</p>
								</div>

								<div className="rounded-lg border border-border/80 bg-[#111111] p-4">
									<div className="mb-2 text-xs uppercase tracking-[0.08em] text-muted-foreground">Notes</div>
									<ul className="space-y-2 text-sm">
										<li>The MCP endpoint is <code>POST {displayedMcpUrl}</code>.</li>
										<li>Keep sending the same Basic Auth header after initialize.</li>
										<li>If you later want separate per-agent credentials, we can add tokenized API keys on top.</li>
									</ul>
								</div>
							</div>
						</Card>
					</div>
				)}
			</main>
		</div>
	);
}

export default App;
