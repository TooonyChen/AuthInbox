import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
	Archive,
	Bell,
	ChevronLeft,
	ChevronRight,
	Copy,
	Inbox,
	Menu,
	RefreshCw,
	Search,
	Settings,
	ShieldCheck,
	Star,
	Trash2,
	X,
} from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';

type DensityMode = 'default' | 'comfortable' | 'compact';
type ReadingPaneMode = 'none' | 'right' | 'bottom';
type ThemeMode = 'dark' | 'light' | 'system';
type InboxView = 'inbox' | 'starred' | 'important' | 'unread' | 'archive' | 'trash' | 'snoozed';
type CategoryView = 'all' | 'primary' | 'social' | 'promotions' | 'updates' | 'forums';
type ThreadAction =
	| 'read'
	| 'unread'
	| 'star'
	| 'unstar'
	| 'archive'
	| 'unarchive'
	| 'delete'
	| 'restore'
	| 'important'
	| 'not-important'
	| 'snooze'
	| 'label-add'
	| 'label-remove';

interface MailThreadItem {
	id: number;
	threadId: string;
	messageId: string | null;
	fromAddr: string | null;
	fromOrg: string | null;
	toAddr: string | null;
	subject: string | null;
	topic: string | null;
	code: string | null;
	snippet: string;
	createdAt: string | null;
	isRead: boolean;
	isStarred: boolean;
	isArchived: boolean;
	isDeleted: boolean;
	isImportant: boolean;
	isMuted: boolean;
	category: Exclude<CategoryView, 'all'>;
	labels: string[];
	hasCode: boolean;
	hasHtml: boolean;
	snoozedUntil: string | null;
}

interface MailThreadsResponse {
	page: number;
	pageSize: number;
	total: number;
	items: MailThreadItem[];
}

interface MailThreadDetail extends MailThreadItem {
	raw: string | null;
	textBody: string | null;
	htmlBody: string | null;
}

interface UiSettings {
	density: DensityMode;
	readingPane: ReadingPaneMode;
	theme: ThemeMode;
	shortcutsEnabled: boolean;
}

interface SessionPayload {
	authenticated: boolean;
	username?: string;
	method?: 'basic' | 'session';
	csrfToken?: string | null;
}

const PAGE_SIZE = 30;
const DEFAULT_SETTINGS: UiSettings = {
	density: 'default',
	readingPane: 'right',
	theme: 'dark',
	shortcutsEnabled: true,
};

const CATEGORY_TABS: Array<{ id: CategoryView; label: string }> = [
	{ id: 'all', label: 'All' },
	{ id: 'primary', label: 'Primary' },
	{ id: 'social', label: 'Social' },
	{ id: 'promotions', label: 'Promotions' },
	{ id: 'updates', label: 'Updates' },
	{ id: 'forums', label: 'Forums' },
];

