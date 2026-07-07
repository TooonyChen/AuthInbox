import { useEffect, useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { ApiError, getJson, postJson, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { LoginPage } from '@/pages/LoginPage';
import { InboxPage } from '@/pages/InboxPage';
import { KeysPage } from '@/pages/KeysPage';
import { AdminPage } from '@/pages/AdminPage';
import { cn } from '@/lib/utils';

type View = 'inbox' | 'keys' | 'admin';

function App(): JSX.Element {
	const [user, setUser] = useState<User | null>(null);
	const [isChecking, setIsChecking] = useState(true);
	const [view, setView] = useState<View>('inbox');

	useEffect(() => {
		getJson<{ user: User }>('/api/auth/me')
			.then((payload) => setUser(payload.user))
			.catch((error: unknown) => {
				if (!(error instanceof ApiError && error.status === 401)) {
					toast.error('Unable to reach the server');
				}
			})
			.finally(() => setIsChecking(false));
	}, []);

	const logout = (): void => {
		postJson('/api/auth/logout')
			.catch(() => {})
			.finally(() => {
				setUser(null);
				setView('inbox');
			});
	};

	if (isChecking) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<ShieldCheck className="h-4 w-4 animate-pulse text-primary" />
					Auth Inbox
				</div>
			</div>
		);
	}

	if (!user) {
		return (
			<>
				<Toaster theme="dark" position="bottom-right" closeButton />
				<LoginPage onLogin={setUser} />
			</>
		);
	}

	const navItems: { view: View; label: string }[] = [
		{ view: 'inbox', label: 'Inbox' },
		{ view: 'keys', label: 'API Keys' },
		...(user.role === 'admin' ? [{ view: 'admin' as View, label: 'Users & Access' }] : []),
	];

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
					</div>

					<div className="flex items-center gap-3">
						<div className="text-right">
							<div className="text-sm font-medium text-slate-100">{user.username}</div>
							<div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{user.role}</div>
						</div>
						<Button variant="outline" size="icon" onClick={logout} title="Sign out">
							<LogOut className="h-4 w-4" />
						</Button>
					</div>
				</header>

				<nav className="mb-6 inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
					{navItems.map((item) => (
						<button
							key={item.view}
							type="button"
							onClick={() => setView(item.view)}
							className={cn(
								'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
								view === item.view && 'bg-background text-foreground shadow',
							)}
						>
							{item.label}
						</button>
					))}
				</nav>

				{view === 'inbox' ? <InboxPage user={user} /> : null}
				{view === 'keys' ? <KeysPage /> : null}
				{view === 'admin' && user.role === 'admin' ? <AdminPage currentUser={user} /> : null}
			</main>
		</div>
	);
}

export default App;