const INBOX_ITEMS: Array<{ id: InboxView; label: string }> = [
	{ id: 'inbox', label: 'Inbox' },
	{ id: 'starred', label: 'Starred' },
	{ id: 'important', label: 'Important' },
	{ id: 'unread', label: 'Unread' },
	{ id: 'archive', label: 'Archive' },
	{ id: 'snoozed', label: 'Snoozed' },
	{ id: 'trash', label: 'Trash' },
];

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function formatDate(value: string | null): string {
	if (!value) return '-';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear()
		&& now.getMonth() === date.getMonth()
		&& now.getDate() === date.getDate();
	if (sameDay) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
	return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDateLong(value: string | null): string {
	if (!value) return '-';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function codeAndLink(value: string | null): { code: string | null; link: string | null } {
	if (!value) return { code: null, link: null };
	const urlMatch = value.match(/https?:\/\/\S+/);
	if (urlMatch) {
		const link = urlMatch[0];
		const before = value.slice(0, urlMatch.index).replace(/,\s*$/, '').trim();
		return { code: before || null, link };
	}
	return { code: value.trim() || null, link: null };
}

function toPreviewHtml(htmlBody: string, hideRemoteImages: boolean, theme: 'dark' | 'light'): string {
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

	const isDark = theme === 'dark';
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		body { margin: 0; padding: 20px; font-family: "Roboto", "Segoe UI", sans-serif; color: ${isDark ? '#e8eaed' : '#202124'}; background: ${isDark ? '#202124' : '#ffffff'}; line-height: 1.5; }
		a { color: ${isDark ? '#8ab4f8' : '#1a73e8'}; }
		pre { white-space: pre-wrap; word-break: break-word; }
		img { max-width: 100%; height: auto; border-radius: 8px; }
	</style>
</head>
<body>${doc.body.innerHTML}</body>
</html>`;
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!response.ok) {
		const text = await response.text();
		throw new HttpError(response.status, text || `Request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

async function sendJson<TResponse>(
	url: string,
	body: unknown,
	method: 'POST' | 'PUT' = 'POST',
	csrfToken?: string
): Promise<TResponse> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
	};
	if (csrfToken) {
		headers['x-csrf-token'] = csrfToken;
	}

	const response = await fetch(url, {
		method,
		headers,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new HttpError(response.status, text || `Request failed (${response.status})`);
	}
	return (await response.json()) as TResponse;
}

function isEditableElement(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName.toLowerCase();
	return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function rowDensityClass(density: DensityMode): string {
	if (density === 'compact') return 'min-h-11 py-1.5';
	if (density === 'comfortable') return 'min-h-14 py-2.5';
	return 'min-h-16 py-3';
}

function App(): JSX.Element {
	const [settings, setSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
	const [systemThemeDark, setSystemThemeDark] = useState(true);
	const [showSettingsPanel, setShowSettingsPanel] = useState(false);
	const [showShortcutHelp, setShowShortcutHelp] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [isAuthLoading, setIsAuthLoading] = useState(true);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [authMethod, setAuthMethod] = useState<'basic' | 'session' | null>(null);
	const [authUser, setAuthUser] = useState<string | null>(null);
	const [csrfToken, setCsrfToken] = useState('');
	const [loginUsername, setLoginUsername] = useState('admin');
	const [loginPassword, setLoginPassword] = useState('');
	const [loginError, setLoginError] = useState<string | null>(null);
	const [isLoginSubmitting, setIsLoginSubmitting] = useState(false);

	const [inbox, setInbox] = useState<InboxView>('inbox');
	const [category, setCategory] = useState<CategoryView>('all');
	const [page, setPage] = useState(1);
	const [queryInput, setQueryInput] = useState('');
	const [query, setQuery] = useState('');

	const [list, setList] = useState<MailThreadsResponse>({ page: 1, pageSize: PAGE_SIZE, total: 0, items: [] });
	const [isListLoading, setIsListLoading] = useState(true);
	const [listError, setListError] = useState<string | null>(null);

	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [selectedIds, setSelectedIds] = useState<number[]>([]);
	const [detail, setDetail] = useState<MailThreadDetail | null>(null);
	const [isDetailLoading, setIsDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailTab, setDetailTab] = useState<'extracted' | 'raw' | 'rendered'>('extracted');
	const [hideRemoteImages, setHideRemoteImages] = useState(true);
	const [singlePaneOpen, setSinglePaneOpen] = useState(false);
	const [isActionLoading, setIsActionLoading] = useState(false);

	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const comboRef = useRef<string | null>(null);
	const comboTimeoutRef = useRef<number | null>(null);
	const currentPath = typeof window === 'undefined' ? '/' : window.location.pathname;
	const isLoginRoute = currentPath === '/login';

	const effectiveTheme: 'dark' | 'light' =
		settings.theme === 'system' ? (systemThemeDark ? 'dark' : 'light') : settings.theme;
	const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));

	const handleUnauthorized = useCallback((error: unknown): boolean => {
		if (error instanceof HttpError && error.status === 401) {
			setIsAuthenticated(false);
			setAuthMethod(null);
			setAuthUser(null);
			setCsrfToken('');
			if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
				window.location.replace('/login');
			}
			return true;
		}
		return false;
	}, []);

	const loadSession = useCallback(async (): Promise<void> => {
		try {
			const payload = await fetchJson<SessionPayload>('/auth/session');
			setIsAuthenticated(Boolean(payload.authenticated));
			setAuthMethod(payload.method === 'basic' || payload.method === 'session' ? payload.method : null);
			setAuthUser(payload.username ?? null);
			setCsrfToken(payload.csrfToken ?? '');
		} catch (error) {
			if (error instanceof HttpError && error.status === 401) {
				setIsAuthenticated(false);
				setAuthMethod(null);
				setAuthUser(null);
				setCsrfToken('');
			} else {
				console.error(error);
			}
		} finally {
			setIsAuthLoading(false);
		}
	}, []);

	const loadSettings = useCallback(async (): Promise<void> => {
		if (!isAuthenticated) return;
		try {
			const payload = await fetchJson<UiSettings>('/api/v2/settings');
			setSettings(payload);
		} catch (error) {
			if (handleUnauthorized(error)) return;
			console.error(error);
		}
	}, [handleUnauthorized, isAuthenticated]);

	const updateSettings = useCallback(
		async (patch: Partial<UiSettings>): Promise<void> => {
			const previous = settings;
			const next = { ...settings, ...patch };
			setSettings(next);
			try {
				const payload = await sendJson<UiSettings>('/api/v2/settings', next, 'PUT', csrfToken);
				setSettings(payload);
			} catch (error) {
				if (handleUnauthorized(error)) return;
				setSettings(previous);
				toast.error(error instanceof Error ? error.message : 'Unable to update settings');
			}
		},
		[csrfToken, handleUnauthorized, settings]
	);

	const loadList = useCallback(async (): Promise<void> => {
		if (!isAuthenticated) return;
		setIsListLoading(true);
		setListError(null);
		try {
			const params = new URLSearchParams();
			params.set('page', String(page));
			params.set('pageSize', String(PAGE_SIZE));
			params.set('inbox', inbox);
			if (category !== 'all') params.set('category', category);
			if (query.trim()) params.set('q', query.trim());

			const payload = await fetchJson<MailThreadsResponse>(`/api/v2/threads?${params.toString()}`);
			setList(payload);
			setSelectedIds((prev) => prev.filter((id) => payload.items.some((item) => item.id === id)));
			setSelectedId((prev) => {
				if (prev && payload.items.some((item) => item.id === prev)) return prev;
				return payload.items[0]?.id ?? null;
			});
		} catch (error) {
			if (handleUnauthorized(error)) return;
			setListError(error instanceof Error ? error.message : 'Unable to load threads');
		} finally {
			setIsListLoading(false);
		}
	}, [category, handleUnauthorized, inbox, isAuthenticated, page, query]);

	const loadDetail = useCallback(async (id: number): Promise<void> => {
		if (!isAuthenticated) return;
		setIsDetailLoading(true);
		setDetailError(null);
		setHideRemoteImages(true);
		try {
			const payload = await fetchJson<MailThreadDetail>(`/api/v2/threads/${id}`);
			setDetail(payload);
		} catch (error) {
			if (handleUnauthorized(error)) return;
			setDetailError(error instanceof Error ? error.message : 'Unable to load thread detail');
		} finally {
			setIsDetailLoading(false);
		}
	}, [handleUnauthorized, isAuthenticated]);

	const selectionIds = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];

	const runAction = useCallback(
		async (action: ThreadAction, extra: Record<string, unknown> = {}): Promise<void> => {
			if (selectionIds.length === 0) {
				toast.message('Select at least one email');
				return;
			}
			setIsActionLoading(true);
			try {
				await sendJson('/api/v2/threads/actions', {
					action,
					ids: selectionIds,
					...extra,
				}, 'POST', csrfToken);
				await loadList();
				if (selectedId && selectionIds.includes(selectedId)) {
					await loadDetail(selectedId);
				}
			} catch (error) {
				if (handleUnauthorized(error)) return;
				toast.error(error instanceof Error ? error.message : 'Action failed');
			} finally {
				setIsActionLoading(false);
			}
		},
		[csrfToken, handleUnauthorized, loadDetail, loadList, selectedId, selectionIds]
	);

	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const sync = (): void => setSystemThemeDark(media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	}, []);

	useEffect(() => {
		void loadSession();
	}, [loadSession]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		if (!isAuthLoading && !isAuthenticated && !isLoginRoute) {
			window.location.replace('/login');
		}
	}, [isAuthLoading, isAuthenticated, isLoginRoute]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		if (!isAuthLoading && isAuthenticated && isLoginRoute && authMethod === 'session') {
			window.location.replace('/');
		}
	}, [authMethod, isAuthLoading, isAuthenticated, isLoginRoute]);

	useEffect(() => {
		if (!isAuthenticated) return;
		void loadSettings();
	}, [isAuthenticated, loadSettings]);

	useEffect(() => {
		if (!isAuthenticated) return;
		void loadList();
	}, [isAuthenticated, loadList]);

	useEffect(() => {
		if (!isAuthenticated) {
			setDetail(null);
			return;
		}
		if (!selectedId) {
			setDetail(null);
			return;
		}
		void loadDetail(selectedId);
	}, [isAuthenticated, loadDetail, selectedId]);

	useEffect(() => {
		if (!isAuthenticated) return undefined;
		if (!settings.shortcutsEnabled) return undefined;

		const clearCombo = (): void => {
			comboRef.current = null;
			if (comboTimeoutRef.current) {
				window.clearTimeout(comboTimeoutRef.current);
				comboTimeoutRef.current = null;
			}
		};

		const onKeyDown = (event: KeyboardEvent): void => {
			if (isEditableElement(event.target)) return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const key = event.key.toLowerCase();

			if (comboRef.current === 'g') {
				clearCombo();
				if (key === 'i') {
					event.preventDefault();
					setInbox('inbox');
					setPage(1);
					return;
				}
				if (key === 's') {
					event.preventDefault();
					setInbox('starred');
					setPage(1);
					return;
				}
				if (key === 'a') {
					event.preventDefault();
					setInbox('archive');
					setPage(1);
					return;
				}
				if (key === 'u') {
					event.preventDefault();
					setInbox('unread');
					setPage(1);
					return;
				}
			}

			if (key === 'g') {
				comboRef.current = 'g';
				if (comboTimeoutRef.current) {
					window.clearTimeout(comboTimeoutRef.current);
				}
				comboTimeoutRef.current = window.setTimeout(clearCombo, 1500);
				return;
			}

			if (key === '/') {
				event.preventDefault();
				searchInputRef.current?.focus();
				return;
			}

			if (key === '?') {
				event.preventDefault();
				setShowShortcutHelp(true);
				return;
			}

			if (list.items.length === 0) return;
			const currentIndex = list.items.findIndex((item) => item.id === selectedId);

			if (key === 'j') {
				event.preventDefault();
				const next = list.items[Math.min(list.items.length - 1, Math.max(0, currentIndex + 1))];
				if (next) setSelectedId(next.id);
				return;
			}

			if (key === 'k') {
				event.preventDefault();
				const next = list.items[Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1)];
				if (next) setSelectedId(next.id);
				return;
			}

			if (key === 'x' && selectedId) {
				event.preventDefault();
				setSelectedIds((prev) => (prev.includes(selectedId) ? prev.filter((id) => id !== selectedId) : [...prev, selectedId]));
				return;
			}

			if (key === 'u') {
				event.preventDefault();
				setSelectedIds([]);
				return;
			}

			if (key === 'e') {
				event.preventDefault();
				void runAction('archive');
				return;
			}

			if (key === '#') {
				event.preventDefault();
				void runAction('delete');
				return;
			}

			if (key === 's' && selectedId) {
				event.preventDefault();
				const current = list.items.find((item) => item.id === selectedId);
				void runAction(current?.isStarred ? 'unstar' : 'star');
				return;
			}

			if (event.shiftKey && key === 'i') {
				event.preventDefault();
				void runAction('read');
				return;
			}

			if (event.shiftKey && key === 'u') {
				event.preventDefault();
				void runAction('unread');
				return;
			}
		};

		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			clearCombo();
		};
	}, [isAuthenticated, list.items, runAction, selectedId, settings.shortcutsEnabled]);

	const previewHtml = useMemo(() => {
		if (!detail?.htmlBody) return null;
		return toPreviewHtml(detail.htmlBody, hideRemoteImages, effectiveTheme);
	}, [detail?.htmlBody, effectiveTheme, hideRemoteImages]);

	const selectThread = (id: number): void => {
		setSelectedId(id);
		if (settings.readingPane === 'none') {
			setSinglePaneOpen(true);
		}
	};

	const applySearch = (next: string): void => {
		setQuery(next.trim());
		setPage(1);
	};

	const applySearchToken = (token: string): void => {
		const current = queryInput.trim();
		const next = current ? `${current} ${token}` : token;
		setQueryInput(next);
		applySearch(next);
	};

	const submitLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		setIsLoginSubmitting(true);
		setLoginError(null);
		try {
			const payload = await sendJson<SessionPayload>('/auth/login', {
				username: loginUsername.trim(),
				password: loginPassword,
			});
			setIsAuthenticated(Boolean(payload.authenticated));
			setAuthMethod(payload.method === 'basic' || payload.method === 'session' ? payload.method : 'session');
			setAuthUser(payload.username ?? loginUsername.trim());
			setCsrfToken(payload.csrfToken ?? '');
			setLoginPassword('');
			if (typeof window !== 'undefined') {
				window.location.replace('/');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to sign in';
			setLoginError(message);
		} finally {
			setIsLoginSubmitting(false);
		}
	};

	const logout = async (): Promise<void> => {
		try {
			await sendJson('/auth/logout', {}, 'POST', csrfToken);
		} catch (error) {
			console.error(error);
		} finally {
			setIsAuthenticated(false);
			setAuthMethod(null);
			setAuthUser(null);
			setCsrfToken('');
			if (typeof window !== 'undefined') {
				window.location.replace('/login');
			}
		}
	};

	const showDetailPane = settings.readingPane !== 'none' || singlePaneOpen;
	const shouldShowLogin = !isAuthenticated || (isLoginRoute && authMethod === 'basic');

	if (isAuthLoading) {
		return (
			<div className={cn('gmail-root min-h-screen', effectiveTheme === 'light' ? 'theme-light' : 'theme-dark')}>
				<div className="flex min-h-screen items-center justify-center">
					<div className="auth-card animate-pulse rounded-3xl border p-8 text-center">
						<div className="mb-2 text-sm text-muted-foreground">AuthInbox</div>
						<div className="text-lg font-semibold">Validating session...</div>
					</div>
				</div>
			</div>
		);
	}

	if (shouldShowLogin) {
		return (
			<div className={cn('gmail-root login-page min-h-screen', effectiveTheme === 'light' ? 'theme-light' : 'theme-dark')}>
				<Toaster theme={effectiveTheme === 'light' ? 'light' : 'dark'} position="bottom-right" closeButton />
				<div className="login-bg-orb login-bg-orb-left" />
				<div className="login-bg-orb login-bg-orb-right" />
				<div className="flex min-h-screen items-center justify-center p-4">
					<form onSubmit={submitLogin} className="auth-card auth-card-in w-full max-w-md rounded-3xl border p-7 shadow-2xl">
						<div className="mb-6">
							<div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
								<ShieldCheck className="h-4 w-4 text-primary" />
								Secure Access
							</div>
							<h1 className="font-sans text-3xl font-bold">Sign in</h1>
							<p className="mt-2 text-sm text-muted-foreground">Use your AuthInbox admin credentials.</p>
						</div>

						<div className="space-y-4">
							<label className="block text-sm">
								<span className="mb-1 block text-muted-foreground">Username</span>
								<input
									type="text"
									autoComplete="username"
									value={loginUsername}
									onChange={(event) => setLoginUsername(event.target.value)}
									required
									className="w-full rounded-xl border bg-background px-3 py-2 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
								/>
							</label>
							<label className="block text-sm">
								<span className="mb-1 block text-muted-foreground">Password</span>
								<input
									type="password"
									autoComplete="current-password"
									value={loginPassword}
									onChange={(event) => setLoginPassword(event.target.value)}
									required
									className="w-full rounded-xl border bg-background px-3 py-2 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
								/>
							</label>
							{loginError ? (
								<div className="auth-error-shake rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
									{loginError}
								</div>
							) : null}
							<Button type="submit" className="h-10 w-full" disabled={isLoginSubmitting}>
								{isLoginSubmitting ? (
									<span className="inline-flex items-center gap-2">
										<RefreshCw className="h-4 w-4 animate-spin" />
										Signing in...
									</span>
								) : (
									'Sign in'
								)}
							</Button>
						</div>
					</form>
				</div>
			</div>
		);
	}

	return (
		<div className={cn('gmail-root min-h-screen', effectiveTheme === 'light' ? 'theme-light' : 'theme-dark')}>
			<Toaster theme={effectiveTheme === 'light' ? 'light' : 'dark'} position="bottom-right" closeButton />

			<header className="gmail-topbar sticky top-0 z-40 flex items-center gap-3 border-b px-3 py-2 sm:px-4">
				<Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen((open) => !open)}>
					<Menu className="h-5 w-5" />
				</Button>
				<div className="flex min-w-[145px] items-center gap-2">
					<ShieldCheck className="h-5 w-5 text-primary" />
					<div className="font-semibold tracking-tight">AuthInbox Mail</div>
				</div>

				<form
					className="gmail-search flex-1"
					onSubmit={(event) => {
						event.preventDefault();
						applySearch(queryInput);
					}}
				>
					<Search className="h-4 w-4 text-muted-foreground" />
					<input
						ref={searchInputRef}
						type="text"
						value={queryInput}
						onChange={(event) => setQueryInput(event.target.value)}
						placeholder="Search mail (from:, subject:, is:, has:, in:, category:)"
						className="flex-1 border-0 bg-transparent text-sm outline-none"
					/>
					{queryInput ? (
						<button
							type="button"
							onClick={() => {
								setQueryInput('');
								applySearch('');
							}}
							className="rounded p-1 text-muted-foreground hover:bg-accent"
						>
							<X className="h-4 w-4" />
						</button>
					) : null}
				</form>

				<div className="flex items-center gap-1">
					<span className="hidden text-xs text-muted-foreground md:inline">{authUser ? `@${authUser}` : ''}</span>
					<Button variant="ghost" size="icon" onClick={() => void loadList()} disabled={isListLoading}>
						<RefreshCw className={cn('h-4 w-4', isListLoading && 'animate-spin')} />
					</Button>
					<Button variant="ghost" size="icon" onClick={() => setShowSettingsPanel((open) => !open)}>
						<Settings className="h-4 w-4" />
					</Button>
					<Button variant="ghost" size="sm" onClick={() => void logout()} className="ml-1">
						Log out
					</Button>
				</div>
			</header>

			<div className="relative flex min-h-[calc(100vh-57px)]">
				<aside
					className={cn(
						'gmail-sidebar fixed inset-y-[57px] left-0 z-30 w-[248px] border-r p-3 transition-transform md:static md:translate-x-0',
						sidebarOpen ? 'translate-x-0' : '-translate-x-full'
					)}
				>
					<div className="space-y-1">
						{INBOX_ITEMS.map((item) => (
							<button
								key={item.id}
								onClick={() => {
									setInbox(item.id);
									setPage(1);
									setSidebarOpen(false);
								}}
								className={cn(
									'w-full rounded-2xl px-4 py-2 text-left text-sm transition-colors',
									inbox === item.id ? 'bg-primary/20 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent'
								)}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="mt-6 border-t pt-4">
						<div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Search chips</div>
						<div className="flex flex-wrap gap-2">
							{['is:unread', 'has:attachment', 'category:promotions', 'from:noreply'].map((chip) => (
								<button
									key={chip}
									onClick={() => applySearchToken(chip)}
									className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
								>
									{chip}
								</button>
							))}
						</div>
					</div>
				</aside>

				<main className="flex-1 overflow-hidden">
					<div className="flex h-full flex-col">
						<div className="border-b px-3 pb-2 pt-3 sm:px-4">
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="text-sm text-muted-foreground">{list.total} conversations</div>
								<div className="flex items-center gap-2">
									<Button variant="ghost" size="sm" onClick={() => void runAction('archive')} disabled={isActionLoading}>
										<Archive className="mr-2 h-4 w-4" />Archive
									</Button>
									<Button variant="ghost" size="sm" onClick={() => void runAction('delete')} disabled={isActionLoading}>
										<Trash2 className="mr-2 h-4 w-4" />Delete
									</Button>
									<Button variant="ghost" size="sm" onClick={() => void runAction('read')} disabled={isActionLoading}>Mark read</Button>
									<Button variant="ghost" size="sm" onClick={() => void runAction('unread')} disabled={isActionLoading}>Mark unread</Button>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								{CATEGORY_TABS.map((tab) => (
									<button
										key={tab.id}
										onClick={() => {
											setCategory(tab.id);
											setPage(1);
										}}
										className={cn(
											'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
											category === tab.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
										)}
									>
										{tab.label}
									</button>
								))}
							</div>
						</div>

						<div
							className={cn(
								'grid min-h-0 flex-1',
								settings.readingPane === 'right' && 'grid-cols-1 md:grid-cols-[minmax(360px,1fr)_minmax(380px,1.1fr)]',
								settings.readingPane === 'bottom' && 'grid-cols-1 grid-rows-[1fr_1fr]',
								settings.readingPane === 'none' && 'grid-cols-1'
							)}
						>
							{(settings.readingPane !== 'none' || !singlePaneOpen) && (
								<section className="min-h-0 border-r">
									<div className="h-full overflow-auto">
										{listError ? (
											<div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{listError}</div>
										) : isListLoading ? (
											<div className="p-3">
												{Array.from({ length: 8 }).map((_, index) => (
													<div key={index} className="mb-2 h-14 animate-pulse rounded-xl bg-secondary" />
												))}
											</div>
										) : list.items.length === 0 ? (
											<div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">No emails match this view.</div>
										) : (
											list.items.map((item) => {
												const selected = item.id === selectedId;
												const checked = selectedIds.includes(item.id);
												return (
													<div
														key={item.id}
														onClick={() => selectThread(item.id)}
														className={cn(
															'gmail-thread-row mx-1 my-1 flex cursor-pointer items-start gap-2 rounded-xl px-3 transition-all',
															rowDensityClass(settings.density),
															selected && 'bg-primary/15 ring-1 ring-primary/30',
															!selected && 'hover:bg-accent',
															!item.isRead && 'font-medium'
														)}
													>
														<input
															type="checkbox"
															checked={checked}
															onChange={(event) => {
																event.stopPropagation();
																setSelectedIds((prev) => (checked ? prev.filter((id) => id !== item.id) : [...prev, item.id]));
															}}
															className="mt-1 h-4 w-4 rounded border accent-primary"
														/>
														<button
															type="button"
															onClick={(event) => {
																event.stopPropagation();
																void sendJson('/api/v2/threads/actions', {
																	action: item.isStarred ? 'unstar' : 'star',
																	ids: [item.id],
																}, 'POST', csrfToken).then(() => loadList());
															}}
															className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-secondary"
														>
															<Star className={cn('h-4 w-4', item.isStarred && 'fill-yellow-400 text-yellow-400')} />
														</button>
														<div className="min-w-0 flex-1">
															<div className="flex items-center justify-between gap-2">
																<div className="truncate text-sm">{item.fromOrg || item.fromAddr || 'Unknown sender'}</div>
																<div className="shrink-0 text-xs text-muted-foreground">{formatDate(item.createdAt)}</div>
															</div>
															<div className="truncate text-sm text-muted-foreground">
																<span className="text-foreground">{item.subject || item.topic || '(No subject)'}</span>
																<span className="mx-1">-</span>
																{item.snippet || 'No preview available'}
															</div>
															<div className="mt-1 flex gap-1">
																<span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase text-muted-foreground">{item.category}</span>
																{item.hasCode ? <span className="rounded bg-primary/20 px-2 py-0.5 text-[10px] text-primary">Code</span> : null}
															</div>
														</div>
													</div>
												);
											})
										)}
									</div>
									<div className="flex items-center justify-between border-t px-3 py-2 text-sm">
										<Button variant="ghost" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isListLoading}>
											<ChevronLeft className="mr-1 h-4 w-4" />Prev
										</Button>
										<div className="text-xs text-muted-foreground">Page {page} / {totalPages}</div>
										<Button variant="ghost" size="sm" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || isListLoading}>
											Next<ChevronRight className="ml-1 h-4 w-4" />
										</Button>
									</div>
								</section>
							)}

							{showDetailPane && (
								<section className="min-h-0 overflow-auto">
									{settings.readingPane === 'none' && singlePaneOpen ? (
										<div className="border-b px-3 py-2">
											<Button variant="ghost" size="sm" onClick={() => setSinglePaneOpen(false)}>
												<ChevronLeft className="mr-2 h-4 w-4" />Back to list
											</Button>
										</div>
									) : null}

									{detailError ? (
										<div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{detailError}</div>
									) : !selectedId ? (
										<div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Select a thread to inspect details.</div>
									) : isDetailLoading ? (
										<div className="space-y-3 p-4">
											<div className="h-6 w-1/2 animate-pulse rounded bg-secondary" />
											<div className="h-4 w-3/4 animate-pulse rounded bg-secondary" />
											<div className="h-64 w-full animate-pulse rounded-xl bg-secondary" />
										</div>
									) : detail ? (
										<div className="p-4">
											<div className="mb-4 rounded-2xl border p-4">
												<div className="mb-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
													<Inbox className="h-3.5 w-3.5" />
													{detail.category}
													{detail.hasCode ? <span className="rounded bg-primary/20 px-2 py-0.5 text-primary">code extracted</span> : null}
												</div>
												<h2 className="text-xl font-semibold">{detail.subject || detail.topic || '(No subject)'}</h2>
												<div className="mt-2 text-sm text-muted-foreground">From: {detail.fromOrg || detail.fromAddr || '-'}</div>
												<div className="text-sm text-muted-foreground">To: {detail.toAddr || '-'}</div>
												<div className="text-sm text-muted-foreground">Received: {formatDateLong(detail.createdAt)}</div>
											</div>

											<div className="mb-3 flex flex-wrap gap-2">
												{([
													['extracted', 'Extracted'],
													['raw', 'Raw Email'],
													['rendered', 'Rendered'],
												] as const).map(([id, label]) => (
													<button
														key={id}
														onClick={() => setDetailTab(id)}
														className={cn(
															'rounded-full px-3 py-1.5 text-xs font-medium',
															detailTab === id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
														)}
													>
														{label}
													</button>
												))}
											</div>

											{detailTab === 'extracted' ? (
												<div className="rounded-2xl border p-4 text-sm">
													<div className="mb-2"><span className="text-muted-foreground">Topic:</span> {detail.topic || '-'}</div>
													{(() => {
														const parsed = codeAndLink(detail.code);
														return (
															<>
																<div className="mb-2 flex items-center gap-2">
																	<span className="text-muted-foreground">Code:</span>
																	{parsed.code ? (
																		<>
																			<span className="font-mono text-primary">{parsed.code}</span>
																			<Button
																				variant="outline"
																				size="sm"
																				onClick={() => {
																					navigator.clipboard.writeText(parsed.code ?? '');
																					toast.success('Code copied');
																				}}
																			>
																				<Copy className="mr-1 h-3.5 w-3.5" />Copy
																			</Button>
																		</>
																	) : (
																		'-'
																	)}
																</div>
																<div className="flex items-center gap-2">
																	<span className="text-muted-foreground">Link:</span>
																	{parsed.link ? (
																		<Button
																			variant="outline"
																			size="sm"
																			onClick={() => {
																				navigator.clipboard.writeText(parsed.link ?? '');
																				toast.success('Link copied');
																			}}
																		>
																			<Copy className="mr-1 h-3.5 w-3.5" />Copy link
																		</Button>
																	) : (
																		'-'
																	)}
																</div>
															</>
														);
													})()}
												</div>
											) : null}

											{detailTab === 'raw' ? (
												<pre className="max-h-[520px] overflow-auto rounded-2xl border bg-muted/30 p-4 font-mono text-xs leading-6">
													{detail.raw || 'No raw content.'}
												</pre>
											) : null}

											{detailTab === 'rendered' ? (
												<div>
													<div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
														<div>HTML preview is sanitized and sandboxed.</div>
														<label className="inline-flex items-center gap-2">
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
														<iframe title="mail-preview" sandbox="" srcDoc={previewHtml} className="h-[560px] w-full rounded-2xl border" />
													) : detail.textBody ? (
														<pre className="max-h-[520px] overflow-auto rounded-2xl border bg-muted/30 p-4 font-mono text-xs leading-6">
															{detail.textBody}
														</pre>
													) : (
														<div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">No renderable content found.</div>
													)}
												</div>
											) : null}
										</div>
									) : null}
								</section>
							)}
						</div>
					</div>
				</main>

				<div className="hidden w-[56px] border-l lg:block">
					<div className="flex h-full flex-col items-center gap-3 py-4">
						<button className="rounded-full p-2 text-muted-foreground hover:bg-accent" aria-label="Alerts">
							<Bell className="h-4 w-4" />
						</button>
						<button className="rounded-full p-2 text-muted-foreground hover:bg-accent" aria-label="Settings">
							<Settings className="h-4 w-4" />
						</button>
					</div>
				</div>

				{showSettingsPanel && (
					<div className="fixed inset-y-[57px] right-0 z-40 w-[320px] border-l bg-background p-4 shadow-2xl">
						<div className="mb-4 flex items-center justify-between">
							<div className="font-semibold">Quick settings</div>
							<Button variant="ghost" size="icon" onClick={() => setShowSettingsPanel(false)}>
								<X className="h-4 w-4" />
							</Button>
						</div>

						<div className="space-y-4 text-sm">
							<label className="block">
								<div className="mb-1 text-muted-foreground">Density</div>
								<select
									value={settings.density}
									onChange={(event) => void updateSettings({ density: event.target.value as DensityMode })}
									className="w-full rounded-lg border bg-background px-3 py-2"
								>
									<option value="default">Default</option>
									<option value="comfortable">Comfortable</option>
									<option value="compact">Compact</option>
								</select>
							</label>

							<label className="block">
								<div className="mb-1 text-muted-foreground">Reading pane</div>
								<select
									value={settings.readingPane}
									onChange={(event) => void updateSettings({ readingPane: event.target.value as ReadingPaneMode })}
									className="w-full rounded-lg border bg-background px-3 py-2"
								>
									<option value="none">No split</option>
									<option value="right">Right of inbox</option>
									<option value="bottom">Below inbox</option>
								</select>
							</label>

							<label className="block">
								<div className="mb-1 text-muted-foreground">Theme</div>
								<select
									value={settings.theme}
									onChange={(event) => void updateSettings({ theme: event.target.value as ThemeMode })}
									className="w-full rounded-lg border bg-background px-3 py-2"
								>
									<option value="dark">Dark</option>
									<option value="light">Light</option>
									<option value="system">System</option>
								</select>
							</label>

							<label className="flex items-center justify-between rounded-lg border px-3 py-2">
								<span>Keyboard shortcuts</span>
								<input
									type="checkbox"
									checked={settings.shortcutsEnabled}
									onChange={(event) => void updateSettings({ shortcutsEnabled: event.target.checked })}
									className="h-4 w-4 accent-primary"
								/>
							</label>
						</div>
					</div>
				)}

				{showShortcutHelp && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
						<div className="w-full max-w-xl rounded-2xl border bg-background p-4 shadow-2xl">
							<div className="mb-3 flex items-center justify-between">
								<div className="text-lg font-semibold">Keyboard shortcuts</div>
								<Button variant="ghost" size="icon" onClick={() => setShowShortcutHelp(false)}>
									<X className="h-4 w-4" />
								</Button>
							</div>
							<div className="grid gap-2 text-sm">
								<div><strong>/</strong> focus search</div>
								<div><strong>j / k</strong> next or previous thread</div>
								<div><strong>x</strong> select current thread</div>
								<div><strong>e</strong> archive</div>
								<div><strong>#</strong> delete</div>
								<div><strong>s</strong> toggle star</div>
								<div><strong>Shift + i</strong> mark read</div>
								<div><strong>Shift + u</strong> mark unread</div>
								<div><strong>g then i</strong> go inbox</div>
								<div><strong>g then s</strong> go starred</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export default App;
